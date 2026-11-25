// 좌석 배치 생성: 구역(section) → 열(row) → 좌석(number). aisleAfter 에 해당하는 번호 뒤는 통로.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SECTIONS = [
  { id: 'A', grade: 'VIP', price: 154000, rows: 6, seatsPerRow: 14, aisleAfter: [7] },
  { id: 'B', grade: 'R', price: 132000, rows: 8, seatsPerRow: 16, aisleAfter: [4, 12] },
  { id: 'C', grade: 'S', price: 99000, rows: 8, seatsPerRow: 16, aisleAfter: [4, 12] },
];

export function buildSeats({ sections = DEFAULT_SECTIONS, soldRatio = 0.55, seed = 42, soldSeatIds = null } = {}) {
  const rnd = mulberry32(seed);
  const seats = new Map();
  for (const s of sections) {
    for (let row = 1; row <= s.rows; row++) {
      for (let n = 1; n <= s.seatsPerRow; n++) {
        const id = `${s.id}-${row}-${n}`;
        const sold = soldSeatIds ? soldSeatIds.includes(id) : rnd() < soldRatio;
        seats.set(id, {
          id, section: s.id, grade: s.grade, price: s.price, row, number: n,
          aisleAfter: (s.aisleAfter || []).includes(n),
          status: sold ? 'sold' : 'available',
          holdId: null,
        });
      }
    }
  }
  return seats;
}
