# ticket-lab — Playwright 예매 자동화 검증 랩

로컬에서 도는 **모의 티켓 예매 사이트**와, 그 사이트를 대상으로 하는 **Playwright 자동화 봇**이다.
예매 시간 감지, 좌석 탐색, 연석 판단, 팝업 처리, 상태 관리 기술을 재현 가능한 시나리오로 테스트한다.

## 원칙 (코드로 강제됨)

| 원칙 | 구현 |
| --- | --- |
| 대상은 로컬 모의 사이트 | `bot/safety.js` — loopback 외 호스트는 실행을 거부한다. 해당 서비스가 자동화를 허용한 경우에만 `--allow-host` 로 명시. 페이지 셀렉터도 모의 사이트 전용이다. |
| CAPTCHA 우회 금지 | 보안문자 화면을 감지하면 `HUMAN_CAPTCHA` 상태로 바꾸고 사람에게 넘긴다. 문자를 읽거나 푸는 코드는 없다. headless 에 사람 개입 수단이 없으면 중단한다. |
| 대기열·접근 제한 우회 금지 | 대기열은 순번이 올 때까지 기다리기만 한다. 서버도 단계 게이트(대기열→보안문자→좌석)를 강제하므로 API 직접 호출로 건너뛸 수 없다(테스트로 확인). 새로고침은 최소 간격(`MinInterval`)을 지킨다. |
| 결제는 사용자 확인 | 상태 머신이 `CHECKOUT → AWAIT_CONFIRM → PAYING` 만 허용한다. `confirmPurchase` 훅이 정확히 `true` 를 돌려줄 때만 결제하고, 훅이 없거나 거절/시간 초과면 좌석을 반환하고 끝낸다. CLI 에서는 `yes` 를 직접 입력해야 한다. |

## 구조

```
server/   모의 예매 서버 (node:http, 의존성 없음)
  server.js   이벤트·대기열·CAPTCHA·좌석·선점(TTL)·결제 API, 경쟁 구매자 시뮬레이션, 레이트 리밋, 관리자 API(loopback 전용)
  layout.js   구역/열/좌석/통로 배치 생성 (시드 고정)
  captcha.js  왜곡 SVG 보안문자
public/   모의 사이트 화면 (공연 상세 → 새 창 예매 → 대기열 → 보안문자 → 좌석 → 결제 → 완료)
bot/
  bot.js          TicketBot: 화면(body[data-page]) 관찰 → 상태 머신 구동
  seatFinder.js   연속 구간 탐색, 연석 판정(같은 구역·열, 번호 연속, 통로 미포함), 점수화(구역 우선→앞 열→중앙)
  timeSync.js     서버 시각 오프셋 추정(RTT 최소 샘플), 오픈 시각 정밀 대기
  stateMachine.js 허용 전이 테이블, 방문 횟수(재시도 상한), JSON 파일 영속화
  popupGuard.js   네이티브 dialog 정책, 레이어 팝업 자동 닫기(addLocatorHandler), 새 창 전환
  safety.js       호스트 허용 목록, 최소 요청 간격
  cli.js          터미널 실행 (결제 확인 프롬프트)
test/unit  순수 로직 테스트 (브라우저 없음)
test/e2e   실제 서버 + Chromium 시나리오 테스트
```

## 실행

```bash
cd ticket-lab
npm install            # playwright 1.63.0 (브라우저가 없으면 npx playwright install chromium)
npm test               # 단위 17 + E2E 14 시나리오

# 데모: 5초 뒤 오픈하는 모의 서버 + 봇 (결제 확인은 터미널에서 yes 입력)
npm run demo
npm run demo -- --headed            # 브라우저 창 보기
QUEUE=1 npm run demo                # 대기열 켜기

# 서버와 봇을 따로
OPEN_IN_SEC=20 CAPTCHA=1 COMPETITOR=10 npm run server     # http://127.0.0.1:4100
npm run bot -- --url http://127.0.0.1:4100 --count 2 --sections A,B --headed
```

봇 옵션: `--count`, `--sections A,B`(선호 순서), `--max-price`, `--max-row`, `--allow-split`(연석이 없을 때 분산석 허용), `--headed`, `--state-file`.
실행 중 상태는 `state/last-run.json` 에 전이마다 기록된다.

## 상태 흐름

```
INIT → WAIT_OPEN → ENTERING → [QUEUE] → [HUMAN_CAPTCHA] → SELECT_SEATS ⇄ HOLDING → CHECKOUT → AWAIT_CONFIRM → PAYING → DONE
                                                                   (409 경합 시 재선택)              └→ CANCELLED (거절/무응답: 좌석 반환)
어느 단계든 → FAILED (시간 초과, 재시도 한도, 좌석 없음, 사람 개입 불가)
```

## E2E 시나리오

| 시나리오 | 검증 내용 |
| --- | --- |
| 기본 흐름 | 오픈 전 진입 0건, 오픈 후 1초 내 버튼 감지, 새로고침 필요 사이트 처리, 새 창 전환, 광고 레이어/confirm 처리, 전체 상태 이력 |
| 공지 모달 | 버튼을 가린 모달을 자동으로 닫음, 자동 활성 사이트에서는 새로고침 안 함 |
| 대기열 | 순번 대기 후 진행 / 서버가 미통과 세션의 좌석 API 접근 차단 |
| CAPTCHA | 사람에게 넘김(테스트에선 "사람 역할" 헬퍼가 오답 1회 후 입력) / 개입 수단 없으면 FAILED |
| 좌석 경합 | 선점 직전 탈취 → alert 처리 → 해당 좌석 제외 후 다른 연석 확보 |
| 경쟁 구매자 | 초당 40석이 팔리는 중에 3연석 확보 |
| 연석 판단 | 통로 건너편은 연석 아님, 3연석이 없으면 FAILED, `allowSplit` 이면 분산석 |
| 선호 조건 | 구역 순서·1매 가격 상한 |
| 결제 확인 | 거절 → 결제 0건·선점 해제 / 훅 없음·무응답 → 결제 0건 |
| 상태 파일 / 안전 장치 | 디스크 기록 / 외부 호스트 거부 |

## 따로 분리한 것

- **CAPTCHA 자동 해결, 대기열·접근 제한 우회**: 의도적으로 구현하지 않음. 감지 → 사람에게 넘기기/대기만 한다.
- **실제 서비스 연동 어댑터**: 포함하지 않음. 실제 서비스에 쓰려면 그 서비스의 약관/허용 범위를 먼저 확인하고, 허용된 범위 안에서 셀렉터(`popupGuard.DEFAULT_OVERLAYS`, `bot.js` 의 화면 판별)를 별도 어댑터로 작성해야 한다.
- **실제 결제**: 모의 결제만 있다.
