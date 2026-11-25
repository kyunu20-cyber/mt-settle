import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLab } from '../../server/server.js';
import { TicketBot } from '../../bot/bot.js';
import { createLogger } from '../../bot/logger.js';
import { isContiguous } from '../../bot/seatFinder.js';
import { runScenario, getBrowser, closeBrowser, adminState, simulatedHuman } from './helpers.js';

after(closeBrowser);

const dump = (r) => '\n' + r.logs.join('\n');
const seatObjs = (ids, sections = { A: 14, B: 16, C: 16 }) => ids.map(id => {
  const [section, row, number] = id.split('-');
  return { id, section, row: +row, number: +number, aisleAfter: false };
});

test('기본 흐름: 오픈 감지 → 새 창 → 연석 선택 → 선점 → 사용자 확인 → 결제', async () => {
  const r = await runScenario({ config: { popups: { noticeDelayMs: 0, adDelayMs: 0 } }, bot: { prefs: { sections: ['A', 'B'] } } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.match(r.result.orderId, /^ORD-/);
  assert.equal(r.state.orders.length, 1);
  assert.deepEqual(r.state.orders[0].seatIds, r.result.heldSeats);
  assert.equal(r.result.contiguous, true);
  assert.ok(['A', 'B'].includes(r.result.heldSeats[0][0]));
  // 시간 감지: 오픈 전에는 절대 진입하지 않았고, 오픈 후 1초 안에 버튼을 감지
  const enter = r.state.log.find(e => e.ev === 'enter');
  assert.ok(enter.t >= r.state.config.openAt, '오픈 전 진입 시도 없음');
  assert.ok(r.result.metrics.buttonEnabledLagMs < 1000, `감지 지연 ${r.result.metrics.buttonEnabledLagMs}ms`);
  assert.ok(r.result.metrics.reloads >= 1, 'requireReload 사이트에서는 새로고침으로 버튼을 얻는다');
  // 팝업: 공지 모달/광고 레이어 닫기, confirm 수락
  assert.ok(r.result.overlaysClosed['광고 레이어'] >= 1, JSON.stringify(r.result.overlaysClosed));
  assert.ok(r.result.dialogs.some(d => d.type === 'confirm' && d.decision === 'accept'));
  assert.deepEqual(r.result.history, ['INIT', 'WAIT_OPEN', 'ENTERING', 'SELECT_SEATS', 'HOLDING', 'CHECKOUT', 'AWAIT_CONFIRM', 'PAYING', 'DONE']);
  assert.ok(!r.state.log.some(e => e.ev === 'rate-limited'), '레이트 리밋에 걸리지 않음');
});

test('공지 모달이 버튼을 가리고 있어도 자동으로 닫고 진행', async () => {
  // requireReload=false: 모달이 먼저 뜬 상태에서 오픈 → 클릭 시 addLocatorHandler 가 모달을 닫는다
  const r = await runScenario({ config: { openInMs: 2000, requireReload: false, popups: { noticeDelayMs: 0, bookingInNewWindow: false } } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.equal(r.result.metrics.reloads, 0, '자동 활성화 사이트에서는 새로고침하지 않음');
  assert.ok(r.result.overlaysClosed['공지 모달'] >= 1, JSON.stringify(r.result.overlaysClosed));
});

test('대기열: 우회하지 않고 순번이 될 때까지 기다린다', async () => {
  const r = await runScenario({ config: { queue: { enabled: true, initialAhead: 40, passPerSec: 25 } } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.ok(r.result.history.includes('QUEUE'));
  assert.ok(r.result.metrics.queueWaitMs >= 1000, `대기 ${r.result.metrics.queueWaitMs}ms`);
});

test('서버 게이트: 대기열/보안문자 미통과 상태로 좌석 API 직접 접근 불가', async () => {
  const lab = await startLab({ config: { openInMs: 0, queue: { enabled: true, initialAhead: 1000, passPerSec: 1 }, captcha: true } });
  try {
    const enter = await fetch(lab.url + '/api/booking/enter', { method: 'POST' });
    const sid = enter.headers.get('set-cookie').match(/sid=(\w+)/)[1];
    const seats = await fetch(lab.url + '/api/seats', { headers: { cookie: `sid=${sid}` } });
    assert.equal(seats.status, 403);
    assert.equal((await seats.json()).next, 'queue');
  } finally { await lab.close(); }
});

test('CAPTCHA: 봇은 풀지 않고 사람에게 넘긴 뒤 이어서 진행', async () => {
  const ref = {};
  const lab = await startLab({ config: { openInMs: 1500, captcha: true } });
  ref.url = lab.url;
  try {
    const logger = createLogger({ quiet: true });
    const bot = new TicketBot({ url: lab.url, browser: await getBrowser(), logger, count: 2, humanHandoff: simulatedHuman(ref, { wrongFirst: true }), confirmPurchase: async () => true });
    const result = await bot.run();
    assert.equal(result.status, 'DONE', logger.lines.join('\n'));
    assert.ok(result.history.includes('HUMAN_CAPTCHA'));
    assert.ok(logger.lines.some(l => l.includes('자동화는 이를 풀지 않습니다')));
  } finally { await lab.close(); }
});

test('CAPTCHA: 사람 개입 수단이 없으면(headless, 훅 없음) 중단 — 우회 시도 없음', async () => {
  const r = await runScenario({ config: { captcha: true } , bot: { humanHandoff: null } });
  assert.equal(r.result.status, 'FAILED');
  assert.match(r.result.history.join(), /HUMAN_CAPTCHA,FAILED/);
  assert.ok(!r.state.log.some(e => e.ev === 'captcha-pass'));
});

test('좌석 경합: 선점 직전에 타인이 가져가면(409) 알림 처리 후 다른 연석으로 재시도', async () => {
  const r = await runScenario({ config: { stealFirstHold: true } });
  assert.equal(r.result.status, 'DONE', dump(r));
  const stolen = r.state.log.find(e => e.ev === 'stolen').seatIds;
  assert.ok(r.result.dialogs.some(d => d.type === 'alert' && /이미 선택된 좌석/.test(d.message)));
  assert.ok(!r.result.heldSeats.some(id => stolen.includes(id)), '빼앗긴 좌석은 다시 시도하지 않는다');
  assert.match(r.result.history.join(), /HOLDING,SELECT_SEATS,HOLDING,CHECKOUT/);
});

test('실시간 경쟁 구매자(초당 40석 판매) 속에서도 연석을 확보', async () => {
  const r = await runScenario({ config: { competitor: { soldPerSec: 40 } }, bot: { count: 3 } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.equal(r.result.heldSeats.length, 3);
  assert.ok(isContiguous(seatObjs(r.result.heldSeats)));
});

test('연석 판단: 통로 양쪽 좌석은 연석으로 보지 않는다', async () => {
  // 1열 8석, 4번 뒤 통로. 남은 좌석 3,4,5,6 → 2매는 (3,4) 또는 (5,6) 이어야 함
  const sections = [{ id: 'A', grade: 'VIP', price: 100000, rows: 1, seatsPerRow: 8, aisleAfter: [4] }];
  const soldSeatIds = ['A-1-1', 'A-1-2', 'A-1-7', 'A-1-8'];
  const r = await runScenario({ config: { sections, soldSeatIds } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.ok(['A-1-3,A-1-4', 'A-1-5,A-1-6'].includes(r.result.heldSeats.join(',')), r.result.heldSeats.join(','));
  assert.equal(r.state.orders.length, 1);

  const r3 = await runScenario({ config: { sections, soldSeatIds }, bot: { count: 3, maxSeatRescans: 1, seatRescanMs: 200 } });
  assert.equal(r3.result.status, 'FAILED', '3연석이 없으면 분산석을 임의로 사지 않는다');
  assert.equal(r3.state.orders.length, 0);

  const rs = await runScenario({ config: { sections, soldSeatIds }, bot: { count: 3, prefs: { allowSplit: true } } });
  assert.equal(rs.result.status, 'DONE', dump(rs));
  assert.equal(rs.result.contiguous, false);
});

test('선호 조건: 구역·가격 상한 반영', async () => {
  const r = await runScenario({ bot: { prefs: { sections: ['C', 'B'], maxPricePerSeat: 100000 } } });
  assert.equal(r.result.status, 'DONE', dump(r));
  assert.ok(r.result.heldSeats.every(id => id.startsWith('C-')));
  assert.equal(r.result.total, 2 * 99000);
});

test('결제 확인 거절 → 결제하지 않고 좌석 반환', async () => {
  let seen;
  const r = await runScenario({ bot: { confirmPurchase: async (s) => { seen = s; return false; } } });
  assert.equal(r.result.status, 'CANCELLED', dump(r));
  assert.equal(seen.seatIds.length, 2);
  assert.match(seen.text, /합계/);
  assert.equal(r.state.orders.length, 0);
  assert.equal(r.state.holds.length, 0, '선점이 해제되어야 함');
  assert.ok(r.state.log.some(e => e.ev === 'release'));
  assert.ok(r.result.dialogs.some(d => /취소/.test(d.message) && d.decision === 'accept'));
});

test('확인 훅이 없거나 응답이 없으면 결제는 절대 진행되지 않는다', async () => {
  const none = await runScenario({ bot: { confirmPurchase: null } });
  assert.equal(none.result.status, 'CANCELLED');
  assert.equal(none.state.orders.length, 0);

  const silent = await runScenario({ bot: { confirmPurchase: () => new Promise(() => {}), timeouts: { confirmMs: 500 } } });
  assert.equal(silent.result.status, 'CANCELLED');
  assert.equal(silent.state.orders.length, 0);
});

test('상태 파일: 전이 이력과 결과가 디스크에 기록된다', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-')), 'run.json');
  const r = await runScenario({ bot: { stateFile: file } });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.state, r.result.status);
  assert.equal(saved.data.orderId, r.result.orderId);
  assert.ok(saved.history.every(h => typeof h.at === 'number'));
});

test('안전 장치: 허용되지 않은 외부 호스트는 실행 자체를 거부', () => {
  assert.throws(() => new TicketBot({ url: 'https://ticket.example.com/' }), /허용 목록에 없습니다/);
});
