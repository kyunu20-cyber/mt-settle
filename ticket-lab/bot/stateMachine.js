// 예매 흐름 상태 머신: 허용된 전이만 가능, 이력·재시도 횟수 관리, 파일 영속화
import fs from 'node:fs';
import path from 'node:path';

export const S = Object.freeze({
  INIT: 'INIT',
  WAIT_OPEN: 'WAIT_OPEN',
  ENTERING: 'ENTERING',
  QUEUE: 'QUEUE',
  HUMAN_CAPTCHA: 'HUMAN_CAPTCHA',
  SELECT_SEATS: 'SELECT_SEATS',
  HOLDING: 'HOLDING',
  CHECKOUT: 'CHECKOUT',
  AWAIT_CONFIRM: 'AWAIT_CONFIRM',
  PAYING: 'PAYING',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

const after = [S.QUEUE, S.HUMAN_CAPTCHA, S.SELECT_SEATS, S.CHECKOUT];
export const TRANSITIONS = {
  [S.INIT]: [S.WAIT_OPEN, S.FAILED],
  [S.WAIT_OPEN]: [S.ENTERING, S.FAILED],
  [S.ENTERING]: [...after, S.WAIT_OPEN, S.FAILED],
  [S.QUEUE]: [S.HUMAN_CAPTCHA, S.SELECT_SEATS, S.CHECKOUT, S.WAIT_OPEN, S.FAILED],
  [S.HUMAN_CAPTCHA]: [S.SELECT_SEATS, S.CHECKOUT, S.HUMAN_CAPTCHA, S.FAILED],
  [S.SELECT_SEATS]: [S.HOLDING, S.SELECT_SEATS, S.QUEUE, S.HUMAN_CAPTCHA, S.FAILED],
  [S.HOLDING]: [S.CHECKOUT, S.SELECT_SEATS, S.FAILED],
  [S.CHECKOUT]: [S.AWAIT_CONFIRM, S.SELECT_SEATS, S.FAILED],
  [S.AWAIT_CONFIRM]: [S.PAYING, S.CANCELLED, S.FAILED],
  [S.PAYING]: [S.DONE, S.FAILED],
  [S.DONE]: [],
  [S.CANCELLED]: [],
  [S.FAILED]: [],
};

export const TERMINAL = new Set([S.DONE, S.CANCELLED, S.FAILED]);

export class StateMachine {
  constructor({ file = null, now = Date.now, onChange = null } = {}) {
    this.state = S.INIT;
    this.history = [{ state: S.INIT, at: now(), info: null }];
    this.visits = { [S.INIT]: 1 };
    this.data = {};
    this.file = file;
    this.now = now;
    this.onChange = onChange;
    this.persist();
  }

  can(next) { return (TRANSITIONS[this.state] || []).includes(next); }

  to(next, info = null) {
    if (!this.can(next)) throw new Error(`잘못된 상태 전이: ${this.state} → ${next}`);
    const prev = this.state;
    this.state = next;
    this.visits[next] = (this.visits[next] || 0) + 1;
    this.history.push({ state: next, at: this.now(), info });
    this.persist();
    this.onChange?.(prev, next, info);
    return this;
  }

  /** 실패 처리는 어떤 비종료 상태에서도 가능 */
  fail(reason) {
    if (TERMINAL.has(this.state)) return this;
    return this.to(S.FAILED, { reason });
  }

  get done() { return TERMINAL.has(this.state); }

  set(patch) { Object.assign(this.data, patch); this.persist(); return this; }

  snapshot() { return { state: this.state, data: this.data, visits: this.visits, history: this.history }; }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
    fs.renameSync(tmp, this.file);
  }

  static load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
}
