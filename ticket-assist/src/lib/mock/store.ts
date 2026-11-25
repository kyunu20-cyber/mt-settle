// 모의 예매 사이트의 서버 상태 (메모리). 실제 티켓 구매 없이 엔진을 검증하기 위한 것.
import crypto from 'node:crypto';
import type { RenderMode } from '../seats/types';

export interface MockConfig {
  title: string;
  openAt: number;
  openInMs: number;
  requireLogin: boolean;
  sessionTtlMs: number;
  requireReload: boolean;
  queue: { enabled: boolean; initialAhead: number; passPerSec: number };
  captcha: boolean;
  identity: boolean;
  renderMode: RenderMode;
  competitorPerSec: number;
  stealFirstHold: boolean;
  holdTtlMs: number;
  maxPerOrder: number;
  soldRatio: number;
  seed: number;
  /** 지정 좌석만 판매 가능으로 (나머지 판매완료). 엣지 케이스 재현용 */
  onlyAvailable: string[] | null;
  popups: { notice: boolean; noticeDelayMs: number; bookingInNewTab: boolean };
  faults: { seats5xx: number; hold5xx: number };
  rateLimitPerSec: number;
}

export const DEFAULT_MOCK: MockConfig = {
  title: '2026 모의 콘서트 〈LAB LIVE〉',
  openAt: 0,
  openInMs: 15_000,
  requireLogin: true,
  sessionTtlMs: 30 * 60_000,
  requireReload: true,
  queue: { enabled: false, initialAhead: 50, passPerSec: 25 },
  captcha: false,
  identity: false,
  renderMode: 'dom',
  competitorPerSec: 0,
  stealFirstHold: false,
  holdTtlMs: 7 * 60_000,
  maxPerOrder: 4,
  soldRatio: 0.5,
  seed: 7,
  onlyAvailable: null,
  popups: { notice: true, noticeDelayMs: 400, bookingInNewTab: true },
  faults: { seats5xx: 0, hold5xx: 0 },
  rateLimitPerSec: 40,
};

export interface MockSeat { id: string; section: string; grade: string; price: number; row: number; number: number; x: number; y: number; w: number; h: number; status: 'available' | 'sold' | 'held'; holdId: string | null }
export interface Showtime { id: string; date: string; time: string }
export interface Session {
  sid: string; user: string | null; loginAt: number; entered: boolean; queueAt: number | null;
  captchaAnswer: string | null; captchaPassed: boolean; identityCode: string | null; identityPassed: boolean;
  showtimeId: string | null; holdId: string | null; orderId: string | null; hits: number[];
}
export interface Hold { id: string; sid: string; user: string; showtimeId: string; seatIds: string[]; total: number; expiresAt: number }
export interface Order { orderId: string; user: string; showtimeId: string; seatIds: string[]; total: number; paidAt: number; idempotencyKey: string }

export const CANVAS = { width: 960, height: 640, stage: { x: 480, y: 40, w: 360, h: 44 } };
export const SECTIONS = [
  { id: 'A', grade: 'VIP', price: 165000, rows: 6, cols: 16, aisles: [8], x0: 480, y0: 120, align: 'center' },
  { id: 'B', grade: 'R', price: 143000, rows: 8, cols: 8, aisles: [], x0: 70, y0: 140, align: 'left' },
  { id: 'C', grade: 'R', price: 143000, rows: 8, cols: 8, aisles: [], x0: 890, y0: 140, align: 'right' },
  { id: 'D', grade: 'S', price: 110000, rows: 7, cols: 22, aisles: [5, 17], x0: 480, y0: 330, align: 'center' },
] as const;
const PITCH = 22, SIZE = 18, AISLE = 16;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function buildSeats(cfg: MockConfig, showtimeIdx: number): Map<string, MockSeat> {
  const rnd = rng(cfg.seed * 31 + showtimeIdx);
  const seats = new Map<string, MockSeat>();
  for (const s of SECTIONS) {
    const width = s.cols * PITCH + s.aisles.length * AISLE;
    const left = s.align === 'center' ? s.x0 - width / 2 : s.align === 'left' ? s.x0 : s.x0 - width;
    for (let r = 1; r <= s.rows; r++) {
      let x = left;
      for (let n = 1; n <= s.cols; n++) {
        const id = `${s.id}-${r}-${n}`;
        const sold = cfg.onlyAvailable ? !cfg.onlyAvailable.includes(id) : rnd() < cfg.soldRatio;
        seats.set(id, { id, section: s.id, grade: s.grade, price: s.price, row: r, number: n, x: x + SIZE / 2, y: s.y0 + (r - 1) * PITCH + SIZE / 2, w: SIZE, h: SIZE, status: sold ? 'sold' : 'available', holdId: null });
        x += PITCH + ((s.aisles as readonly number[]).includes(n) ? AISLE : 0);
      }
    }
  }
  return seats;
}

const SHOWTIMES: Showtime[] = [
  { id: 'S1', date: '2026-12-19', time: '18:00' },
  { id: 'S2', date: '2026-12-20', time: '14:00' },
  { id: 'S3', date: '2026-12-20', time: '19:00' },
];

const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class MockStore {
  cfg!: MockConfig;
  showtimes = SHOWTIMES;
  seatMaps = new Map<string, Map<string, MockSeat>>();
  sessions = new Map<string, Session>();
  holds = new Map<string, Hold>();
  orders: Order[] = [];
  log: { t: number; sid?: string; ev: string; [k: string]: unknown }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stolen = false;

  constructor(over: Partial<MockConfig> = {}) { this.reset(over); }

  reset(over: Partial<MockConfig> = {}) {
    const merged: MockConfig = {
      ...DEFAULT_MOCK, ...over,
      queue: { ...DEFAULT_MOCK.queue, ...(over.queue ?? {}) },
      popups: { ...DEFAULT_MOCK.popups, ...(over.popups ?? {}) },
      faults: { ...DEFAULT_MOCK.faults, ...(over.faults ?? {}) },
    };
    if (!merged.openAt) merged.openAt = Date.now() + merged.openInMs;
    this.cfg = merged;
    this.seatMaps = new Map(SHOWTIMES.map((s, i) => [s.id, buildSeats(merged, i)]));
    this.sessions = new Map(); this.holds = new Map(); this.orders = []; this.log = []; this.stolen = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (merged.competitorPerSec > 0) {
      const r = rng(merged.seed + 99);
      this.timer = setInterval(() => {
        if (!this.isOpen()) return;
        for (const map of this.seatMaps.values()) {
          const avail = [...map.values()].filter(s => s.status === 'available');
          if (avail.length) avail[Math.floor(r() * avail.length)].status = 'sold';
        }
      }, Math.max(20, 1000 / merged.competitorPerSec));
      (this.timer as { unref?: () => void }).unref?.();
    }
    return this.cfg;
  }

  isOpen() { return Date.now() >= this.cfg.openAt; }

  session(sid: string | undefined): { s: Session; isNew: boolean } {
    if (sid && this.sessions.has(sid)) return { s: this.sessions.get(sid)!, isNew: false };
    const s: Session = { sid: crypto.randomBytes(12).toString('hex'), user: null, loginAt: 0, entered: false, queueAt: null, captchaAnswer: null, captchaPassed: false, identityCode: null, identityPassed: false, showtimeId: null, holdId: null, orderId: null, hits: [] };
    this.sessions.set(s.sid, s);
    return { s, isNew: true };
  }

  loggedIn(s: Session) {
    if (!this.cfg.requireLogin) return true;
    if (!s.user) return false;
    if (Date.now() - s.loginAt > this.cfg.sessionTtlMs) { s.user = null; this.log.push({ t: Date.now(), sid: s.sid, ev: 'session-expired' }); return false; }
    return true;
  }

  login(s: Session, user: string) { s.user = user || 'guest'; s.loginAt = Date.now(); this.log.push({ t: Date.now(), sid: s.sid, ev: 'login' }); }

  expireAll() { for (const s of this.sessions.values()) s.user = null; this.log.push({ t: Date.now(), ev: 'expire-all' }); }

  queuePosition(s: Session) {
    if (!this.cfg.queue.enabled || s.queueAt == null) return 0;
    return Math.max(0, Math.ceil(this.cfg.queue.initialAhead - ((Date.now() - s.queueAt) / 1000) * this.cfg.queue.passPerSec));
  }

  step(s: Session): string {
    this.expireHolds();
    if (s.orderId) return 'done';
    if (!this.loggedIn(s)) return 'login-required';
    if (!this.isOpen()) return 'not-open';
    if (!s.entered) return 'enter';
    if (this.queuePosition(s) > 0) return 'queue';
    if (this.cfg.captcha && !s.captchaPassed) return 'captcha';
    if (this.cfg.identity && !s.identityPassed) return 'identity';
    if (!s.showtimeId) return 'schedule';
    if (s.holdId && this.holds.has(s.holdId)) return 'payment';
    return 'seats';
  }

  enter(s: Session) {
    if (!s.entered) { s.entered = true; s.queueAt = this.cfg.queue.enabled ? Date.now() : null; this.log.push({ t: Date.now(), sid: s.sid, ev: 'enter' }); }
  }

  newCaptcha(s: Session) {
    let a = ''; for (let i = 0; i < 5; i++) a += CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)];
    s.captchaAnswer = a; return a;
  }

  newIdentityCode(s: Session) { s.identityCode = String(crypto.randomInt(100000, 999999)); return s.identityCode; }

  expireHolds() {
    const now = Date.now();
    for (const h of this.holds.values()) if (now > h.expiresAt) this.release(h.id, 'expired');
  }

  release(holdId: string, why = 'release') {
    const h = this.holds.get(holdId); if (!h) return;
    const map = this.seatMaps.get(h.showtimeId)!;
    for (const id of h.seatIds) { const seat = map.get(id); if (seat && seat.holdId === holdId) { seat.status = 'available'; seat.holdId = null; } }
    this.holds.delete(holdId);
    const s = this.sessions.get(h.sid); if (s?.holdId === holdId) s.holdId = null;
    this.log.push({ t: Date.now(), sid: h.sid, ev: why, holdId });
  }

  hold(s: Session, seatIds: string[]): { code: number; body: Record<string, unknown> } {
    const map = s.showtimeId ? this.seatMaps.get(s.showtimeId) : null;
    if (!map) return { code: 400, body: { error: '회차를 먼저 선택하세요.' } };
    if (!Array.isArray(seatIds) || !seatIds.length) return { code: 400, body: { error: '좌석을 선택하세요.' } };
    if (seatIds.length > this.cfg.maxPerOrder) return { code: 400, body: { error: `1회 최대 ${this.cfg.maxPerOrder}매` } };
    if (s.holdId) return { code: 409, body: { error: '이미 선점 중인 좌석이 있습니다.', code: 'ALREADY_HELD' } };
    if (this.orders.some(o => o.user === s.user && o.showtimeId === s.showtimeId)) return { code: 409, body: { error: '해당 회차에 이미 예매 내역이 있습니다.', code: 'DUPLICATE_ORDER' } };
    const list = seatIds.map(id => map.get(id));
    if (list.some(x => !x)) return { code: 400, body: { error: '존재하지 않는 좌석' } };
    if (this.cfg.stealFirstHold && !this.stolen) { this.stolen = true; list.forEach(x => { if (x!.status === 'available') x!.status = 'sold'; }); this.log.push({ t: Date.now(), sid: s.sid, ev: 'stolen', seatIds }); }
    const taken = list.filter(x => x!.status !== 'available').map(x => x!.id);
    if (taken.length) { this.log.push({ t: Date.now(), sid: s.sid, ev: 'hold-conflict', taken }); return { code: 409, body: { error: '이미 다른 고객님께서 선택한 좌석입니다.', code: 'SEAT_TAKEN', taken } }; }
    const id = 'H' + crypto.randomBytes(5).toString('hex');
    const total = list.reduce((a, x) => a + x!.price, 0);
    list.forEach(x => { x!.status = 'held'; x!.holdId = id; });
    this.holds.set(id, { id, sid: s.sid, user: s.user ?? 'guest', showtimeId: s.showtimeId!, seatIds, total, expiresAt: Date.now() + this.cfg.holdTtlMs });
    s.holdId = id;
    this.log.push({ t: Date.now(), sid: s.sid, ev: 'hold', seatIds });
    return { code: 200, body: { holdId: id } };
  }

  pay(s: Session, holdId: string, idempotencyKey: string): { code: number; body: Record<string, unknown> } {
    const prev = this.orders.find(o => o.idempotencyKey === idempotencyKey);
    if (prev) { this.log.push({ t: Date.now(), sid: s.sid, ev: 'pay-duplicate-blocked' }); return { code: 200, body: { ...prev, duplicate: true } }; }
    const h = this.holds.get(holdId);
    if (!h || h.sid !== s.sid) return { code: 410, body: { error: '선점이 만료되었거나 유효하지 않습니다.' } };
    const map = this.seatMaps.get(h.showtimeId)!;
    h.seatIds.forEach(id => { const x = map.get(id)!; x.status = 'sold'; x.holdId = null; });
    this.holds.delete(h.id);
    s.holdId = null;
    const order: Order = { orderId: 'MOCK-' + crypto.randomBytes(4).toString('hex').toUpperCase(), user: h.user, showtimeId: h.showtimeId, seatIds: h.seatIds, total: h.total, paidAt: Date.now(), idempotencyKey };
    this.orders.push(order);
    s.orderId = order.orderId;
    this.log.push({ t: Date.now(), sid: s.sid, ev: 'paid', orderId: order.orderId });
    return { code: 200, body: { ...order } };
  }
}

const g = globalThis as unknown as { __mockStore?: MockStore };
export function mockStore(): MockStore { return (g.__mockStore ??= new MockStore()); }
