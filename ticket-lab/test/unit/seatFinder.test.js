import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdjacent, isContiguous, findRuns, findContiguousBlocks, pickSeats } from '../../bot/seatFinder.js';

// 한 줄 좌석 만들기: pattern 'oo.x' → o=available, x=sold, '|' = 직전 좌석 뒤 통로
function row(section, rowNo, pattern, price = 100) {
  const seats = [];
  let n = 0;
  for (const ch of pattern) {
    if (ch === '|') { seats[seats.length - 1].aisleAfter = true; continue; }
    n++;
    seats.push({ id: `${section}-${rowNo}-${n}`, section, row: rowNo, number: n, price, status: ch === 'o' ? 'available' : 'sold', aisleAfter: false });
  }
  return seats;
}

test('isAdjacent: 통로·다른 열·다른 구역은 인접 아님', () => {
  const [a, b, c, d] = row('A', 1, 'oo|oo');
  assert.equal(isAdjacent(a, b), true);
  assert.equal(isAdjacent(b, c), false, '통로를 건너면 연석 아님');
  assert.equal(isAdjacent(c, d), true);
  const [e] = row('A', 2, 'o');
  assert.equal(isAdjacent(a, { ...e, number: 2 }), false, '다른 열');
  assert.equal(isAdjacent(a, { ...b, section: 'B' }), false, '다른 구역');
});

test('isContiguous: 순서 무관, 빈칸 있으면 false', () => {
  const s = row('A', 1, 'oooo');
  assert.equal(isContiguous([s[2], s[0], s[1]]), true);
  assert.equal(isContiguous([s[0], s[2]]), false);
  assert.equal(isContiguous([s[0]]), true);
});

test('findRuns: 판매석과 통로에서 끊긴다', () => {
  const seats = [...row('A', 1, 'ooxooo|oo'), ...row('A', 2, 'xxxx')];
  const runs = findRuns(seats).map(r => r.map(s => s.number));
  assert.deepEqual(runs, [[1, 2], [4, 5, 6], [7, 8]]);
});

test('findContiguousBlocks: run 내 모든 윈도우 열거', () => {
  const blocks = findContiguousBlocks(row('A', 1, 'oooo'), 2).map(b => b.map(s => s.number).join('-'));
  assert.deepEqual(blocks, ['1-2', '2-3', '3-4']);
  assert.equal(findContiguousBlocks(row('A', 1, 'oxo'), 2).length, 0);
});

test('pickSeats: 앞 열 우선, 같은 열이면 중앙 우선', () => {
  const seats = [...row('A', 1, 'ooxxxxxx'), ...row('A', 2, 'oooooooo'), ...row('A', 3, 'oooooooo')];
  const r = pickSeats(seats, 2);
  assert.equal(r.contiguous, true);
  assert.deepEqual(r.seats.map(s => s.id), ['A-1-1', 'A-1-2'], '1열 좌측이라도 앞 열이 우선');
  const r3 = pickSeats(seats, 3);
  assert.equal(r3.seats[0].row, 2);
  const mid = (r3.seats[0].number + r3.seats[2].number) / 2;
  assert.ok(Math.abs(mid - 4.5) <= 0.5, `중앙에 가까워야 함: ${mid}`);
});

test('pickSeats: 구역 선호 순서 / 가격·열 상한 / 제외 목록', () => {
  const seats = [...row('A', 1, 'oo', 150), ...row('B', 1, 'oo', 100), ...row('C', 1, 'oo', 50)];
  assert.equal(pickSeats(seats, 2, { sections: ['B', 'A'] }).seats[0].section, 'B');
  assert.equal(pickSeats(seats, 2, { maxPricePerSeat: 120 }).seats[0].section, 'B');
  assert.equal(pickSeats(seats, 2, { sections: ['A'], maxPricePerSeat: 120 }), null);
  const ex = new Set(['B-1-1']);
  assert.equal(pickSeats(seats, 2, { sections: ['B', 'C'], exclude: ex }).seats[0].section, 'C');
  const deep = [...row('A', 5, 'oo')];
  assert.equal(pickSeats(deep, 2, { maxRow: 3 }), null);
});

test('pickSeats: 통로 양쪽 2석은 연석이 아니다', () => {
  // 좌석 3,4 | 5,6 만 남음 → 3매 연석 없음
  const seats = row('A', 1, 'xxoo|ooxx');
  assert.equal(pickSeats(seats, 3), null);
  const two = pickSeats(seats, 2).seats.map(s => s.number);
  assert.ok(['3,4', '5,6'].includes(two.join(',')), `통로를 건너지 않아야 함: ${two}`);
});

test('pickSeats: allowSplit 이면 분산석 대안, contiguous=false', () => {
  const seats = row('A', 1, 'oxoxo');
  assert.equal(pickSeats(seats, 2), null);
  const r = pickSeats(seats, 2, { allowSplit: true });
  assert.equal(r.seats.length, 2);
  assert.equal(r.contiguous, false);
});

test('pickSeats: 연석이 있으면 분산석보다 항상 우선', () => {
  const seats = [...row('A', 1, 'oxoxo'), ...row('A', 8, 'oo')];
  const r = pickSeats(seats, 2, { allowSplit: true });
  assert.equal(r.contiguous, true);
  assert.equal(r.seats[0].row, 8);
});
