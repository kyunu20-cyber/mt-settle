// 좌석 탐색 / 연석 판단 (순수 함수 — 브라우저 없이 단위 테스트 가능)
//
// seat: { id, section, row, number, price, grade, status, aisleAfter }
// 연석 정의: 같은 구역 · 같은 열 · 번호가 1씩 연속 · 사이에 통로(aisleAfter) 없음

/** 두 좌석이 나란히 붙어 있는지 (a 바로 오른쪽이 b) */
export function isAdjacent(a, b) {
  return a.section === b.section && a.row === b.row && b.number === a.number + 1 && !a.aisleAfter;
}

/** 좌석 묶음이 연석인지 판정 (순서 무관) */
export function isContiguous(seats) {
  if (seats.length <= 1) return true;
  const s = [...seats].sort((x, y) => x.number - y.number);
  return s.every((seat, i) => i === 0 || isAdjacent(s[i - 1], seat));
}

/** 선택 가능한 좌석들 중에서 끊기지 않은 연속 구간(run)들을 구한다 */
export function findRuns(seats, { isAvailable = s => s.status === 'available' } = {}) {
  const byRow = new Map();
  for (const s of seats) {
    if (!isAvailable(s)) continue;
    const key = `${s.section}|${s.row}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(s);
  }
  const runs = [];
  for (const list of byRow.values()) {
    list.sort((a, b) => a.number - b.number);
    let cur = [list[0]];
    for (let i = 1; i < list.length; i++) {
      if (isAdjacent(list[i - 1], list[i])) cur.push(list[i]);
      else { runs.push(cur); cur = [list[i]]; }
    }
    runs.push(cur);
  }
  return runs;
}

/** count 매 연석 후보를 전부 열거 (각 run 안의 모든 슬라이딩 윈도우) */
export function findContiguousBlocks(seats, count, opts = {}) {
  const blocks = [];
  for (const run of findRuns(seats, opts)) {
    for (let i = 0; i + count <= run.length; i++) blocks.push(run.slice(i, i + count));
  }
  return blocks;
}

/** 구역별 좌석 수(중앙 판정용)를 전체 좌석에서 추정 */
function rowWidths(seats) {
  const w = new Map();
  for (const s of seats) w.set(s.section, Math.max(w.get(s.section) || 0, s.number));
  return w;
}

/**
 * 후보 묶음 점수 (낮을수록 좋음)
 * prefs.sections: 선호 구역 순서 ['A','B'] — 목록에 없으면 제외
 * prefs.maxPricePerSeat, prefs.maxRow: 상한 필터
 */
export function scoreBlock(block, prefs, widths) {
  const sections = prefs.sections && prefs.sections.length ? prefs.sections : null;
  const sec = block[0].section;
  const secRank = sections ? sections.indexOf(sec) : 0;
  if (secRank < 0) return Infinity;
  if (prefs.maxPricePerSeat != null && block.some(s => s.price > prefs.maxPricePerSeat)) return Infinity;
  if (prefs.maxRow != null && block.some(s => s.row > prefs.maxRow)) return Infinity;
  if (prefs.exclude && block.some(s => prefs.exclude.has(s.id))) return Infinity;
  const width = widths.get(sec) || 1;
  const mid = (block[0].number + block[block.length - 1].number) / 2;
  const centerDist = Math.abs(mid - (width + 1) / 2) / width; // 0~0.5
  const rows = new Set(block.map(s => s.row));
  const avgRow = block.reduce((a, s) => a + s.row, 0) / block.length;
  // 구역 우선 > 앞 열 > 중앙 > (분산석이면 큰 패널티)
  return secRank * 10000 + avgRow * 100 + centerDist * 50 + (rows.size - 1) * 500;
}

/**
 * 최적 좌석 선택
 * @returns {{ seats, contiguous, score } | null}
 * prefs.allowSplit: 연석이 없을 때 같은 구역 내 분산석 허용 여부 (기본 false)
 */
export function pickSeats(allSeats, count, prefs = {}) {
  if (count < 1) throw new Error('count must be >= 1');
  const widths = rowWidths(allSeats);
  const isAvailable = s => s.status === 'available' && !(prefs.exclude && prefs.exclude.has(s.id));

  let best = null;
  for (const block of findContiguousBlocks(allSeats, count, { isAvailable })) {
    const score = scoreBlock(block, prefs, widths);
    if (score < Infinity && (!best || score < best.score)) best = { seats: block, contiguous: true, score };
  }
  if (best || !prefs.allowSplit) return best;

  // 대안: 구역별로 가장 좋은 개별 좌석 count 개 (연석 아님)
  for (const sec of prefs.sections?.length ? prefs.sections : [...widths.keys()]) {
    const singles = allSeats
      .filter(s => s.section === sec && isAvailable(s))
      .map(s => ({ s, sc: scoreBlock([s], prefs, widths) }))
      .filter(x => x.sc < Infinity)
      .sort((a, b) => a.sc - b.sc)
      .slice(0, count);
    if (singles.length === count) {
      const seats = singles.map(x => x.s);
      const score = scoreBlock(seats, prefs, widths) + 100000;
      if (!best || score < best.score) best = { seats, contiguous: isContiguous(seats), score };
    }
  }
  return best;
}
