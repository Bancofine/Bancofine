// 피클의 두뇌: Claude로 통화 계획을 세우고, 한 턴씩 말할 내용을 정하고, 통화 결과를 정리한다.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const MODEL = process.env.PICKLE_MODEL || "claude-opus-5-5";

export function hasClaude() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 구조화 출력 한 번 요청 → JSON 스키마로 받고 zod로 검증한다.
async function ask({ system, prompt, schema, validator, effort = "low", maxTokens = 4000 }) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new AgentError("refusal", "AI가 이 요청을 처리하지 않기로 했습니다. 요청 내용을 바꿔 다시 시도해 주세요.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AgentError("truncated", "AI 응답이 너무 길어 잘렸습니다.");
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  try {
    return validator.parse(JSON.parse(text));
  } catch {
    throw new AgentError("bad_output", "AI 응답 형식이 올바르지 않습니다.");
  }
}

// ---------- 공통 규칙 ----------

const CALLER_RULES = `
너는 "피클"이라는 AI 전화 비서다. 사용자(의뢰인)를 대신해 가게·병원·회사 등에 전화를 건다.

반드시 지킬 것:
- 첫 마디에서 "OOO님을 대신해 전화드린 AI 비서 피클"이라고 밝힌다. 사람인 척하지 않는다.
- 의뢰인이 준 정보만 사용한다. 모르는 정보(주민번호, 카드번호, 비밀번호 등)를 지어내거나 요구받아도 말하지 않는다.
  그런 정보가 꼭 필요하면 "의뢰인께 확인 후 다시 연락드리겠다"고 하고 통화를 정리한다.
- 의뢰인이 허용한 범위(시간대, 예산, 대안) 밖의 결정은 하지 않는다. 결제·계약·해지 확정처럼 되돌리기 어려운 일은
  의뢰인이 명시적으로 허락한 경우에만 진행한다.
- 전화 통화이므로 한 번에 한두 문장, 자연스러운 존댓말 구어체로 말한다. 목록·기호·이모지를 쓰지 않는다.
- 상대가 확정해 준 내용(날짜, 시간, 이름, 금액, 예약번호 등)은 끝내기 전에 한 번 복창해 확인한다.
- 목적을 이뤘거나, 더 진행할 수 없거나, 상대가 거절하면 정중히 인사하고 통화를 끝낸다.
`.trim();

function describeTask(task) {
  const lines = [
    `의뢰인 이름: ${task.callerName || "(미입력)"}`,
    `의뢰인 연락처(필요할 때만 알려줌): ${task.callerPhone || "(미입력)"}`,
    `전화 받을 곳: ${task.recipientName || "(미입력)"}`,
    `통화 목적: ${task.purposeLabel}`,
    `요청 내용: ${task.request}`,
    `허용 범위/대안: ${task.flexibility || "(없음 - 요청 그대로만 진행)"}`,
    `말투: ${task.tone === "brief" ? "간결하고 용건 위주" : "공손하고 친절하게"}`,
  ];
  return lines.join("\n");
}

function renderTranscript(transcript) {
  if (transcript.length === 0) return "(아직 대화 없음)";
  return transcript
    .map((turn) => `${turn.who === "pickle" ? "피클" : "상대방"}: ${turn.text}`)
    .join("\n");
}

// ---------- 1. 통화 계획 ----------

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "opening", "goals", "confirm_items", "missing_info"],
  properties: {
    summary: { type: "string", description: "이 통화로 무엇을 하려는지 한 문장" },
    opening: { type: "string", description: "전화가 연결되면 피클이 할 첫 마디 (AI 비서임을 밝힐 것)" },
    goals: { type: "array", items: { type: "string" }, description: "통화에서 달성할 일, 순서대로" },
    confirm_items: { type: "array", items: { type: "string" }, description: "끝내기 전에 확인·복창할 항목" },
    missing_info: {
      type: "array",
      items: { type: "string" },
      description: "통화 전에 의뢰인에게 더 받아두면 좋을 정보. 없으면 빈 배열",
    },
  },
};
const planValidator = z.object({
  summary: z.string(),
  opening: z.string(),
  goals: z.array(z.string()),
  confirm_items: z.array(z.string()),
  missing_info: z.array(z.string()),
});

export async function planCall(task) {
  return ask({
    system: CALLER_RULES,
    prompt: `다음 의뢰로 전화를 걸기 전에 통화 계획을 세워라.\n\n${describeTask(task)}`,
    schema: planSchema,
    validator: planValidator,
    effort: "medium",
  });
}

// ---------- 2. 통화 중 한 턴 ----------

export const TURN_STATUSES = ["in_progress", "success", "partial", "failed", "needs_user"];

const turnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["say", "end_call", "status"],
  properties: {
    say: { type: "string", description: "피클이 지금 상대에게 할 말 (한두 문장, 구어체)" },
    end_call: { type: "boolean", description: "이 말을 끝으로 전화를 끊으면 true" },
    status: {
      type: "string",
      enum: TURN_STATUSES,
      description:
        "현재 진행 상태. success=목적 달성, partial=일부만 달성, failed=불가, needs_user=의뢰인 확인 필요, in_progress=진행 중",
    },
  },
};
const turnValidator = z.object({
  say: z.string().min(1),
  end_call: z.boolean(),
  status: z.enum(TURN_STATUSES),
});

export async function agentTurn(task, plan, transcript) {
  return ask({
    system: CALLER_RULES,
    prompt: [
      "## 의뢰",
      describeTask(task),
      "## 통화 계획",
      `목표: ${plan.goals.join(" / ")}`,
      `확인할 항목: ${plan.confirm_items.join(" / ")}`,
      "## 지금까지의 통화",
      renderTranscript(transcript),
      "",
      "피클이 이어서 할 말을 정하라. 상대가 말이 없었거나 알아듣기 어려우면 짧게 다시 여쭤본다.",
    ].join("\n"),
    schema: turnSchema,
    validator: turnValidator,
    effort: "low",
    maxTokens: 2000,
  });
}

// ---------- 3. 시뮬레이션용 상대방 ----------

export const PERSONAS = [
  { key: "friendly", label: "친절한 직원", hint: "친절하고 협조적이다. 요청이 대부분 가능하다." },
  { key: "busy", label: "바쁜 직원", hint: "바쁘고 말이 짧다. 요청한 시간은 안 되고 다른 시간을 하나 제안한다." },
  { key: "strict", label: "깐깐한 직원", hint: "본인 확인 정보를 하나 더 물어보고, 규정을 들어 일부만 들어준다." },
];

const recipientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["say", "hang_up"],
  properties: {
    say: { type: "string", description: "상대방이 할 말 (한두 문장)" },
    hang_up: { type: "boolean", description: "이 말을 끝으로 상대방이 전화를 끊으면 true" },
  },
};
const recipientValidator = z.object({ say: z.string().min(1), hang_up: z.boolean() });

export async function recipientTurn(task, persona, transcript) {
  return ask({
    system: `너는 "${task.recipientName || "가게"}"에서 전화를 받은 직원 역할을 연기한다. 연습용 시뮬레이션이다.
성격: ${persona.hint}
실제 직원처럼 짧은 구어체 존댓말로 대답한다. 가게 정보(영업시간, 빈자리, 가격 등)는 그럴듯하게 지어내도 된다.
피클이 인사하고 통화를 마무리하면 hang_up을 true로 한다.`,
    prompt: `## 지금까지의 통화\n${renderTranscript(transcript)}\n\n직원으로서 이어서 대답하라.`,
    schema: recipientSchema,
    validator: recipientValidator,
    effort: "low",
    maxTokens: 1500,
  });
}

// ---------- 4. 통화 결과 정리 ----------

export const OUTCOMES = ["success", "partial", "failed", "needs_user"];

const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "headline", "details", "next_steps"],
  properties: {
    outcome: { type: "string", enum: OUTCOMES },
    headline: { type: "string", description: "의뢰인에게 보여줄 결과 한 줄 (예: '토요일 저녁 7시, 4명 예약 완료')" },
    details: {
      type: "array",
      description: "확정되거나 알게 된 정보",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: { label: { type: "string" }, value: { type: "string" } },
      },
    },
    next_steps: { type: "array", items: { type: "string" }, description: "의뢰인이 할 일. 없으면 빈 배열" },
  },
};
const summaryValidator = z.object({
  outcome: z.enum(OUTCOMES),
  headline: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  next_steps: z.array(z.string()),
});

export async function summarizeCall(task, transcript) {
  return ask({
    system: "너는 통화 기록을 읽고 의뢰인에게 결과를 보고하는 비서다. 통화에서 실제로 확인된 사실만 적는다.",
    prompt: `## 의뢰\n${describeTask(task)}\n\n## 통화 기록\n${renderTranscript(transcript)}\n\n결과를 정리하라.`,
    schema: summarySchema,
    validator: summaryValidator,
    effort: "medium",
  });
}
