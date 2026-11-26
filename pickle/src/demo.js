// API 키가 없을 때 쓰는 데모 두뇌. agent.js와 같은 모양의 함수를 정해진 대본으로 흉내 낸다.
// 화면과 흐름을 확인하는 용도이며, 실제 통화에는 쓰지 않는다.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function planCall(task) {
  await pause(400);
  const who = task.callerName || "고객";
  return {
    summary: `${task.recipientName || "상대방"}에 전화해 '${task.request}' 요청을 처리합니다.`,
    opening: `안녕하세요, ${who}님을 대신해 전화드린 AI 비서 피클입니다. ${task.request} 관련해서 여쭤보려고 연락드렸어요.`,
    goals: ["AI 비서임을 밝히고 용건 전달", "가능 여부 확인", "확정 내용 복창 후 마무리"],
    confirm_items: ["날짜와 시간", "예약자 이름", "기타 안내 사항"],
    missing_info: task.callerPhone ? [] : ["의뢰인 연락처 (상대가 물어볼 수 있음)"],
  };
}

export async function agentTurn(task, plan, transcript) {
  await pause(500);
  const mine = transcript.filter((t) => t.who === "pickle").length;
  const who = task.callerName || "고객";
  const script = [
    { say: plan.opening, end_call: false, status: "in_progress" },
    {
      say: task.flexibility
        ? `그럼 그 시간으로 부탁드릴게요. ${task.flexibility.slice(0, 40)} 조건이면 괜찮습니다.`
        : "네, 그럼 말씀하신 대로 진행 부탁드립니다.",
      end_call: false,
      status: "in_progress",
    },
    {
      say: `예약자는 ${who}님이고, 연락처는 ${task.callerPhone || "나중에 따로 알려드리겠습니다"}. 확인 감사합니다.`,
      end_call: false,
      status: "in_progress",
    },
    { say: "네, 확인했습니다. 친절하게 안내해 주셔서 감사합니다. 좋은 하루 보내세요!", end_call: true, status: "success" },
  ];
  return script[Math.min(mine, script.length - 1)];
}

export async function recipientTurn(task, persona, transcript) {
  await pause(600);
  const theirs = transcript.filter((t) => t.who === "other").length;
  const script = [
    { say: `네, ${task.recipientName || "가게"}입니다. 아, AI 비서시군요. 말씀하신 시간은 꽉 찼고, 30분 뒤는 가능해요.`, hang_up: false },
    { say: "네 그럼 그렇게 잡아드릴게요. 예약자 성함이랑 연락처 알려주시겠어요?", hang_up: false },
    { say: "네, 등록됐습니다. 10분 이상 늦으시면 자동 취소되니 참고해 주세요.", hang_up: false },
    { say: "네, 감사합니다. 들어가세요.", hang_up: true },
  ];
  return script[Math.min(theirs, script.length - 1)];
}

export async function summarizeCall(task) {
  await pause(400);
  return {
    outcome: "success",
    headline: `${task.recipientName || "상대방"}: 요청하신 시간 30분 뒤로 예약 완료 (데모)`,
    details: [
      { label: "예약자", value: task.callerName || "고객" },
      { label: "변경 사항", value: "원래 시간은 마감, 30분 뒤로 확정" },
      { label: "안내", value: "10분 이상 늦으면 자동 취소" },
    ],
    next_steps: ["데모 결과입니다. ANTHROPIC_API_KEY를 설정하면 실제 AI가 대화합니다."],
  };
}
