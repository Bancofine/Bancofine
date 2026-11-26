# 🥒 피클 (Pickle)

귀찮은 전화를 대신 걸어주는 AI 에이전트 웹 앱입니다.
용건을 적으면 피클이 통화 계획을 세우고, 상대와 대화한 뒤 결과를 정리해 줍니다.

- **연습 통화**: 피클과 AI 직원(친절함·바쁨·깐깐함 중 무작위)이 대화합니다. 전화는 실제로 걸리지 않습니다.
- **실제 통화**: Twilio로 전화를 걸고, 상대의 말을 한국어 음성 인식으로 받아 한 턴씩 대답합니다.
- **데모 모드**: API 키가 없으면 정해진 대본으로 화면 흐름만 보여 줍니다.

피클은 기본적으로 통화를 시작할 때 의뢰인을 대신한 AI 비서라고 밝힙니다. 의뢰인이 준 정보와 허용 범위 안에서만 움직이고,
카드번호처럼 받지 않은 정보는 지어내거나 말하지 않습니다.

### AI라고 먼저 밝히지 않기 (옵션)

"AI라고 밝히기 → 먼저 말하지 않기"를 고르면 피클은 "OOO님 대신 연락드렸습니다"라고만 소개합니다.

- 상대가 AI인지, 사람인지 물으면 **항상 사실대로 AI라고 답합니다.** 사람이라고 거짓말하는 기능은 없습니다.
- 이 옵션을 쓰려면 **모든 법적·금전적·도의적 책임이 사용자에게 있다**는 데 동의해야 하며, 동의 시각이 통화 기록(`responsibilityAcceptedAt`)에 남습니다.
- AI 통화 고지 의무가 있는 지역(예: 한국 AI 기본법, 미국 일부 주)에서는 이 옵션이 법에 어긋날 수 있습니다.

## 실행

```bash
cd pickle
npm install
cp .env.example .env      # 키 입력 (선택)
node --env-file=.env server.js   # 키 없이: npm start
```

http://localhost:3000 을 엽니다.

## 실제 전화 걸기 설정

1. [Twilio](https://www.twilio.com) 계정을 만들고 음성 통화가 되는 발신 번호를 삽니다. 한국으로 걸려면 Voice 지역 권한에서 South Korea를 켭니다.
2. 서버를 인터넷에서 접속할 수 있게 엽니다 (예: `ngrok http 3000`). 그 주소를 `PUBLIC_BASE_URL`에 넣습니다.
3. `.env`에 `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PUBLIC_BASE_URL`을 채우고 서버를 다시 시작합니다.
4. 화면에서 "실제로 전화 걸기"를 고르고 동의에 체크한 뒤 요청합니다.

Twilio 웹훅 요청은 서명(`X-Twilio-Signature`)을 검사합니다.

> 통화 녹음·AI 발신에 관한 법은 나라마다 다릅니다. 실제 통화 전에 해당 지역의 규정을 확인하세요.

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | Express 서버, REST API, 실시간 진행 상황(SSE) |
| `src/agent.js` | Claude 호출: 통화 계획, 턴별 대답, 시뮬레이션 상대역, 결과 요약 (구조화 출력) |
| `src/demo.js` | API 키 없을 때의 대본 |
| `src/calls.js` | 통화 저장(`data/calls.json`), 시뮬레이션 실행 |
| `src/phone.js` | Twilio 발신, TwiML 웹훅 (`/twilio/voice`, `/twilio/gather`, `/twilio/status`) |
| `public/` | 화면 (HTML/CSS/JS) |

## API

- `GET /api/status` — 엔진(claude/demo), 실제 통화 가능 여부
- `POST /api/calls` — `{ task: {...}, mode: "simulation" | "phone", consent }`
- `GET /api/calls`, `GET /api/calls/:id`, `GET /api/calls/:id/events` (SSE)

## 테스트

```bash
npm test
```
