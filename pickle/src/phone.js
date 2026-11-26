// 실제 전화: Twilio로 발신하고, 상대 말을 음성 인식(Gather)으로 받아 한 턴씩 대답한다.
import twilio from "twilio";
import { brain, update, addTurn, finish, fail, getCall, MAX_TURNS } from "./calls.js";
import { hasClaude } from "./agent.js";

const VOICE = process.env.PICKLE_VOICE || "Polly.Seoyeon";
const LANG = "ko-KR";

export function phoneConfig() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL } = process.env;
  const missing = Object.entries({ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!hasClaude()) missing.unshift("ANTHROPIC_API_KEY");
  return { ready: missing.length === 0, missing };
}

const baseUrl = () => process.env.PUBLIC_BASE_URL.replace(/\/$/, "");

// 한국 번호(010-1234-5678, 02-123-4567)를 E.164(+8210...)로 바꾼다.
export function toE164(phone) {
  if (phone.startsWith("+")) return phone;
  if (phone.startsWith("0")) return "+82" + phone.slice(1);
  return null;
}

export async function startPhoneCall(call) {
  try {
    const to = toE164(call.task.phone);
    if (!to || to.length < 10) throw Object.assign(new Error("전화번호 형식이 올바르지 않습니다."), { code: "bad_phone" });

    const plan = await brain().planCall(call.task);
    update(call, { plan, state: "dialing" });

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const placed = await client.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `${baseUrl()}/twilio/voice?callId=${call.id}`,
      statusCallback: `${baseUrl()}/twilio/status?callId=${call.id}`,
      statusCallbackEvent: ["completed"],
      timeout: 30,
    });
    update(call, { twilioSid: placed.sid });
  } catch (err) {
    fail(call, err);
  }
}

// ---------- TwiML ----------

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

const say = (text) => `<Say voice="${VOICE}" language="${LANG}">${escapeXml(text)}</Say>`;

function sayAndListen(call, text) {
  const action = escapeXml(`${baseUrl()}/twilio/gather?callId=${call.id}`);
  return twiml(
    `<Gather input="speech" language="${LANG}" speechTimeout="auto" timeout="6" action="${action}" method="POST">${say(text)}</Gather>` +
      `<Redirect method="POST">${action}&amp;silent=1</Redirect>`
  );
}

const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const hangup = (text) => twiml((text ? say(text) : "") + "<Hangup/>");

// ---------- 웹훅 ----------

function verified(req) {
  if (!phoneConfig().ready) return false;
  if (process.env.TWILIO_SKIP_SIGNATURE === "1") return true;
  const url = baseUrl() + req.originalUrl;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    req.get("X-Twilio-Signature") || "",
    url,
    req.body || {}
  );
}

export function registerTwilioRoutes(app) {
  // 전화가 연결되면: 첫 인사를 하고 상대 말을 듣는다.
  app.post("/twilio/voice", (req, res) => {
    if (!verified(req)) return res.status(403).send("invalid signature");
    const call = getCall(req.query.callId);
    res.type("text/xml");
    if (!call?.plan) return res.send(hangup());

    update(call, { state: "calling" });
    addTurn(call, "pickle", call.plan.opening);
    res.send(sayAndListen(call, call.plan.opening));
  });

  // 상대가 말을 마치면: 들은 말을 기록하고 피클의 다음 말을 정한다.
  app.post("/twilio/gather", async (req, res) => {
    if (!verified(req)) return res.status(403).send("invalid signature");
    const call = getCall(req.query.callId);
    res.type("text/xml");
    if (!call || call.state !== "calling") return res.send(hangup());

    const heard = (req.body?.SpeechResult || "").trim();
    if (heard) {
      addTurn(call, "other", heard);
      call.silence = 0;
    } else {
      call.silence = (call.silence || 0) + 1;
      if (call.silence >= 2) {
        const bye = "응답이 없으셔서 나중에 다시 연락드리겠습니다. 감사합니다.";
        addTurn(call, "pickle", bye);
        update(call, { status: "failed" });
        finish(call);
        return res.send(hangup(bye));
      }
      addTurn(call, "other", "(응답 없음)");
    }

    try {
      const pickleTurns = call.transcript.filter((t) => t.who === "pickle").length;
      const turn = await brain().agentTurn(call.task, call.plan, call.transcript);
      addTurn(call, "pickle", turn.say);
      update(call, { status: turn.status });

      if (turn.end_call || pickleTurns >= MAX_TURNS) {
        finish(call);
        return res.send(hangup(turn.say));
      }
      res.send(sayAndListen(call, turn.say));
    } catch (err) {
      fail(call, err);
      res.send(hangup("죄송합니다. 연결에 문제가 있어 나중에 다시 연락드리겠습니다."));
    }
  });

  // 통화 종료(상대가 끊음, 부재중 등)
  app.post("/twilio/status", (req, res) => {
    if (!verified(req)) return res.status(403).send("invalid signature");
    const call = getCall(req.query.callId);
    if (call && !["summarizing", "done", "error"].includes(call.state)) {
      const status = req.body?.CallStatus;
      if (call.transcript.length === 0) {
        const reason = { busy: "통화 중", "no-answer": "받지 않음", failed: "연결 실패", canceled: "취소됨" }[status] || status;
        update(call, { state: "error", error: `전화가 연결되지 않았습니다 (${reason}).` });
      } else {
        finish(call);
      }
    }
    res.sendStatus(204);
  });
}
