// 서버 시각 동기화 / 오픈 시각 정밀 대기
// 여러 번 왕복 측정해 RTT 가 가장 짧은 샘플로 오프셋(서버시각 - 로컬시각)을 추정한다 (NTP 단순화).

/** samples: [{ t0, t1, server }] (t0=요청 직전 로컬, t1=응답 직후 로컬, server=서버가 준 시각) */
export function estimateOffset(samples) {
  if (!samples.length) throw new Error('no samples');
  const best = samples.reduce((a, b) => ((b.t1 - b.t0) < (a.t1 - a.t0) ? b : a));
  const rtt = best.t1 - best.t0;
  return { offset: best.server - (best.t0 + best.t1) / 2, rtt, uncertainty: rtt / 2, samples: samples.length };
}

/** fetchServerTime: () => Promise<number(서버 epoch ms)> */
export async function syncClock(fetchServerTime, { samples = 5, gapMs = 60, now = Date.now, sleep = defaultSleep } = {}) {
  const list = [];
  for (let i = 0; i < samples; i++) {
    const t0 = now();
    const server = await fetchServerTime();
    const t1 = now();
    list.push({ t0, t1, server });
    if (i < samples - 1) await sleep(gapMs);
  }
  return estimateOffset(list);
}

export const defaultSleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * 서버 기준 targetMs 까지 대기. 멀리는 크게 자고, 가까워지면 짧게 쪼개 자서 오차를 줄인다.
 * @returns 실제 깨어난 시각의 서버 기준 오차(ms, 양수=늦음)
 */
export async function waitUntilServerTime(targetMs, offset, { now = Date.now, sleep = defaultSleep, fineWindowMs = 1500, fineStepMs = 5, onTick } = {}) {
  for (;;) {
    const serverNow = now() + offset;
    const remain = targetMs - serverNow;
    if (remain <= 0) return -remain;
    if (onTick) onTick(remain);
    await sleep(remain > fineWindowMs ? Math.min(remain - fineWindowMs, 10_000) : Math.min(fineStepMs, remain));
  }
}
