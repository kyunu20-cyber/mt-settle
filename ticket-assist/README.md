# Ticket Assist — 티켓 예매 보조 프로그램

Playwright 기반 **공통 예매 엔진 + 사이트별 Adapter + Next.js 대시보드 + 모의 예매 사이트**.
실제 티켓을 사지 않고 로컬 모의 사이트에서 전 과정을 검증할 수 있고, 실제 예매 사이트에서는
**허용된 범위(카운트다운·알림·제어권 전달)** 만 동작합니다.

- 스택: TypeScript · Next.js 16 (App Router) · Tailwind CSS 4 · Playwright 1.63 · Vitest
- 대상 환경: macOS + Google Chrome (Linux 에서도 동작, 개발·테스트는 Linux 컨테이너에서 수행)

---

## 1. 원칙 (코드로 강제)

| 원칙 | 구현 위치 |
| --- | --- |
| 대기열·CAPTCHA·본인인증·접근 제한 **우회 금지** | 엔진은 대기열이면 순번만 표시하며 기다리고, CAPTCHA/본인인증이면 `human-verification` 단계로 전환해 **알림 후 사용자에게 제어권을 넘깁니다**. 문자를 읽거나 입력하는 코드는 없습니다. 모의 서버도 단계 게이트를 강제해 API 직접 호출로 건너뛸 수 없습니다(테스트로 확인). |
| **최종 결제 전 사용자 확인** | 좌석 선택 전·결제 전 두 번 대시보드 확인 패널에서 승인해야 진행. 무응답(기본 3분)·거절 시 진행하지 않고 선점 좌석을 반환합니다. `automatedPayment: false` 인 Adapter(실제 사이트 전부)는 결제 버튼을 누르지 않고 사용자에게 넘깁니다. |
| **비밀번호·결제정보 평문 저장 금지** | 설정에 `password / card / cvc / pin / token / 계좌 / 비밀번호…` 류 키가 있으면 시작·저장을 거부(`findSecretKeys`). 로그인은 브라우저에서 사용자가 직접 하고, 세션은 브라우저 프로필(쿠키)에만 남습니다. |
| **허용 범위 내 이동 / 요청 제한 준수** | Adapter 가 선언한 호스트 밖으로는 이동 불가(`assertAllowedUrl`). 새로고침은 `MinInterval` 로 최소 간격·최대 횟수 제한. |
| **중복 예매·결제 방지** | 공연·회차 단위 장부(`data/ledger.json`): `completed`/`held` 면 시작 거부. 엔진 내 결제 1회 플래그. 모의 서버는 멱등 키로 같은 결제를 한 번만 처리. 결제 요청 후 결과가 불확실하면 `held` 로 남겨 재시작을 막습니다. |
| **실제 구조 확인 전 셀렉터·API 임의 작성 금지** | NOL 티켓 / YES24 티켓 / 멜론티켓 / 티켓링크 Adapter 는 셀렉터가 비어 있고 화면 조작 메서드는 `NotSupportedError` 를 던집니다. 아래 5절 참고. |

---

## 2. 개발 환경 분석 결과

| 항목 | 값 |
| --- | --- |
| 실행/테스트 환경 | Linux 컨테이너 (macOS 아님), Node 22, Google Chrome for Testing 158, Playwright Chromium |
| macOS 관련 | `osascript` 데스크톱 알림·Chrome 채널·`scripts/chrome-debug.sh` 는 macOS 를 위해 작성되었지만 **macOS 실기기에서는 검증하지 못했습니다**(테스트 환경 제약). 알림 실패는 동작에 영향 없이 무시되며 대시보드(브라우저 Notification)로도 알립니다. |
| 실제 예매 사이트 | 실제 페이지 구조를 검증하지 않았습니다 → 보조 모드만 제공 |

---

## 3. 아키텍처

```
┌──────────── Next.js (한 프로세스) ─────────────────────────────────────────┐
│  대시보드  /            ──fetch/SSE──▶  /api/engine, /api/engine/events      │
│  모의 사이트 /mock/*     ──fetch──────▶  /api/mock/*  (MockStore, 메모리)     │
│                                                                              │
│  BookingEngine (싱글톤)                                                       │
│   ├ BrowserManager   전용 프로필 실행(launchPersistentContext) | CDP 연결     │
│   ├ timing           서버 시각 동기화(RTT 최소 샘플) · 정밀 대기               │
│   ├ DialogGuard      alert/confirm/prompt 정책 · 레이어 팝업 자동 닫기         │
│   ├ guards           허용 호스트 · 요청 간격 · 민감정보 차단 · 예매 장부        │
│   ├ seats/analyze    연석 판단 · 무대거리/중앙도 점수 · 차선책 tier            │
│   ├ seats/browserScripts  DOM·SVG 추출 / Canvas 픽셀 샘플링·블롭 검출 / 하이라이트 │
│   ├ FailureLog       data/failures.jsonl + 실패 화면 스크린샷                  │
│   └ notify           macOS osascript 알림                                     │
│         │ 사이트별 동작은 SiteAdapter 인터페이스로만 호출                      │
│         ▼                                                                    │
│  adapters/  mock(full) · nol · yes24 · melon · ticketlink (assist-only)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 엔진 단계

```
preflight → connecting → session-check ─(로그아웃)→ awaiting-login ─┐
   ┌──────────────────────────────────────────────────────────────────┘
   ▼
countdown(서버시각, T-60/T-10 알림, T-15s 재보정·세션 재확인) → waiting-open(버튼 활성 감지/필요 시 새로고침)
→ entering(새 탭/팝업 전환) → [사이트 화면 루프]
     queue → 순번 표시하며 대기          captcha/identity → 사용자에게 제어권
     login → 세션 만료, 사용자 재로그인   schedule → 날짜·회차 선택
     seats → 분석·하이라이트 → ⚠좌석 확인 → 재검증 → 클릭 → 선점 (경합/네트워크 실패 시 재분석)
     payment → ⚠결제 확인 → 결제(모의만) | 사용자에게 넘김(실제 사이트)
→ done | cancelled | failed(원인 기록) | stopped | payment-handover
```

어느 지점에서든 **일시정지**(안전 지점에서 멈춤)·**종료**(결제 전이면 선점 반환)가 가능합니다.

### 좌석 분석

- **배치 구현 방식별 추출**
  - DOM: 좌석 요소의 속성 + `getBoundingClientRect`
  - SVG: `<rect>`/`<g data-section>` 구조 + 계산된 `fill` 색으로 가능/불가 판정
  - Canvas: 페이지가 받은 좌석 데이터 응답을 가로채 의미 정보(구역/열/번호/좌표)를 얻고, **실제로 그려진 픽셀 색**을 샘플링해 상태를 판정(둘 중 하나라도 불가면 불가). 픽셀만으로 좌석 블롭을 찾는 검출기로 교차 검증.
- **연석**: 같은 구역·같은 열·번호 연속 **그리고** 화면상 간격이 좌석 폭의 1.6배 이내(번호가 이어져도 통로가 있으면 연석 아님).
- **점수**(낮을수록 좋음): `w.stage × 무대까지 최단거리 + w.center × 중앙축 이격 + w.section × 구역 선호 순위` (+ 분산석 패널티). 가중치는 대시보드에서 조절.
- **차선책**: tier 1 선호 구역·등급 연석 → tier 2 같은 등급 다른 구역 → tier 3 전체 구역 → tier 4 분산석(옵션). 차선책이면 알림 + 이유 표시.

---

## 4. 설치·실행 (macOS)

```bash
cd ticket-assist
npm install                      # .npmrc 에 legacy-peer-deps 설정됨
npx playwright install chromium  # Playwright Chromium (Chrome 채널만 쓸 거면 생략 가능)
npm run build && npm start       # http://localhost:3100  (개발 모드: npm run dev)
```

브라우저에서 **http://localhost:3100** 을 열면 대시보드입니다.

### 브라우저 연결 방식 (기존 로그인 세션 유지)

1. **전용 프로필로 실행 (기본)**: `~/.ticket-assist/chrome-profile` 프로필로 Chrome(채널 `Google Chrome`) 을 띄웁니다. 처음 한 번 그 창에서 예매 사이트에 로그인하면 이후 실행에도 세션이 유지됩니다.
2. **실행 중인 내 Chrome 에 연결 (CDP)**:
   ```bash
   ./scripts/chrome-debug.sh 9222     # 원격 디버깅 포트를 연 Chrome (전용 프로필)
   ```
   대시보드 → 브라우저 → "CDP 연결" → `http://127.0.0.1:9222`. 엔진은 대상 사이트 탭이 열린 컨텍스트를 사용하며, **종료해도 사용자 Chrome 은 닫지 않습니다**.
   (최신 Chrome 은 기본 프로필에 원격 디버깅을 허용하지 않아 별도 프로필을 사용합니다.)

### 대시보드 사용 순서

1. 예매 페이지 URL 입력 → Adapter 와 지원 수준(자동화 지원 / 보조 모드) 자동 표시
2. 오픈 일시(초 단위), 공연 날짜·회차, 매수, 선호 구역(우선순위 순)·등급, 가중치, 분산석 허용, 1매 최대 가격
3. **시작** → 브라우저 연결 상태, 밀리초 카운트다운(서버 시각 기준), 현재 단계, 대기열 순번, 네트워크 오류, 실시간 로그
4. 좌석 분석 결과(미니맵·구역별 잔여·추천 5건)가 뜨고 **좌석 확인 패널**에서 후보를 골라 승인 → 결제 확인 패널에서 다시 승인
5. 로그인·CAPTCHA·본인인증이 필요하면 macOS/브라우저 알림이 오고, 예매 창이 앞으로 옵니다. 직접 입력하면 엔진이 자동으로 이어갑니다.

### 모의 사이트로 체험

대시보드 기본 URL 이 `http://localhost:3100/mock` 입니다. 좌측 하단 **모의 사이트 시나리오**에서
오픈까지 초, 좌석맵 렌더링(dom/svg/canvas), 대기열·CAPTCHA·본인인증·로그인 필요, 경쟁 구매 속도를 정하고
"초기화 + 오픈 시각 반영" → 시작. 모의 사이트는 실제 판매/결제가 없습니다.

---

## 5. 사이트별 Adapter

| Adapter | 지원 수준 | 동작 |
| --- | --- | --- |
| `mock` (/mock) | **full** | 전 과정 자동화 + 사용자 확인 + 모의 결제 |
| `nol` NOL 티켓 | assist-only | 페이지 열기(내 세션) · 서버 시각 동기화(HTTP `Date` 헤더의 초 경계 포착, 약 ±100ms) · 카운트다운 · T-60/T-10/오픈 알림 → 사용자에게 제어권. 사이트 화면은 조작하지 않음 |
| `yes24` YES24 티켓 | assist-only | 〃 |
| `melon` 멜론티켓 | assist-only | 〃 |
| `ticketlink` 티켓링크 | assist-only | 〃 |
| `mock-assist` (/mock?mode=assist) | assist-only | 위 보조 모드 경로를 실제 사이트 접속 없이 검증하기 위한 로컬 전용 Adapter (같은 팩토리) |

실제 사이트 Adapter 의 화면 조작이 비어 있는 이유:
- 실제 페이지 구조(셀렉터·API)를 확인·검증하지 않았고, 임의로 만들지 않기로 했습니다.
- 국내 예매 사이트 약관은 일반적으로 매크로 등 자동화 프로그램을 이용한 예매를 금지합니다. 운영사가 허용한 범위가 확인되지 않은 상태에서 클릭·좌석 선택 자동화를 넣지 않았습니다.

Adapter 를 확장하려면 `src/lib/adapters/types.ts` 의 `SiteAdapter` 를 구현합니다(모의 사이트 구현 `mock.ts` 가 레퍼런스).
`support.status` 를 `full` 로 올리기 전에 실제 구조 검증과 해당 서비스의 허용 여부 확인이 필요합니다.
호스트 목록은 URL 식별용이므로 사용 전 실제 도메인을 확인하세요.

---

## 6. 테스트

```bash
npm run typecheck
npm run test:unit   # Vitest 26개: 좌석 분석·연석·점수·차선책, 시각 동기화(Date 헤더 초 경계 포함), 가드, 장부, dialog 정책, 레지스트리, 설정 검증
npm run test:e2e    # Playwright 24개: next build + start 후 실제 Chromium 으로 전체 흐름
npm test            # 둘 다
```

E2E 에서 "사람" 역할(로그인·보안문자·본인인증 입력, 브라우저 종료, 탭 닫기)은 테스트가 엔진의 브라우저에 CDP 로 붙어 수행합니다.
보안문자 정답은 테스트 전용 관리자 API 로 확인하며, 엔진/Adapter 는 이 API 를 쓰지 않습니다.

| 분류 | 시나리오 |
| --- | --- |
| 정상 흐름 | 로그인 인계 → 카운트다운 → 버튼 활성 감지(오픈 전 진입 0건) → 새 탭 전환 → 공지 모달 자동 닫기 → 회차 → 하이라이트 → 2순위 좌석 승인 → 결제 승인 → 완료·장부 기록 |
| 좌석 분석 | SVG·Canvas 에서 378석 가능/불가 판정이 서버 실제 상태와 100% 일치, Canvas 픽셀-데이터 불일치 0 |
| 인계 | 대기열 순번 표시 / CAPTCHA·본인인증은 자동 입력 없이 사용자에게 넘기고 완료 후 재개 |
| 예외 | 좌석 경합(alert) 재선택, 좌석 API 503×3·선점 503 복구, 진행 중 세션 만료 → 재로그인 후 재개, 회차 없음, 조건 맞는 좌석 없음(실패 원인·스크린샷 기록) |
| 결제·중복 | 결제 거절 → 선점 반환, 무응답 → 진행 안 함, 결제 대기 중 선점 만료 → hold-expired, 완료 회차 재시작 거부, 서버 멱등 결제 |
| 제어 | 일시정지 중 오픈 시각이 지나도 진입 안 함 → 재개, 종료 시 선점 반환, 동시 시작 거부 |
| 브라우저 | 사용자가 Chrome 종료 → 즉시 실패 감지, 확인 대기 중 예매 탭 닫힘 → 즉시 실패, CDP 연결 시 기존 로그인 재사용·종료 후에도 사용자 브라우저 유지 |
| 보조 모드 | 로컬 `mock-assist` 로 실행: 예매 버튼을 누르지 않음, Date 헤더 경계 동기화 오프셋 오차 <150ms, 오픈 시각에 제어권 전달 |
| 안전 | 민감정보 필드 거부, 미지원 도메인 거부, 실제 사이트 4곳 assist-only, 대시보드 API 는 로컬+전용 헤더만 허용(CSRF 방지) |
| 대시보드 UI | 폼 입력 → 시작 → ms 카운트다운 흐름 확인 → 좌석/결제 확인 패널 클릭 → 완료 → 중복 시작 거부 메시지 |

---

## 7. 데이터 파일 (`data/`, git 제외)

| 파일 | 내용 |
| --- | --- |
| `config.json` | 대시보드 "설정 저장" (민감정보 키 거부, 권한 600) |
| `ledger.json` | 공연·회차별 예매 상태 (in-progress / held / completed / cancelled / failed) |
| `failures.jsonl` | 실패 원인 (단계·원인 코드·메시지·URL·스크린샷 경로) |
| `screenshots/` | 실패 시점 화면 |

위치는 `TICKET_ASSIST_DATA_DIR` 로 바꿀 수 있습니다. `TICKET_ASSIST_NO_OS_NOTIFY=1` 이면 OS 알림을 끕니다.

실패 원인 코드: `browser`, `browser-closed`, `popup-closed`, `network`, `login-timeout`, `open-timeout`, `queue-timeout`, `timeout`,
`unknown-page`, `site-error`, `schedule-not-found`, `seatmap-unavailable`, `no-seats`, `seat-attempts`, `purchase-limit`,
`hold-failed`, `hold-expired`, `duplicate-payment`, `config`, `not-supported`, `unexpected`.

---

## 8. 알려진 제한

- macOS 실기기 미검증(알림·Chrome 채널·스크립트). 컨테이너에서는 Linux/Chromium 으로 검증했습니다.
- 실제 예매 사이트는 보조 모드만 제공합니다(5절). 보조 모드 경로는 로컬 `mock-assist` 로만 검증했고 실제 사이트에는 접속해 보지 않았습니다.
- 엔진은 Next.js 서버 프로세스 안의 싱글톤입니다. 한 번에 하나의 예매만 실행되며, 서버를 재시작하면 진행 중 상태는 사라집니다(장부·실패 기록은 파일로 유지).
- 대시보드는 로컬 전용입니다. 외부에 노출하지 마세요.
