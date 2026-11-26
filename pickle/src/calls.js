// 통화 요청 저장소 + 시뮬레이션 실행기.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as claudeBrain from "./agent.js";
import * as demoBrain from "./demo.js";

export const PURPOSES = {
  restaurant: "식당 예약",
  hospital: "병원·미용실 예약",
  inquiry: "문의 (영업시간, 재고, 가격 등)",
  change: "예약 변경·취소",
  service: "고객센터 (해지, 변경, 접수)",
  custom: "직접 입력",
};

export const MAX_TURNS = 14;
const DATA_FILE =
  process.env.PICKLE_DATA_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "calls.json");

export function brain() {
  return claudeBrain.hasClaude() ? claudeBrain : demoBrain;
}

const calls = new Map();
export const events = new EventEmitter();
events.setMaxListeners(100);

function load() {
  try {
    for (const call of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) {
      // 서버가 꺼질 때 진행 중이던 통화는 끝난 것으로 본다.
      if (!["done", "error"].includes(call.state)) {
        call.state = "error";
        call.error = "서버가 다시 시작되어 통화가 중단되었습니다.";
      }
      calls.set(call.id, call);
    }
  } catch {
    // 파일이 없거나 깨졌으면 빈 목록으로 시작한다.
  }
}
load();

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...calls.values()], null, 2));
  }, 200);
}

export function update(call, patch) {
  Object.assign(call, patch, { updatedAt: new Date().toISOString() });
  save();
  events.emit(call.id, call);
}

export function addTurn(call, who, text) {
  call.transcript.push({ who, text, at: new Date().toISOString() });
  update(call, {});
}

// 사용자 입력을 정리하고 검증한다. 문제가 있으면 메시지 배열을 돌려준다.
export function normalizeTask(input = {}) {
  const str = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const purpose = PURPOSES[input.purpose] ? input.purpose : "custom";
  const task = {
    recipientName: str(input.recipientName, 80),
    phone: str(input.phone, 30).replace(/[^\d+]/g, ""),
    purpose,
    purposeLabel: PURPOSES[purpose],
    request: str(input.request, 1000),
    flexibility: str(input.flexibility, 500),
    callerName: str(input.callerName, 40),
    callerPhone: str(input.callerPhone, 30),
    tone: input.tone === "brief" ? "brief" : "polite",
  };
  const errors = [];
  if (!task.recipientName) errors.push("전화 받을 곳을 입력해 주세요.");
  if (!task.request) errors.push("요청 내용을 입력해 주세요.");
  if (!task.callerName) errors.push("의뢰인 이름을 입력해 주세요. 피클이 누구를 대신하는지 밝혀야 합니다.");
  return { task, errors };
}

export function createCall(task, mode) {
  const now = new Date().toISOString();
  const call = {
    id: randomUUID(),
    mode, // "simulation" | "phone"
    engine: claudeBrain.hasClaude() ? "claude" : "demo",
    task,
    state: "planning", // planning → calling → summarizing → done | error
    plan: null,
    persona: null,
    transcript: [],
    status: "in_progress",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  calls.set(call.id, call);
  save();
  return call;
}

export const getCall = (id) => calls.get(id);
export const listCalls = () =>
  [...calls.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export async function finish(call) {
  if (call.state === "summarizing" || call.state === "done") return;
  update(call, { state: "summarizing" });
  try {
    const result = await brain().summarizeCall(call.task, call.transcript);
    update(call, { state: "done", result });
  } catch (err) {
    fail(call, err);
  }
}

export function fail(call, err) {
  console.error(`[call ${call.id}]`, err);
  update(call, { state: "error", error: err?.code ? err.message : "처리 중 오류가 발생했습니다: " + (err?.message || err) });
}

// 시뮬레이션: 피클과 가상의 직원(AI)이 번갈아 말한다.
export async function runSimulation(call) {
  const b = brain();
  try {
    const plan = await b.planCall(call.task);
    const personas = claudeBrain.PERSONAS;
    const persona = personas[Math.floor(Math.random() * personas.length)];
    update(call, { plan, persona: persona.label, state: "calling" });

    for (let i = 0; i < MAX_TURNS; i++) {
      const turn = await b.agentTurn(call.task, plan, call.transcript);
      addTurn(call, "pickle", turn.say);
      update(call, { status: turn.status });
      if (turn.end_call) break;

      const reply = await b.recipientTurn(call.task, persona, call.transcript);
      addTurn(call, "other", reply.say);
      if (reply.hang_up) break;
    }
    await finish(call);
  } catch (err) {
    fail(call, err);
  }
}
