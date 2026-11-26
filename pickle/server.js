import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PURPOSES,
  normalizeTask,
  createCall,
  getCall,
  listCalls,
  runSimulation,
  events,
} from "./src/calls.js";
import { hasClaude, MODEL } from "./src/agent.js";
import { phoneConfig, startPhoneCall, registerTwilioRoutes } from "./src/phone.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(here, "public")));

app.get("/api/status", (_req, res) => {
  const phone = phoneConfig();
  res.json({
    engine: hasClaude() ? "claude" : "demo",
    model: hasClaude() ? MODEL : null,
    phone: phone.ready,
    phoneMissing: phone.missing,
    purposes: PURPOSES,
  });
});

app.get("/api/calls", (_req, res) => res.json(listCalls()));

app.get("/api/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  call ? res.json(call) : res.status(404).json({ error: "통화를 찾을 수 없습니다." });
});

app.post("/api/calls", (req, res) => {
  const { task, errors } = normalizeTask(req.body?.task);
  const mode = req.body?.mode === "phone" ? "phone" : "simulation";

  if (mode === "phone") {
    const phone = phoneConfig();
    if (!phone.ready) errors.push(`실제 통화 설정이 없습니다: ${phone.missing.join(", ")}`);
    if (!task.phone) errors.push("실제 통화에는 전화번호가 필요합니다.");
    if (req.body?.consent !== true) errors.push("상대방에게 AI가 전화한다는 점을 알리는 데 동의해 주세요.");
  }
  if (errors.length) return res.status(400).json({ errors });

  const call = createCall(task, mode);
  (mode === "phone" ? startPhoneCall : runSimulation)(call);
  res.status(201).json(call);
});

// 진행 상황 실시간 전송 (Server-Sent Events)
app.get("/api/calls/:id/events", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (c) => res.write(`data: ${JSON.stringify(c)}\n\n`);
  send(call);
  events.on(call.id, send);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    events.off(call.id, send);
  });
});

registerTwilioRoutes(app);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  const phone = phoneConfig();
  console.log(`🥒 피클이 http://localhost:${port} 에서 기다리고 있어요`);
  console.log(`   AI: ${hasClaude() ? MODEL : "데모 모드 (ANTHROPIC_API_KEY 없음)"}`);
  console.log(`   실제 통화: ${phone.ready ? "사용 가능" : "꺼짐 - 필요: " + phone.missing.join(", ")}`);
});
