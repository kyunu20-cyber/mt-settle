import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateOffset, syncClock, waitUntilServerTime } from '../../bot/timeSync.js';
import { StateMachine, S } from '../../bot/stateMachine.js';
import { assertAllowedTarget, MinInterval } from '../../bot/safety.js';
import { defaultDialogPolicy } from '../../bot/popupGuard.js';

// 가짜 시계
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('estimateOffset: RTT 최소 샘플 사용', () => {
  const r = estimateOffset([
    { t0: 0, t1: 100, server: 1000 },  // RTT 100
    { t0: 200, t1: 210, server: 1205 }, // RTT 10 → offset = 1205 - 205 = 1000
  ]);
  assert.equal(r.offset, 1000);
  assert.equal(r.rtt, 10);
  assert.equal(r.uncertainty, 5);
});

test('syncClock: 서버가 +5000ms 앞서 있으면 오프셋 ≈ 5000', async () => {
  const c = fakeClock(1_000_000);
  const r = await syncClock(async () => { c.advance(7); const s = c.now() + 5000; c.advance(7); return s; }, { now: c.now, sleep: c.sleep, samples: 4 });
  assert.equal(r.offset, 5000);
  assert.equal(r.rtt, 14);
});

test('waitUntilServerTime: 목표 시각 정확히 도달, 촘촘한 마지막 구간', async () => {
  const c = fakeClock(0);
  const sleeps = [];
  const late = await waitUntilServerTime(20_000, 3000, { now: c.now, sleep: async (ms) => { sleeps.push(ms); await c.sleep(ms); }, fineStepMs: 5 });
  assert.equal(c.now() + 3000 >= 20_000, true);
  assert.ok(late < 5, `오차 ${late}ms`);
  assert.ok(sleeps[0] > 1000, '멀리서는 크게 잔다');
  assert.ok(sleeps.at(-1) <= 5, '가까워지면 잘게 잔다');
});

test('StateMachine: 허용 전이만 가능 + 이력/방문 횟수 + 파일 영속화', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-')), 'state.json');
  const sm = new StateMachine({ file });
  sm.to(S.WAIT_OPEN).to(S.ENTERING).to(S.SELECT_SEATS).to(S.HOLDING).to(S.SELECT_SEATS);
  assert.equal(sm.visits[S.SELECT_SEATS], 2);
  assert.throws(() => sm.to(S.PAYING), /잘못된 상태 전이/);
  assert.throws(() => sm.to(S.DONE), /잘못된 상태 전이/, '결제 확인 없이 DONE 불가');
  sm.set({ candidate: ['A-1-1'] });
  sm.fail('test');
  assert.equal(sm.done, true);
  const saved = StateMachine.load(file);
  assert.equal(saved.state, S.FAILED);
  assert.deepEqual(saved.data.candidate, ['A-1-1']);
  assert.deepEqual(saved.history.map(h => h.state), ['INIT', 'WAIT_OPEN', 'ENTERING', 'SELECT_SEATS', 'HOLDING', 'SELECT_SEATS', 'FAILED']);
});

test('StateMachine: CHECKOUT 에서 PAYING 으로 바로 갈 수 없다(반드시 AWAIT_CONFIRM 경유)', () => {
  const sm = new StateMachine();
  sm.to(S.WAIT_OPEN).to(S.ENTERING).to(S.CHECKOUT);
  assert.equal(sm.can(S.PAYING), false);
  assert.equal(sm.can(S.AWAIT_CONFIRM), true);
});

test('safety: loopback 만 기본 허용', () => {
  assert.doesNotThrow(() => assertAllowedTarget('http://127.0.0.1:4100'));
  assert.doesNotThrow(() => assertAllowedTarget('http://localhost:3000/x'));
  assert.throws(() => assertAllowedTarget('https://tickets.example.com/'), /허용 목록에 없습니다/);
  assert.throws(() => assertAllowedTarget('file:///etc/passwd'), /프로토콜/);
  assert.doesNotThrow(() => assertAllowedTarget('https://staging.example.com', ['staging.example.com']));
});

test('MinInterval: 최소 간격 보장', async () => {
  const c = fakeClock(0);
  const mi = new MinInterval(400, { now: c.now, sleep: c.sleep });
  await mi.wait(); const t1 = c.now();
  await mi.wait(); const t2 = c.now();
  c.advance(1000);
  await mi.wait(); const t3 = c.now();
  assert.equal(t2 - t1, 400);
  assert.equal(t3 - t2, 1000, '충분히 지났으면 기다리지 않음');
});

test('dialog 정책: 진행 확인은 수락, 취소 확인은 의도할 때만, 미상은 거절', () => {
  assert.equal(defaultDialogPolicy({ type: 'alert', message: '이미 선택된 좌석입니다.' }), 'accept');
  assert.equal(defaultDialogPolicy({ type: 'confirm', message: '선택한 2매로 예매를 진행하시겠습니까?' }), 'accept');
  assert.equal(defaultDialogPolicy({ type: 'confirm', message: '예매를 취소하고 좌석을 반환하시겠습니까?' }), 'dismiss');
  assert.equal(defaultDialogPolicy({ type: 'confirm', message: '예매를 취소하고 좌석을 반환하시겠습니까?' }, { cancel: true }), 'accept');
  assert.equal(defaultDialogPolicy({ type: 'confirm', message: '회원 탈퇴하시겠어요?' }), 'dismiss');
  assert.equal(defaultDialogPolicy({ type: 'prompt', message: '?' }), 'dismiss');
});
