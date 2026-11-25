// 좌석 분석: 연석 판단, 무대 거리·중앙도 점수, 선호 구역 → 차선책 순의 추천
import type { Rect, Recommendation, Seat, SeatAnalysis, SeatMap, SeatPrefs, Tier } from './types';
import { DEFAULT_WEIGHTS } from './types';

const rowKey = (s: Seat) => `${s.section}\u0000${s.row}`;

/**
 * a 의 바로 오른쪽 옆자리가 b 인지.
 * 번호 연속 + 실제 화면상 간격이 좌석 폭의 GAP_FACTOR 배 이내여야 한다(통로는 번호가 이어져도 물리적 간격이 넓다).
 */
export const GAP_FACTOR = 1.6;
export function isNeighbor(a: Seat, b: Seat): boolean {
  if (a.section !== b.section || a.row !== b.row || b.number !== a.number + 1) return false;
  const pitch = Math.abs(b.x - a.x);
  const width = (a.w + b.w) / 2 || 1;
  const sameLine = Math.abs(b.y - a.y) <= Math.max(a.h, b.h) * 0.6;
  return sameLine && pitch <= width * GAP_FACTOR;
}

export function isContiguous(seats: Seat[]): boolean {
  if (seats.length <= 1) return true;
  const s = [...seats].sort((p, q) => p.number - q.number);
  return s.every((seat, i) => i === 0 || isNeighbor(s[i - 1], seat));
}

/** 연속 좌석 구간(run) */
export function findRuns(seats: Seat[], pred: (s: Seat) => boolean): Seat[][] {
  const rows = new Map<string, Seat[]>();
  for (const s of seats) {
    if (!pred(s)) continue;
    const k = rowKey(s);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k)!.push(s);
  }
  const runs: Seat[][] = [];
  for (const list of rows.values()) {
    list.sort((a, b) => a.number - b.number);
    let cur = [list[0]];
    for (let i = 1; i < list.length; i++) {
      if (isNeighbor(list[i - 1], list[i])) cur.push(list[i]);
      else { runs.push(cur); cur = [list[i]]; }
    }
    runs.push(cur);
  }
  return runs;
}

export function contiguousBlocks(seats: Seat[], n: number, pred: (s: Seat) => boolean): Seat[][] {
  const out: Seat[][] = [];
  for (const run of findRuns(seats, pred)) for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
  return out;
}

function boundsOf(seats: Seat[]): Rect {
  if (!seats.length) return { x: 0, y: 0, w: 1, h: 1 };
  const xs = seats.map(s => s.x), ys = seats.map(s => s.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** 무대 사각형까지 최단거리 (무대 정보가 없으면 좌석 배치 상단 중앙을 무대로 가정) */
export function stageDistance(p: { x: number; y: number }, stage: Rect | null, bounds: Rect): number {
  const st = stage ?? { x: bounds.x, y: bounds.y - bounds.h / 2, w: bounds.w / 3, h: 0 };
  const dx = Math.max(Math.abs(p.x - st.x) - st.w / 2, 0);
  const dy = Math.max(Math.abs(p.y - st.y) - st.h / 2, 0);
  return Math.hypot(dx, dy);
}

export interface ScoreParts { stage: number; center: number; section: number; total: number }

/** 낮을수록 좋음. 각 항목 0~1 정규화 */
export function scoreBlock(block: Seat[], map: Pick<SeatMap, 'stage' | 'bounds'>, prefs: SeatPrefs): ScoreParts {
  const w = prefs.weights ?? DEFAULT_WEIGHTS;
  const cx = block.reduce((a, s) => a + s.x, 0) / block.length;
  const cy = block.reduce((a, s) => a + s.y, 0) / block.length;
  const diag = Math.hypot(map.bounds.w, map.bounds.h) || 1;
  const stage = Math.min(1, stageDistance({ x: cx, y: cy }, map.stage, map.bounds) / diag);
  const axis = map.stage ? map.stage.x : map.bounds.x;
  const center = Math.min(1, Math.abs(cx - axis) / (map.bounds.w / 2 || 1));
  const idx = prefs.sections.indexOf(block[0].section);
  const section = prefs.sections.length === 0 ? 0 : idx < 0 ? 1 : idx / prefs.sections.length;
  const spread = new Set(block.map(rowKey)).size - 1; // 분산석이면 추가 패널티
  return { stage, center, section, total: w.stage * stage + w.center * center + w.section * section + spread * 0.25 };
}

const TIER_REASON: Record<Tier, string> = {
  1: '선호 구역·등급 연석',
  2: '선호 구역에 연석 없음 → 선호 등급의 다른 구역 연석 (차선책)',
  3: '선호 조건에 연석 없음 → 전체 구역 연석 (차선책)',
  4: '연석 없음 → 분산 좌석 (차선책, allowSplit)',
};

export function recommend(map: SeatMap, prefs: SeatPrefs, limit = 5): Recommendation[] {
  const n = prefs.quantity;
  if (!Number.isInteger(n) || n < 1) throw new Error('quantity must be a positive integer');
  const exclude = new Set(prefs.exclude ?? []);
  const base = (s: Seat) => s.status === 'available' && !exclude.has(s.id) && (prefs.maxPrice == null || s.price == null || s.price <= prefs.maxPrice);
  const inSection = (s: Seat) => prefs.sections.length === 0 || prefs.sections.includes(s.section);
  const inGrade = (s: Seat) => prefs.grades.length === 0 || (s.grade != null && prefs.grades.includes(s.grade));

  const tiers: [Tier, (s: Seat) => boolean][] = [
    [1, s => base(s) && inSection(s) && inGrade(s)],
    [2, s => base(s) && !inSection(s) && prefs.grades.length > 0 && inGrade(s)],
    [3, s => base(s)],
  ];
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  const push = (seats: Seat[], tier: Tier, contiguous: boolean) => {
    const key = seats.map(s => s.id).sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ seats, tier, contiguous, reason: TIER_REASON[tier], score: scoreBlock(seats, map, prefs).total });
  };

  for (const [tier, pred] of tiers) {
    const blocks = contiguousBlocks(map.seats, n, pred)
      .map(b => ({ b, sc: scoreBlock(b, map, prefs).total }))
      .sort((a, b) => a.sc - b.sc);
    for (const { b } of blocks) { push(b, tier, true); if (out.length >= limit) return out; }
    if (out.length) return out; // 상위 tier 에서 찾았으면 더 낮은 tier 로 내려가지 않음
  }

  if (prefs.allowSplit) {
    // 구역별로 가장 좋은 좌석을 기준으로 가까운 좌석 n-1 개를 묶는다
    const avail = map.seats.filter(tiers[2][1]);
    const sections = [...new Set(avail.map(s => s.section))]
      .sort((a, b) => rank(prefs.sections, a) - rank(prefs.sections, b));
    for (const sec of sections) {
      const pool = avail.filter(s => s.section === sec)
        .map(s => ({ s, sc: scoreBlock([s], map, prefs).total })).sort((a, b) => a.sc - b.sc).map(x => x.s);
      if (pool.length < n) continue;
      const anchor = pool[0];
      const group = [anchor, ...pool.slice(1).sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y)).slice(0, n - 1)];
      push(group, 4, isContiguous(group));
      if (out.length >= limit) break;
    }
  }
  return out;
}

const rank = (list: string[], v: string) => (list.indexOf(v) < 0 ? 1e6 : list.indexOf(v));

export function analyze(map: SeatMap, prefs: SeatPrefs, limit = 5): SeatAnalysis {
  const bySection: SeatAnalysis['bySection'] = {};
  let available = 0, unavailable = 0, unknown = 0;
  for (const s of map.seats) {
    bySection[s.section] ??= { available: 0, total: 0 };
    bySection[s.section].total++;
    if (s.status === 'available') { available++; bySection[s.section].available++; }
    else if (s.status === 'unavailable') unavailable++;
    else unknown++;
  }
  const bounds = map.bounds.w > 1 ? map.bounds : boundsOf(map.seats);
  const recommendations = recommend({ ...map, bounds }, prefs, limit);
  return {
    renderMode: map.renderMode, total: map.seats.length, available, unavailable, unknown, bySection,
    recommendations, usedFallback: recommendations.length > 0 && recommendations[0].tier > 1, notes: map.notes ?? [],
  };
}
