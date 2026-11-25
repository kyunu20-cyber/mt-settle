import { test, expect } from '@playwright/test';
import { cleanSlate, config, engineAction, engineState, events, human, mockState, respond, startRun, waitConfirm, waitDone, waitStatus } from './helpers';

test.beforeEach(async ({ request }) => { await cleanSlate(request); });

test('사용자 확인 무응답 → 진행하지 않고 취소', async ({ request }) => {
  await startRun(request, { timeouts: { confirmMs: 1500 } });
  await waitConfirm(request, 'seats');
  const fin = await waitDone(request);
  expect(fin.result).toMatchObject({ outcome: 'cancelled', reason: '좌석 확인 응답 시간 초과' });
  expect((await mockState(request)).holds).toHaveLength(0);
});

test('결제 확인 대기 중 선점 만료 → hold-expired 실패, 장부는 재시작 가능 상태', async ({ request }) => {
  await startRun(request, {}, { holdTtlMs: 2500 });
  await respond(request, await waitConfirm(request, 'seats'), true);
  const pay = await waitConfirm(request, 'payment');
  await new Promise(r => setTimeout(r, 3000));
  await respond(request, pay, true);
  const fin = await waitDone(request);
  expect(fin.result!.outcome).toBe('failed');
  expect(fin.result!.reason).toMatch(/hold-expired/);
  expect((await mockState(request)).orders).toHaveLength(0);
  const { ledger, failures } = await engineState(request);
  expect(ledger[0].status).toBe('failed');
  expect(failures[0].reason).toBe('hold-expired');
});

test('사용자가 브라우저를 닫음(카운트다운 중) → 연결 끊김 감지·실패 기록', async ({ request }) => {
  await startRun(request, {}, { openInMs: 6000 });
  await waitStatus(request, s => s.stage === 'countdown', 15_000, 'countdown');
  const h = await human();
  // 사용자가 Chrome 을 종료하는 상황 (browser.close() 는 CDP 연결만 끊으므로 CDP 명령으로 실제 종료)
  const cdp = await h.browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  const fin = await waitDone(request, 30_000);
  expect(fin.result!.outcome).toBe('failed');
  expect(fin.result!.reason).toMatch(/browser-closed|popup-closed|browser/);
  expect((await engineState(request)).status.browser.connected).toBe(false);
});

test('확인 대기 중 예매 창(팝업 탭)을 닫음 → 즉시 popup-closed', async ({ request }) => {
  await startRun(request);
  await waitConfirm(request, 'seats');
  const h = await human();
  await (await h.page(/\/mock\/booking/)).close();
  const fin = await waitDone(request, 10_000);
  expect(fin.result!.reason).toMatch(/popup-closed/);
});

test('동시 시작 거부', async ({ request }) => {
  await startRun(request, {}, { openInMs: 5000 });
  const r = await engineAction(request, { action: 'start', config: config(Date.now() + 5000, { performanceTime: '14:00' }) });
  expect(r.body.error).toMatch(/이미 실행 중/);
  await engineAction(request, { action: 'stop' });
  expect((await waitDone(request)).result!.outcome).toBe('stopped');
});

test('결제 단계에서 종료 → 선점 좌석 자동 반환', async ({ request }) => {
  await startRun(request);
  await respond(request, await waitConfirm(request, 'seats'), true);
  await waitConfirm(request, 'payment');
  expect((await mockState(request)).holds).toHaveLength(1);
  await engineAction(request, { action: 'stop' });
  expect((await waitDone(request)).result!.outcome).toBe('stopped');
  expect((await mockState(request)).holds).toHaveLength(0);
});

test('보조 모드(assist-only) 경로: 페이지 열기·HTTP Date 시각 동기화·카운트다운 후 제어권 전달, 화면 조작 없음', async ({ request }) => {
  const m = await (await request.post('/api/mock/admin/reset', { data: { openInMs: 3000, requireLogin: false } })).json();
  const r = await engineAction(request, { action: 'start', config: config(m.openAt, { url: 'http://127.0.0.1:3210/mock?mode=assist' }) });
  expect(r.body.ok).toBe(true);
  const fin = await waitDone(request, 20_000);
  expect(fin.result).toMatchObject({ outcome: 'payment-handover' });
  expect(fin.countdown!.source).toBe('http-date-boundary');
  const st = await mockState(request);
  expect(st.log.some((e: { ev: string }) => e.ev === 'enter')).toBe(false); // 예매 버튼을 누르지 않음
  // 초 단위 Date 헤더 경계 포착 방식의 오차 예산(±150ms) 안에서 오픈 시각 이후에 넘겨야 함
  const handover = (await events(request)).find(e => e.type === 'result');
  expect(handover).toBeTruthy();
  expect(fin.result!.finishedAt).toBeGreaterThanOrEqual(m.openAt - 150);
  expect(Math.abs(fin.countdown!.offsetMs)).toBeLessThan(150); // 같은 기계이므로 실제 오프셋 ≈ 0
  const { ledger } = await engineState(request);
  expect(ledger[0].status).toBe('in-progress'); // 사용자가 직접 진행 중인 것으로 남김
});
