// 안전 장치: 대상 호스트 허용 목록, 요청 간격 제한
// - 기본값은 로컬(loopback)만 허용. 이 봇의 페이지 어댑터는 모의 사이트 전용이다.
// - 다른 호스트는 해당 서비스가 자동화를 허용한다는 것을 운영자가 확인한 경우에만 allowHosts 에 명시한다.
// - CAPTCHA / 대기열 / 접근 제한은 감지 시 사람에게 넘기거나 기다릴 뿐, 우회하는 코드는 없다.

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export function assertAllowedTarget(rawUrl, allowHosts = []) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`허용되지 않는 프로토콜: ${u.protocol}`);
  const allowed = new Set([...LOCAL_HOSTS, ...allowHosts.map(h => h.toLowerCase())]);
  if (!allowed.has(u.hostname.toLowerCase())) {
    throw new Error(
      `대상 호스트 '${u.hostname}' 는 허용 목록에 없습니다. 이 도구는 로컬 모의 사이트 검증용입니다. ` +
      `실제 서비스는 해당 서비스가 자동화를 허용하는 범위에서만, 명시적으로 allowHosts 에 추가해 사용하세요.`);
  }
  return u;
}

/** 최소 간격 보장 (새로고침/폴링 남용 방지) */
export class MinInterval {
  constructor(minMs, { now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.minMs = minMs; this.last = -Infinity; this.now = now; this.sleep = sleep; this.count = 0;
  }
  async wait() {
    const gap = this.now() - this.last;
    if (gap < this.minMs) await this.sleep(this.minMs - gap);
    this.last = this.now();
    this.count++;
  }
}
