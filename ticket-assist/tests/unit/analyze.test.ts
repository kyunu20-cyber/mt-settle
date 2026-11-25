import { describe, expect, it } from 'vitest';
import { analyze, contiguousBlocks, isContiguous, isNeighbor, recommend, scoreBlock, stageDistance } from '@/lib/seats/analyze';
import type { Seat, SeatMap, SeatPrefs } from '@/lib/seats/types';
import { DEFAULT_WEIGHTS } from '@/lib/seats/types';

// 좌석 생성기: pattern 'oox|oo' → o 가능, x 불가, | 통로(물리 간격 확대)
function row(section: string, r: number, pattern: string, opts: { y?: number; x0?: number; grade?: string; price?: number } = {}): Seat[] {
  const seats: Seat[] = [];
  let x = opts.x0 ?? 100, n = 0;
  for (const ch of pattern) {
    if (ch === '|') { x += 30; continue; }
    n++;
    seats.push({ id: `${section}-${r}-${n}`, section, row: String(r), number: n, x, y: opts.y ?? 100 + r * 24, w: 20, h: 20, status: ch === 'o' ? 'available' : 'unavailable', grade: opts.grade, price: opts.price });
    x += 24;
  }
  return seats;
}
const map = (seats: Seat[], stage = { x: 400, y: 20, w: 300, h: 30 }): SeatMap => ({ renderMode: 'dom', seats, stage, bounds: { x: 400, y: 300, w: 800, h: 600 } });
const prefs = (p: Partial<SeatPrefs> = {}): SeatPrefs => ({ quantity: 2, sections: [], grades: [], weights: DEFAULT_WEIGHTS, allowSplit: false, ...p });

describe('연석 판단', () => {
  it('번호 연속 + 물리적 간격으로 판정 (통로는 번호가 이어져도 연석 아님)', () => {
    const [a, b, c, d] = row('A', 1, 'oo|oo');
    expect(isNeighbor(a, b)).toBe(true);
    expect(isNeighbor(b, c)).toBe(false);
    expect(isNeighbor(c, d)).toBe(true);
  });
  it('다른 열/다른 구역/번호 건너뜀은 연석 아님', () => {
    const [a, b, c] = row('A', 1, 'ooo');
    expect(isNeighbor(a, { ...b, row: '2' })).toBe(false);
    expect(isNeighbor(a, { ...b, section: 'B' })).toBe(false);
    expect(isContiguous([a, c])).toBe(false);
    expect(isContiguous([c, a, b])).toBe(true);
  });
  it('판매석에서 구간이 끊긴다', () => {
    const blocks = contiguousBlocks(row('A', 1, 'ooxooo'), 2, s => s.status === 'available');
    expect(blocks.map(b => b.map(s => s.number).join('-'))).toEqual(['1-2', '4-5', '5-6']);
  });
});

describe('점수', () => {
  it('무대에 가까울수록, 중앙일수록 점수가 낮다(좋다)', () => {
    const near = row('A', 1, 'oo', { x0: 388 }), far = row('A', 9, 'oo', { x0: 388 }), side = row('A', 1, 'oo', { x0: 50 });
    const m = map([...near, ...far, ...side]);
    const p = prefs();
    expect(scoreBlock(near, m, p).total).toBeLessThan(scoreBlock(far, m, p).total);
    expect(scoreBlock(near, m, p).center).toBeLessThan(scoreBlock(side, m, p).center);
  });
  it('stageDistance: 무대 사각형 내부는 0', () => {
    expect(stageDistance({ x: 400, y: 20 }, { x: 400, y: 20, w: 100, h: 20 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(0);
  });
});

describe('추천과 차선책', () => {
  const seats = [
    ...row('A', 1, 'oxoxo', { x0: 340, grade: 'VIP' }),            // 선호 구역 A: 연석 없음
    ...row('B', 1, 'ooo', { x0: 600, grade: 'VIP', y: 140 }),       // 같은 등급 다른 구역
    ...row('C', 5, 'oooo', { x0: 340, grade: 'R', y: 400 }),        // 다른 등급
  ];
  it('선호 구역에 연석이 있으면 tier 1', () => {
    const r = recommend(map(seats), prefs({ sections: ['C'] }));
    expect(r[0].tier).toBe(1);
    expect(r[0].seats[0].section).toBe('C');
  });
  it('선호 구역에 없으면 같은 등급 다른 구역(tier 2) 차선책', () => {
    const r = recommend(map(seats), prefs({ sections: ['A'], grades: ['VIP'] }));
    expect(r[0].tier).toBe(2);
    expect(r[0].seats[0].section).toBe('B');
    expect(r[0].reason).toContain('차선책');
  });
  it('등급 조건도 없으면 전체 구역(tier 3)', () => {
    const r = recommend(map(seats), prefs({ sections: ['A'], quantity: 4 }));
    expect(r[0].tier).toBe(3);
    expect(r[0].seats.map(s => s.section)).toEqual(['C', 'C', 'C', 'C']);
  });
  it('어디에도 연석이 없으면 allowSplit 일 때만 분산석(tier 4)', () => {
    const only = row('A', 1, 'oxoxo');
    expect(recommend(map(only), prefs())).toEqual([]);
    const r = recommend(map(only), prefs({ allowSplit: true }));
    expect(r[0].tier).toBe(4);
    expect(r[0].contiguous).toBe(false);
  });
  it('가격 상한·제외 목록 반영', () => {
    const s = [...row('A', 1, 'oo', { price: 200 }), ...row('B', 2, 'oo', { price: 100, y: 300 })];
    expect(recommend(map(s), prefs({ maxPrice: 150 }))[0].seats[0].section).toBe('B');
    expect(recommend(map(s), prefs({ exclude: ['A-1-1'] }))[0].seats[0].section).toBe('B');
  });
  it('analyze: 구역별 집계와 fallback 플래그', () => {
    const a = analyze(map(seats), prefs({ sections: ['A'], grades: ['VIP'] }));
    expect(a.total).toBe(12);
    expect(a.available).toBe(10);
    expect(a.bySection.A).toEqual({ available: 3, total: 5 });
    expect(a.usedFallback).toBe(true);
  });
  it('quantity 검증', () => {
    expect(() => recommend(map(seats), prefs({ quantity: 0 }))).toThrow();
  });
});
