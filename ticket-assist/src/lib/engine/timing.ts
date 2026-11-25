// 서버 시각 동기화 / 정밀 대기
export interface ClockSample { t0: number; t1: number; server: number }

export function estimateOffset(samples: ClockSample[]) {
  if (!samples.length) throw new Error('no samples');
  const best = samples.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
  const rtt = best.t1 - best.t0;
  return { offsetMs: best.server - (best.t0 + best.t1) / 2, rttMs: rtt };
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));

export async function syncClock(fetchServer: () => Promise<number>, n = 5, now = Date.now, gapMs = 50) {
  const s: ClockSample[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now(); const server = await fetchServer(); const t1 = now();
    s.push({ t0, t1, server });
    if (i < n - 1) await sleep(gapMs);
  }
  return estimateOffset(s);
}

/** HTTP Date 헤더(초 단위)로 대략적인 오프셋 추정 — 사이트가 ms 시간원을 제공하지 않을 때의 대안 */
export function offsetFromDateHeader(dateHeader: string, t0: number, t1: number) {
  const server = Date.parse(dateHeader) + 500; // 초 단위 절삭 보정
  return { offsetMs: server - (t0 + t1) / 2, rttMs: t1 - t0 + 1000 };
}

/**
 * 서버 기준 target 까지 대기. 멀면 크게, 가까우면 잘게 잔다.
 * checkpoint 는 일시정지/중단 처리를 위해 주기적으로 호출된다.
 */
export async function waitUntil(target: number, offsetMs: number, opts: { checkpoint?: () => Promise<void>; onTick?: (remain: number) => void; now?: () => number; sleepFn?: (ms: number) => Promise<void> } = {}) {
  const now = opts.now ?? Date.now, sl = opts.sleepFn ?? sleep;
  for (;;) {
    const remain = target - (now() + offsetMs);
    if (remain <= 0) return -remain;
    opts.onTick?.(remain);
    await opts.checkpoint?.();
    await sl(remain > 1500 ? Math.min(remain - 1000, 1000) : Math.min(remain, 4));
  }
}

/**
 * HTTP Date 헤더의 "초가 바뀌는 순간"을 포착해 오프셋을 ±(간격/2 + RTT/2) 정도로 추정한다.
 * 초 단위 헤더만 주는 사이트에서 ±500ms 오차를 줄이기 위한 방법. 요청은 intervalMs 간격, 최대 maxSamples 회.
 */
export async function syncByDateBoundary(
  head: () => Promise<{ date: string | null; t0: number; t1: number }>,
  { intervalMs = 100, maxSamples = 13, sleepFn = sleep } = {},
): Promise<{ offsetMs: number; rttMs: number } | null> {
  let prev: { sec: number; mid: number } | null = null;
  for (let i = 0; i < maxSamples; i++) {
    const s = await head();
    if (!s.date) return null;
    const sec = Date.parse(s.date);
    if (Number.isNaN(sec)) return null;
    const mid = (s.t0 + s.t1) / 2;
    if (prev && sec > prev.sec) {
      const boundaryLocal = (prev.mid + mid) / 2;  // 이 로컬 시각 근처에서 서버 시계가 sec(.000) 을 지났다
      return { offsetMs: Math.round(sec - boundaryLocal), rttMs: Math.round(mid - prev.mid) };
    }
    prev = { sec, mid };
    await sleepFn(intervalMs);
  }
  return null;
}
