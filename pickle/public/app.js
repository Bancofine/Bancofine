const $ = (sel) => document.querySelector(sel);
const form = $("#call-form");
const STATE_LABEL = {
  planning: "통화 준비 중",
  dialing: "전화 거는 중",
  calling: "통화 중",
  summarizing: "결과 정리 중",
  done: "완료",
  error: "실패",
};
const OUTCOME_LABEL = { success: "성공", partial: "일부 성공", failed: "실패", needs_user: "확인 필요" };

let status = null;
let source = null;

const fill = (node, ...children) => node.replaceChildren(...children.filter((c) => c != null));

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

async function loadStatus() {
  status = await fetch("/api/status").then((r) => r.json());
  $("#engine").innerHTML = "";
  $("#engine").append(
    status.engine === "claude"
      ? el("span", {}, "AI ", el("b", { textContent: status.model }))
      : el("span", {}, el("b", { textContent: "데모 모드" }), " · API 키를 넣으면 진짜 AI가 대화해요")
  );

  const chips = $("#purposes");
  Object.entries(status.purposes).forEach(([key, label], i) => {
    chips.append(
      el("label", {}, el("input", { type: "radio", name: "purpose", value: key, checked: i === 0 }), el("span", { textContent: label }))
    );
  });
}

function updateModeUI() {
  const phone = form.mode.value === "phone";
  $("#consent-row").hidden = !phone;
  const note = $("#phone-note");
  note.hidden = !phone || status?.phone;
  if (phone && !status?.phone) {
    note.textContent = `실제 통화를 하려면 서버 설정이 필요해요: ${status.phoneMissing.join(", ")} (README 참고)`;
  }
}
function updateDisclosureUI() {
  $("#disclosure-warning").hidden = form.disclosure.value !== "on_ask";
}
form.addEventListener("change", (e) => {
  if (e.target.name === "mode") updateModeUI();
  if (e.target.name === "disclosure") updateDisclosureUI();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const task = Object.fromEntries(
    ["recipientName", "phone", "purpose", "request", "flexibility", "callerName", "callerPhone", "tone", "disclosure"].map((k) => [k, data.get(k) || ""])
  );
  task.responsibilityAccepted = data.get("responsibilityAccepted") === "on";
  const body = { task, mode: data.get("mode"), consent: data.get("consent") === "on" };

  const errorsBox = $("#form-errors");
  errorsBox.hidden = true;
  $("#submit").disabled = true;
  try {
    const res = await fetch("/api/calls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) {
      errorsBox.replaceChildren(el("ul", {}, ...json.errors.map((m) => el("li", { textContent: m }))));
      errorsBox.hidden = false;
      return;
    }
    watch(json.id);
    loadHistory();
  } catch {
    errorsBox.textContent = "서버에 연결하지 못했어요.";
    errorsBox.hidden = false;
  } finally {
    $("#submit").disabled = false;
  }
});

function watch(id) {
  source?.close();
  source = new EventSource(`/api/calls/${id}/events`);
  source.onmessage = (e) => {
    const call = JSON.parse(e.data);
    render(call);
    if (call.state === "done" || call.state === "error") {
      source.close();
      loadHistory();
    }
  };
}

function render(call) {
  $("#empty").hidden = true;
  const state = $("#state");
  state.textContent = STATE_LABEL[call.state] || call.state;
  state.className = "state " + (call.state === "done" ? "done" : call.state === "error" ? "error" : "active");
  $("#live-title").textContent = `${call.task.recipientName} · ${call.mode === "phone" ? "실제 통화" : "연습 통화"}`;

  const plan = $("#plan");
  if (call.plan) {
    plan.hidden = false;
    fill(plan,
      el("b", { textContent: "📝 " + call.plan.summary }),
      el("ul", {}, ...call.plan.goals.map((g) => el("li", { textContent: g }))),
      call.persona ? el("div", { textContent: `상대 역할: ${call.persona}` }) : null,
      call.task.disclosure === "on_ask"
        ? el("span", { className: "tag", textContent: "AI 먼저 밝히지 않음 · 물으면 답함 · 책임: 사용자" })
        : null,
      call.plan.missing_info.length
        ? el("div", { className: "warn", textContent: "미리 알려주면 좋은 정보: " + call.plan.missing_info.join(", ") })
        : null
    );
  } else {
    plan.hidden = true;
  }

  const list = $("#transcript");
  list.replaceChildren(
    ...call.transcript.map((t) =>
      el("li", { className: `bubble ${t.who}` }, el("small", { textContent: t.who === "pickle" ? "🥒 피클" : call.task.recipientName }), t.text)
    )
  );
  if (["planning", "dialing", "calling"].includes(call.state)) {
    list.append(el("li", { className: "typing", textContent: call.state === "calling" ? "…" : STATE_LABEL[call.state] + "…" }));
  }

  const result = $("#result");
  if (call.state === "done" && call.result) {
    const r = call.result;
    result.hidden = false;
    fill(result,
      el("h3", {}, el("span", { className: `badge ${r.outcome}`, textContent: OUTCOME_LABEL[r.outcome] }), r.headline),
      r.details.length
        ? el("dl", {}, ...r.details.flatMap((d) => [el("dt", { textContent: d.label }), el("dd", { textContent: d.value })]))
        : null,
      r.next_steps.length ? el("ul", {}, ...r.next_steps.map((s) => el("li", { textContent: s }))) : null
    );
  } else if (call.state === "error") {
    result.hidden = false;
    result.replaceChildren(el("p", { className: "err", textContent: call.error }));
  } else {
    result.hidden = true;
  }
}

async function loadHistory() {
  const calls = await fetch("/api/calls").then((r) => r.json());
  const list = $("#history");
  if (!calls.length) {
    list.replaceChildren(el("li", { className: "history-empty", textContent: "아직 통화 기록이 없어요." }));
    return;
  }
  list.replaceChildren(
    ...calls.slice(0, 20).map((c) => {
      const label = c.state === "done" ? OUTCOME_LABEL[c.result?.outcome] : STATE_LABEL[c.state];
      const btn = el(
        "button",
        { type: "button" },
        el("span", { className: "title", textContent: `${c.task.recipientName} — ${c.result?.headline || c.task.request}` }),
        el("span", { className: "meta", textContent: `${label} · ${new Date(c.createdAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}` })
      );
      btn.addEventListener("click", () => {
        const done = c.state === "done" || c.state === "error";
        done ? fetch(`/api/calls/${c.id}`).then((r) => r.json()).then(render) : watch(c.id);
      });
      return el("li", {}, btn);
    })
  );
}

await loadStatus();
updateModeUI();
updateDisclosureUI();
loadHistory();
