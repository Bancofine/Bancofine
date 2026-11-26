import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.PICKLE_DATA_FILE = path.join(os.tmpdir(), `pickle-test-${process.pid}.json`);
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { normalizeTask, createCall, runSimulation, getCall } = await import("../src/calls.js");
const { toE164 } = await import("../src/phone.js");

test("normalizeTask requires recipient, request and caller name", () => {
  const { errors } = normalizeTask({});
  assert.equal(errors.length, 3);
  const ok = normalizeTask({ recipientName: "가게", request: "예약", callerName: "홍길동", phone: "02-123-4567", purpose: "nope" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.task.phone, "021234567");
  assert.equal(ok.task.purpose, "custom");
});

test("toE164 converts Korean numbers", () => {
  assert.equal(toE164("01012345678"), "+821012345678");
  assert.equal(toE164("+14155550100"), "+14155550100");
  assert.equal(toE164("12345"), null);
});

test("demo simulation runs to a result", async () => {
  const { task } = normalizeTask({ recipientName: "파스타집", request: "토요일 7시 4명", callerName: "홍길동" });
  const call = createCall(task, "simulation");
  await runSimulation(call);
  const done = getCall(call.id);
  assert.equal(done.state, "done");
  assert.ok(done.transcript.length >= 4);
  assert.equal(done.transcript[0].who, "pickle");
  assert.match(done.transcript[0].text, /AI 비서/);
  assert.equal(done.result.outcome, "success");
});

test("on_ask disclosure requires accepting responsibility", () => {
  const base = { recipientName: "가게", request: "예약", callerName: "홍길동", disclosure: "on_ask" };
  assert.equal(normalizeTask(base).errors.length, 1);
  const ok = normalizeTask({ ...base, responsibilityAccepted: true });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.task.disclosure, "on_ask");
  assert.ok(ok.task.responsibilityAcceptedAt);
  assert.equal(normalizeTask({ ...base, disclosure: "weird" }).task.disclosure, "announce");
});

test("on_ask demo does not announce first but admits being AI when asked", async () => {
  const { task } = normalizeTask({ recipientName: "파스타집", request: "토요일 7시 4명", callerName: "홍길동", disclosure: "on_ask", responsibilityAccepted: true });
  const call = createCall(task, "simulation");
  await runSimulation(call);
  const t = getCall(call.id).transcript;
  assert.doesNotMatch(t[0].text, /AI/);
  assert.match(t[1].text, /AI/);
  assert.match(t[2].text, /AI 비서/);
});
