import { test, expect } from '@playwright/test';
import {
  BASE, cleanSlate, dismissNotice, engineAction, engineState, events, human, humanAnswers, mockReset, mockState, respond, startRun, config,
  waitConfirm, waitDone, waitStatus,
} from './helpers';

test.beforeEach(async ({ request }) => { await cleanSlate(request); });

test('정상 흐름(DOM): 로그인 인계 → 카운트다운 → 오픈 감지 → 새 탭 → 회차 → 좌석 확인(2순위 선택) → 결제 확인 → 완료', async ({ request }) => {
  const m = await startRun(request, {}, { requireLogin: true, openInMs: 8000 });

  // 로그인 안 된 상태 → 엔진이 사용자에게 넘김. "사람"이 브라우저에서 직접 로그인
  await waitStatus(request, s => s.stage === 'awaiting-login', 20_000, 'awaiting-login');
  const h = await human();
  const p = await h.page(/\/mock(\?|$)/);
  await dismissNotice(p);
  await p.locator('#mock-login-link').click();
  await p.locator('#mock-login-id').fill('tester');
  await p.locator('#mock-login-pw').fill('anything');
  await p.locator('#mock-login-submit').click();

  const s1 = await waitConfirm(request, 'seats', 40_000);
  expect(s1.pendingConfirm!.options!.length).toBeGreaterThan(1);
  // 좌석 분석 중 하이라이트가 예매 창에 표시됨 (추천 좌석 = 매수)
  const bp = await h.page(/\/mock\/booking/);
  await expect(bp.locator('#__ticket_assist_overlay [data-kind="recommended"]')).toHaveCount(2);
  expect(await bp.locator('#__ticket_assist_overlay [data-kind="available"]').count()).toBe(s1.seats!.available);

  const chosen = s1.pendingConfirm!.options![1].seats.map(x => x.id);
  await respond(request, s1, true, 1);
  const s2 = await waitConfirm(request, 'payment');
  expect(s2.pendingConfirm!.order!.seatIds).toEqual(chosen);
  await respond(request, s2, true);
  const fin = await waitDone(request);

  expect(fin.result).toMatchObject({ outcome: 'done', seats: chosen });
  const st = await mockState(request);
  expect(st.orders).toHaveLength(1);
  expect(st.orders[0].seatIds).toEqual(chosen);
  expect(st.log.find((e: { ev: string }) => e.ev === 'enter').t).toBeGreaterThanOrEqual(m.openAt); // 오픈 전 진입 없음

  const ev = await events(request);
  const msgs = ev.map(e => e.message).join('\n');
  expect(msgs).toContain('로그인 확인됨');
  expect(msgs).toMatch(/신규 탭/);
  expect(msgs).toMatch(/레이어 팝업 감지: 공지 모달/);
  const lag = msgs.match(/오픈 대비 ([+-]?\d+)ms/);
  expect(lag, msgs).not.toBeNull();
  expect(Math.abs(Number(lag![1]))).toBeLessThan(1500);
  expect(fin.countdown!.source).toBe('site-time-api');

  const { ledger } = await engineState(request);
  expect(ledger[0]).toMatchObject({ status: 'completed', orderId: fin.result!.orderId });
});

for (const mode of ['svg', 'canvas'] as const) {
  test(`좌석 분석(${mode}): 예매 가능/불가 판정이 서버 실제 상태와 일치, 거절 시 결제 없음`, async ({ request }) => {
    await startRun(request, {}, { renderMode: mode, competitorPerSec: 0 });
    const s = await waitConfirm(request, 'seats');
    const truth = (await mockState(request)).seats.S3 as { id: string; status: string }[];
    const pts = new Map(s.seatPoints!.map(p => [p.id, p.s]));
    expect(pts.size).toBe(truth.length);
    for (const t of truth) expect(pts.get(t.id), t.id).toBe(t.status === 'available' ? 'a' : 'u');
    expect(s.seats!.unknown).toBe(0);
    if (mode === 'canvas') expect(s.seats!.notes.join(' ')).toMatch(/불일치 0석/);
    await respond(request, s, false);
    const fin = await waitDone(request);
    expect(fin.result!.outcome).toBe('cancelled');
    expect((await mockState(request)).orders).toHaveLength(0);
  });
}

test('대기열 표시 + CAPTCHA·본인인증은 사람에게 인계(자동 입력 안 함)', async ({ request }) => {
  await startRun(request, {}, { queue: { enabled: true, initialAhead: 40, passPerSec: 20 }, captcha: true, identity: true });
  const q = await waitStatus(request, s => s.stage === 'queue' && s.queue?.position != null, 30_000, 'queue');
  expect(q.queue!.position).toBeGreaterThan(0);

  await waitStatus(request, s => s.stage === 'human-verification', 30_000, 'captcha handover');
  // 엔진은 보안문자를 건드리지 않는다: 잠시 기다려도 화면이 그대로
  await new Promise(r => setTimeout(r, 1500));
  expect((await mockState(request)).log.some((e: { ev: string }) => e.ev === 'captcha-pass')).toBe(false);

  const h = await human();
  const bp = await h.page(/\/mock\/booking/);
  await bp.locator('#mock-captcha-img').waitFor();
  await expect.poll(async () => (await humanAnswers(request)).some(a => a.captcha)).toBe(true);
  const cap = (await humanAnswers(request)).find(a => a.captcha)!.captcha!;
  await bp.locator('#mock-captcha-input').fill(cap);
  await bp.locator('#mock-captcha-submit').click();

  // 사람은 엔진의 "본인인증 입력 필요" 알림을 보고 행동한다
  await expect.poll(async () => (await events(request)).some(e => /본인인증 감지 → 사용자에게 제어권 전달/.test(e.message)), { timeout: 15_000 }).toBe(true);
  await bp.locator('#mock-identity-request').click();
  await expect.poll(async () => (await humanAnswers(request)).some(a => a.identity)).toBe(true);
  await bp.locator('#mock-identity-code').fill((await humanAnswers(request)).find(a => a.identity)!.identity!);
  await bp.locator('#mock-identity-submit').click();

  const s = await waitConfirm(request, 'seats');
  await respond(request, s, true);
  await respond(request, await waitConfirm(request, 'payment'), true);
  expect((await waitDone(request)).result!.outcome).toBe('done');
  const msgs = (await events(request)).map(e => e.message).join('\n');
  expect(msgs).toMatch(/보안문자\(CAPTCHA\) 감지 → 사용자에게 제어권 전달/);
  expect(msgs).toMatch(/본인인증 완료 확인/);
  expect(msgs).toMatch(/대기열 통과/);
});

test('좌석 경합: 선점 직전 매진(alert) → 해당 좌석 제외 후 재분석·재확인 → 완료', async ({ request }) => {
  await startRun(request, {}, { stealFirstHold: true });
  const s1 = await waitConfirm(request, 'seats');
  const first = s1.pendingConfirm!.options![0].seats.map(x => x.id);
  await respond(request, s1, true);
  const s2 = await waitConfirm(request, 'seats');
  const second = s2.pendingConfirm!.options![0].seats.map(x => x.id);
  expect(second.some(id => first.includes(id))).toBe(false);
  await respond(request, s2, true);
  await respond(request, await waitConfirm(request, 'payment'), true);
  const fin = await waitDone(request);
  expect(fin.result!.outcome).toBe('done');
  const msgs = (await events(request)).map(e => e.message).join('\n');
  expect(msgs).toMatch(/팝업\[alert\] "이미 다른 고객님께서 선택한 좌석입니다\."/);
  expect(msgs).toMatch(/좌석 경합 실패/);
});

test('네트워크 오류(좌석 API 503 ×3, 선점 503 ×1) 감지 후 복구', async ({ request }) => {
  await startRun(request, {}, { faults: { seats5xx: 3, hold5xx: 1 } });
  const s = await waitConfirm(request, 'seats', 40_000);
  expect(s.network.serverErrors).toBeGreaterThanOrEqual(3);
  await respond(request, s, true);
  // 선점 503 → alert → network 로 분류 후 재시도 → 다시 좌석 확인
  const s2 = await waitConfirm(request, 'seats', 40_000);
  await respond(request, s2, true);
  await respond(request, await waitConfirm(request, 'payment'), true);
  expect((await waitDone(request)).result!.outcome).toBe('done');
  const msgs = (await events(request)).map(e => e.message).join('\n');
  expect(msgs).toMatch(/서버 응답 503/);
});

test('세션 만료(진행 중) 감지 → 사용자 재로그인 → 이어서 진행', async ({ request }) => {
  await startRun(request, {}, { requireLogin: true });
  await waitStatus(request, s => s.stage === 'awaiting-login', 20_000, 'login');
  const h = await human();
  const p = await h.page(/\/mock(\?|$)/);
  await p.goto(BASE + '/mock/login?next=/mock');
  await p.locator('#mock-login-id').fill('tester');
  await p.locator('#mock-login-submit').click();

  const s1 = await waitConfirm(request, 'seats', 40_000);
  await request.post('/api/mock/admin/expire-sessions'); // 확인 대기 중 세션 만료
  await respond(request, s1, true);
  await waitStatus(request, s => s.stage === 'awaiting-login', 20_000, 'session expired handover');

  const bp = await h.page(/\/mock\/booking/);
  await bp.locator('#mock-login-link').click();
  await bp.locator('#mock-login-id').fill('tester');
  await bp.locator('#mock-login-submit').click();

  const s2 = await waitConfirm(request, 'seats', 40_000);
  await respond(request, s2, true);
  await respond(request, await waitConfirm(request, 'payment'), true);
  expect((await waitDone(request)).result!.outcome).toBe('done');
  expect((await events(request)).map(e => e.message).join('\n')).toMatch(/세션 만료\/로그인 필요/);
});

test('결제 거절 → 결제 없음·선점 반환, 장부 cancelled → 재시작 가능', async ({ request }) => {
  await startRun(request);
  await respond(request, await waitConfirm(request, 'seats'), true);
  const pay = await waitConfirm(request, 'payment');
  await respond(request, pay, false);
  const fin = await waitDone(request);
  expect(fin.result!.outcome).toBe('cancelled');
  const st = await mockState(request);
  expect(st.orders).toHaveLength(0);
  expect(st.holds).toHaveLength(0);
  expect((await engineState(request)).ledger[0].status).toBe('cancelled');
  const again = await engineAction(request, { action: 'start', config: config(Date.now() + 2000) });
  expect(again.body.ok).toBe(true);
  await engineAction(request, { action: 'stop' });
});

test('중복 예매 방지: 완료된 회차는 재시작 거부 / 서버 결제는 멱등', async ({ request }) => {
  await startRun(request);
  await respond(request, await waitConfirm(request, 'seats'), true);
  await respond(request, await waitConfirm(request, 'payment'), true);
  expect((await waitDone(request)).result!.outcome).toBe('done');
  const again = await engineAction(request, { action: 'start', config: config(Date.now() + 2000) });
  expect(again.status).toBe(400);
  expect(again.body.error).toMatch(/중복 예매 방지/);
});

test('차선책 추천: 선호 구역에 연석이 없으면 같은 등급 다른 구역 제시', async ({ request }) => {
  // A(VIP) 는 띄엄띄엄, C(R) 에만 연석
  await startRun(request, { sections: ['A', 'B'], grades: ['VIP', 'R'] }, { onlyAvailable: ['A-1-1', 'A-1-3', 'A-1-5', 'C-4-3', 'C-4-4', 'D-1-1', 'D-1-2'] });
  const s = await waitConfirm(request, 'seats');
  expect(s.seats!.usedFallback).toBe(true);
  expect(s.pendingConfirm!.options![0].seats.map(x => x.id)).toEqual(['C-4-3', 'C-4-4']);
  expect(s.pendingConfirm!.options![0].tier).toBe(2);
  expect(s.pendingConfirm!.options![0].reason).toMatch(/차선책/);
  await respond(request, s, false);
  await waitDone(request);
});

test('조건 맞는 좌석이 없으면 재탐색 후 실패 원인 기록', async ({ request }) => {
  test.setTimeout(60_000);
  await startRun(request, { quantity: 3 }, { onlyAvailable: ['A-1-1', 'A-1-2', 'A-1-8', 'A-1-9'] }); // 8|9 사이는 통로
  const fin = await waitDone(request, 45_000);
  expect(fin.result!.outcome).toBe('failed');
  expect(fin.result!.reason).toMatch(/no-seats/);
  const { failures } = await engineState(request);
  expect(failures[0]).toMatchObject({ reason: 'no-seats' });
});

test('없는 회차 설정 → 실패 원인(schedule-not-found)', async ({ request }) => {
  await startRun(request, { performanceTime: '21:00' });
  const fin = await waitDone(request);
  expect(fin.result!.reason).toMatch(/schedule-not-found.*가능: 14:00, 19:00/);
});

test('일시정지/재개/종료', async ({ request }) => {
  await startRun(request, {}, { openInMs: 6000 });
  await waitStatus(request, s => s.stage === 'countdown', 15_000, 'countdown');
  expect((await engineAction(request, { action: 'pause' })).body.ok).toBe(true);
  await new Promise(r => setTimeout(r, 7000)); // 오픈 시각이 지나도 멈춰 있어야 함
  const paused = (await engineState(request)).status;
  expect(paused.paused).toBe(true);
  expect(paused.stage).toBe('countdown');
  expect((await mockState(request)).log.some((e: { ev: string }) => e.ev === 'enter')).toBe(false);
  await engineAction(request, { action: 'resume' });
  await waitConfirm(request, 'seats');
  expect((await engineAction(request, { action: 'stop' })).body.ok).toBe(true);
  const fin = await waitDone(request);
  expect(fin.result!.outcome).toBe('stopped');
  expect((await engineState(request)).ledger[0].status).toBe('cancelled');
});

test('입력 검증·안전장치: 민감정보 거부 / 미지원 사이트 / 실제 사이트는 보조 모드 / API 보호', async ({ request }) => {
  const base = config(Date.now() + 5000);
  let r = await engineAction(request, { action: 'start', config: { ...base, password: 'x' } });
  expect(r.body.error).toMatch(/평문 저장 금지/);
  r = await engineAction(request, { action: 'start', config: { ...base, url: 'https://example.com/ticket' } });
  expect(r.body.error).toMatch(/지원하지 않는 사이트/);
  r = await engineAction(request, { action: 'start', config: { ...base, quantity: 0 } });
  expect(r.body.error).toMatch(/매수/);
  const { adapters } = await engineState(request);
  expect(adapters.filter(a => ['nol', 'yes24', 'melon', 'ticketlink'].includes(a.id)).map(a => a.support.status)).toEqual(['assist-only', 'assist-only', 'assist-only', 'assist-only']);
  const noHeader = await request.post('/api/engine', { data: { action: 'stop' } });
  expect(noHeader.status()).toBe(403);
  const cfgSave = await request.put('/api/config', { data: { url: 'x', cardNumber: '1234' }, headers: { 'x-ticket-assist': '1' } });
  expect(cfgSave.status()).toBe(400);
});

test('모의 서버: 같은 멱등 키로 결제 2번 → 주문 1건', async ({ request, page }) => {
  await mockReset(request, { openInMs: 0 });
  await page.goto('/mock/booking');
  await page.locator('.mock-date[data-date="2026-12-19"]').click();
  await page.locator('.mock-time').first().click();
  await page.locator('#mock-schedule-next').click();
  const seat = page.locator('.mock-seat.is-available').first();
  await seat.click();
  page.on('dialog', d => d.accept());
  await page.locator('#mock-seat-next').click();
  const holdId = await page.locator('#mock-pay-summary').getAttribute('data-hold-id');
  const pay = () => page.evaluate(async (h) => (await fetch('/api/mock/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdId: h, idempotencyKey: `pay-${h}`, agree: true }) })).json(), holdId);
  const [a, b] = await Promise.all([pay(), pay()]);
  expect(a.orderId).toBe(b.orderId);
  expect((await mockState(request)).orders).toHaveLength(1);
});
