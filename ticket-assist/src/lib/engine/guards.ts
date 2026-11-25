// 안전 장치: 허용 호스트, 요청 간격, 민감정보 저장 차단, 중복 예매 방지 장부
import fs from 'node:fs';
import path from 'node:path';

export function assertAllowedUrl(raw: string, hosts: string[]): URL {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`허용되지 않는 프로토콜: ${u.protocol}`);
  if (!hosts.map(h => h.toLowerCase()).includes(u.hostname.toLowerCase())) {
    throw new Error(`허용 범위 밖 이동 차단: ${u.hostname} (허용: ${hosts.join(', ')})`);
  }
  return u;
}

export class MinInterval {
  private last = -Infinity;
  count = 0;
  constructor(public minMs: number, private now = Date.now, private sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}
  async wait() {
    const gap = this.now() - this.last;
    if (gap < this.minMs) await this.sleep(this.minMs - gap);
    this.last = this.now();
    this.count++;
  }
}

const SECRET_KEY = /pass(word)?|pwd|secret|token|card|cvc|cvv|pin|account|계좌|비밀번호|카드/i;
/** 설정 객체 안에 비밀번호·결제정보로 보이는 키가 있으면 거부한다 (평문 저장 방지) */
export function findSecretKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k)) out.push(p);
    out.push(...findSecretKeys(v, p));
  }
  return out;
}

export type LedgerStatus = 'in-progress' | 'held' | 'completed' | 'cancelled' | 'failed';
export interface LedgerEntry { key: string; status: LedgerStatus; updatedAt: number; orderId?: string; note?: string }

/** 공연·회차 단위 예매 장부. 완료/선점 상태가 있으면 같은 예매를 다시 시작하지 않는다 */
export class Ledger {
  constructor(private file: string) {}
  static keyOf(adapterId: string, url: string, date: string, time: string) {
    const u = new URL(url);
    return `${adapterId}|${u.origin}${u.pathname}|${date}|${time}`;
  }
  all(): Record<string, LedgerEntry> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  get(key: string) { return this.all()[key]; }
  set(key: string, status: LedgerStatus, extra: Partial<LedgerEntry> = {}) {
    const all = this.all();
    all[key] = { ...all[key], ...extra, key, status, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, this.file);
    return all[key];
  }
  remove(key: string) {
    const all = this.all(); delete all[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
  /** 시작 가능 여부. completed / held 는 차단 */
  check(key: string): { ok: true } | { ok: false; reason: string } {
    const e = this.get(key);
    if (e?.status === 'completed') return { ok: false, reason: `이미 예매 완료된 공연/회차입니다 (주문 ${e.orderId ?? '-'}). 중복 예매 방지를 위해 시작하지 않습니다.` };
    if (e?.status === 'held') return { ok: false, reason: '이 회차에 결제 대기 중인 선점이 기록되어 있습니다. 사이트에서 상태를 확인한 뒤 기록을 정리하세요.' };
    return { ok: true };
  }
}
