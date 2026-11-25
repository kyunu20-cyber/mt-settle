// 모의 예매 사이트 자동화 봇 (Playwright)
// 화면 상태(body[data-page])를 관찰해 상태 머신을 구동한다.
// 대기열은 기다리고, CAPTCHA 는 사람에게 넘기며, 결제는 반드시 사용자 확인을 거친다.
import { chromium } from 'playwright';
import { StateMachine, S } from './stateMachine.js';
import { pickSeats } from './seatFinder.js';
import { syncClock, waitUntilServerTime, defaultSleep as sleep } from './timeSync.js';
import { assertAllowedTarget, MinInterval } from './safety.js';
import { DialogGuard, installOverlayHandlers } from './popupGuard.js';
import { createLogger } from './logger.js';

const PAGE_TO_STATE = { queue: S.QUEUE, captcha: S.HUMAN_CAPTCHA, seats: S.SELECT_SEATS, checkout: S.CHECKOUT };

export const DEFAULTS = {
  count: 2,
  prefs: { sections: [], maxPricePerSeat: null, maxRow: null, allowSplit: false },
  headless: true,
  allowHosts: [],
  leadMs: 150,               // 오픈 시각 이 정도 전에 깨어나 준비
  minReloadIntervalMs: 400,  // 새로고침 최소 간격 (서버 부담/차단 방지)
  maxReloadsAfterOpen: 40,
  reloadDecisionMs: 1000,   // 오픈 후 버튼 자동 활성/새로고침 안내를 기다리는 최대 시간
  maxSelectAttempts: 6,      // 좌석 선택→선점 재시도 상한
  seatRescanMs: 1000,
  maxSeatRescans: 5,
  timeouts: { openWaitMs: 15 * 60_000, queueMs: 10 * 60_000, humanMs: 5 * 60_000, confirmMs: 3 * 60_000, stepMs: 15_000 },
  stateFile: null,
  // 사용자 확인 훅: (summary) => Promise<boolean>. 지정하지 않으면 결제는 절대 진행하지 않는다.
  confirmPurchase: null,
  // 사람 개입 훅: ({ kind, page, message }) => Promise<void>. 반환 후 봇은 화면 변화를 기다린다.
  humanHandoff: null,
};

export class TicketBot {
  constructor(options) {
    this.o = { ...DEFAULTS, ...options, prefs: { ...DEFAULTS.prefs, ...options.prefs }, timeouts: { ...DEFAULTS.timeouts, ...options.timeouts } };
    if (!this.o.url) throw new Error('url is required');
    this.target = assertAllowedTarget(this.o.url, this.o.allowHosts);
    this.log = this.o.logger || createLogger({ quiet: this.o.quiet });
    this.sm = new StateMachine({ file: this.o.stateFile, onChange: (a, b, info) => this.log.state(a, b, info) });
    this.dialogs = new DialogGuard({ logger: this.log });
    this.overlayStats = {};
    this.reloads = new MinInterval(this.o.minReloadIntervalMs);
    this.exclude = new Set();
    this.metrics = {};
  }

  async run() {
    const ownBrowser = !this.o.browser;
    const browser = this.o.browser || await chromium.launch({ headless: this.o.headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      context.on('page', p => this.dialogs.attach(p));
      this.page = await context.newPage();
      this.context = context;
      await this.loop();
    } catch (err) {
      this.log.error(err.stack || String(err));
      this.sm.fail(String(err.message || err));
    } finally {
      if (!this.o.keepOpen) {
        await context.close().catch(() => {});
        if (ownBrowser) await browser.close().catch(() => {});
      }
    }
    return this.result();
  }

  result() {
    return {
      status: this.sm.state,
      ...this.sm.data,
      metrics: this.metrics,
      overlaysClosed: this.overlayStats,
      dialogs: this.dialogs.events.map(({ type, message, decision }) => ({ type, message, decision })),
      history: this.sm.history.map(h => h.state),
    };
  }

  // ---------- 메인 루프 ----------
  async loop() {
    this.sm.to(S.WAIT_OPEN);
    await this.waitForOpen();
    while (!this.sm.done) {
      switch (this.sm.state) {
        case S.WAIT_OPEN: await this.waitForOpen(); break;
        case S.ENTERING: await this.enter(); break;
        case S.QUEUE: await this.waitQueue(); break;
        case S.HUMAN_CAPTCHA: await this.handOffCaptcha(); break;
        case S.SELECT_SEATS: await this.selectSeats(); break;
        case S.CHECKOUT: await this.checkout(); break;
        default: throw new Error(`처리기 없는 상태: ${this.sm.state}`);
      }
    }
  }

  /** 현재 화면 식별 (내비게이션 중이면 null) */
  async pageKind(page = this.page) {
    try { return await page.evaluate(() => document.body?.dataset.page || null); } catch { return null; }
  }

  async waitPageChange(from, timeout, page = this.page) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const k = await this.pageKind(page);
      if (k && k !== from) return k;
      await sleep(100);
    }
    throw new Error(`화면 전환 대기 시간 초과 (현재: ${from})`);
  }

  async waitPageKind(timeout = this.o.timeouts.stepMs, page = this.page) {
    return this.waitPageChange(null, timeout, page);
  }

  goToState(kind) {
    const next = PAGE_TO_STATE[kind];
    if (!next) throw new Error(`예상치 못한 화면: ${kind}`);
    if (next === this.sm.state) return;
    this.sm.to(next);
  }

  // ---------- 1. 예매 시간 감지 ----------
  async waitForOpen() {
    const page = this.page;
    if (!page.url().startsWith(this.target.origin)) {
      await page.goto(this.target.href, { waitUntil: 'domcontentloaded' });
      await installOverlayHandlers(page, { logger: this.log, stats: this.overlayStats });
    }
    await page.locator('#open-at[data-open-at]').waitFor({ state: 'attached', timeout: this.o.timeouts.stepMs });
    const openAt = Number(await page.locator('#open-at').getAttribute('data-open-at'));

    const clock = await syncClock(() => page.evaluate(async () => (await (await fetch('/api/time', { cache: 'no-store' })).json()).now));
    this.metrics.clock = clock;
    this.sm.set({ openAt });
    const remain = openAt - (Date.now() + clock.offset);
    this.log.info(`오픈 시각 ${new Date(openAt).toISOString()} · 서버 오프셋 ${clock.offset.toFixed(1)}ms (RTT ${clock.rtt}ms) · 남은 시간 ${Math.max(0, remain)}ms`);
    if (remain > this.o.timeouts.openWaitMs) throw new Error('오픈까지 대기 한도를 초과합니다');

    let lastLog = 0;
    await waitUntilServerTime(openAt - this.o.leadMs, clock.offset, {
      onTick: (ms) => { if (Date.now() - lastLog > 5000) { lastLog = Date.now(); this.log.info(`오픈까지 ${(ms / 1000).toFixed(1)}s`); } },
    });

    // 오픈 직후: 버튼 활성 확인. 새로고침이 필요한 사이트면 최소 간격을 지키며 새로고침
    const btn = page.locator('#book-btn');
    for (let i = 0; ; i++) {
      if (await btn.isEnabled().catch(() => false)) break;
      if (Date.now() + clock.offset < openAt) { await sleep(5); continue; }
      if (i > this.o.maxReloadsAfterOpen) throw new Error('오픈 후에도 예매 버튼이 활성화되지 않음');
      // 페이지가 스스로 버튼을 켜는지, '새로고침 필요' 안내를 띄우는지 잠깐 관찰 후 결정
      const verdict = await page.waitForFunction(() => {
        const b = document.querySelector('#book-btn'), h = document.querySelector('#reload-hint');
        return b && !b.disabled ? 'enabled' : h && !h.hidden ? 'reload' : false;
      }, null, { timeout: this.o.reloadDecisionMs, polling: 20 }).then(h => h.jsonValue()).catch(() => 'reload');
      if (verdict === 'enabled') break;
      await this.reloads.wait();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await btn.waitFor({ state: 'attached' });
    }
    this.metrics.buttonEnabledLagMs = Date.now() + clock.offset - openAt;
    this.metrics.reloads = this.reloads.count;
    this.log.info(`예매 버튼 활성 감지 (오픈 대비 +${this.metrics.buttonEnabledLagMs.toFixed(0)}ms, 새로고침 ${this.reloads.count}회)`);
    this.sm.to(S.ENTERING);
  }

  // ---------- 2. 예매 진입 (새 창 팝업 처리) ----------
  async enter() {
    const main = this.page;
    const popupP = main.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await main.locator('#book-btn').click();
    const popup = await popupP;
    if (popup) {
      this.log.info('예매 새 창 감지 → 전환');
      this.page = popup;
      this.mainPage = main;
      await installOverlayHandlers(popup, { logger: this.log, stats: this.overlayStats });
    }
    let kind = await this.waitPageKind();
    if (kind === 'booking') {
      kind = await this.waitPageChange('booking', this.o.timeouts.stepMs).catch(async () => {
        const msg = await this.page.locator('#booking-msg').textContent().catch(() => '');
        throw new Error(`예매 진입 실패: ${msg}`);
      });
    }
    this.metrics.enteredAt = Date.now();
    this.goToState(kind);
  }

  // ---------- 3. 대기열: 기다리기만 한다(우회 없음) ----------
  async waitQueue() {
    const start = Date.now();
    let lastPos = null;
    const end = start + this.o.timeouts.queueMs;
    for (;;) {
      const kind = await this.pageKind();
      if (kind && kind !== 'queue') break;
      const pos = await this.page.locator('#queue-position').textContent().catch(() => null);
      if (pos !== lastPos) { this.log.info(`대기열 순번: ${pos}`); lastPos = pos; }
      if (Date.now() > end) throw new Error('대기열 대기 시간 초과');
      await sleep(500);
    }
    this.metrics.queueWaitMs = Date.now() - start;
    this.goToState(await this.waitPageKind());
  }

  // ---------- 4. CAPTCHA: 사람에게 넘긴다 ----------
  async handOffCaptcha() {
    const msg = '보안문자(CAPTCHA) 화면입니다. 자동화는 이를 풀지 않습니다. 브라우저 창에서 직접 입력해 주세요.';
    this.log.warn(msg);
    const start = Date.now();
    if (this.o.humanHandoff) await this.o.humanHandoff({ kind: 'captcha', page: this.page, message: msg });
    else if (this.o.headless) throw new Error('CAPTCHA 는 사람이 입력해야 합니다. --headed 로 실행하세요.');
    const kind = await this.waitPageChange('captcha', this.o.timeouts.humanMs);
    this.metrics.humanWaitMs = Date.now() - start;
    this.goToState(kind);
  }

  // ---------- 5. 좌석 탐색 · 연석 판단 · 선점 ----------
  async readSeats() {
    await this.page.locator('#seat-map .seat').first().waitFor({ timeout: this.o.timeouts.stepMs });
    return this.page.$$eval('#seat-map .seat', els => els.map(e => ({
      id: e.dataset.seatId, section: e.dataset.section, row: +e.dataset.row, number: +e.dataset.number,
      grade: e.dataset.grade, price: +e.dataset.price, status: e.dataset.status, aisleAfter: e.dataset.aisleAfter === 'true',
    })));
  }

  async selectSeats() {
    const attempts = this.sm.visits[S.SELECT_SEATS];
    if (attempts > this.o.maxSelectAttempts) throw new Error(`좌석 선점 재시도 한도 초과 (${this.o.maxSelectAttempts})`);
    const kind = await this.pageKind();
    if (kind !== 'seats') return this.goToState(await this.waitPageKind());

    let choice = null;
    for (let scan = 0; scan <= this.o.maxSeatRescans; scan++) {
      const seats = await this.readSeats();
      choice = pickSeats(seats, this.o.count, { ...this.o.prefs, exclude: this.exclude });
      if (choice) break;
      this.log.warn(`조건에 맞는 좌석 없음 (스캔 ${scan + 1}) — 취소표 대기 후 재탐색`);
      await sleep(this.o.seatRescanMs);
    }
    if (!choice) throw new Error('조건에 맞는 좌석을 찾지 못했습니다');
    const ids = choice.seats.map(s => s.id);
    this.log.info(`후보 좌석: ${ids.join(', ')} (연석=${choice.contiguous}, 점수=${choice.score.toFixed(1)})`);
    this.sm.set({ candidate: ids, contiguous: choice.contiguous });

    for (const id of ids) {
      const b = this.page.locator(`#seat-map .seat[data-seat-id="${id}"]`);
      await b.click({ timeout: 3000 }).catch(() => {});
    }
    // 선택 결과 검증: 클릭 도중 다른 사용자가 가져가면 선택이 빠진다
    const selected = await this.page.$$eval('#seat-map .seat[aria-pressed="true"]', els => els.map(e => e.dataset.seatId));
    if (selected.length !== ids.length || !ids.every(i => selected.includes(i))) {
      this.log.warn(`선택 불일치 (기대 ${ids.length}, 실제 ${selected.length}) — 재탐색`);
      ids.filter(i => !selected.includes(i)).forEach(i => this.exclude.add(i));
      await this.reloads.wait();
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      return this.sm.to(S.SELECT_SEATS, { reason: 'selection-mismatch' });
    }

    this.sm.to(S.HOLDING, { seats: ids });
    const since = Date.now();
    await this.page.locator('#hold-btn').click();
    const outcome = await Promise.race([
      this.page.waitForURL(/checkout\.html/, { timeout: this.o.timeouts.stepMs }).then(() => 'ok'),
      this.dialogs.waitFor(e => e.type === 'alert', { since, timeout: this.o.timeouts.stepMs }).then(e => e),
    ]);
    if (outcome === 'ok') {
      this.sm.set({ heldSeats: ids });
      return this.sm.to(S.CHECKOUT);
    }
    this.log.warn(`선점 실패: "${outcome.message}" → 해당 좌석 제외 후 재시도`);
    ids.forEach(i => this.exclude.add(i));
    await this.page.locator('#seat-map .seat').first().waitFor();
    return this.sm.to(S.SELECT_SEATS, { reason: 'hold-conflict', message: outcome.message });
  }

  // ---------- 6. 결제 전 사용자 확인 ----------
  async checkout() {
    const page = this.page;
    await page.locator('#hold-summary[data-hold-id], #hold-summary .error').first().waitFor({ timeout: this.o.timeouts.stepMs });
    if (!(await page.locator('#hold-summary[data-hold-id]').count())) {
      await page.goto(new URL('/seats.html', this.target).href);
      return this.sm.to(S.SELECT_SEATS, { reason: 'hold-missing' });
    }
    const summary = {
      holdId: await page.locator('#hold-summary').getAttribute('data-hold-id'),
      seatIds: (await page.locator('#hold-summary').getAttribute('data-seat-ids')).split(','),
      total: Number(await page.locator('#hold-summary').getAttribute('data-total')),
      text: (await page.locator('#hold-summary').innerText()).trim(),
      expiresIn: (await page.locator('#hold-timer').textContent()).trim(),
    };
    this.sm.set({ holdId: summary.holdId, total: summary.total });
    this.sm.to(S.AWAIT_CONFIRM, { holdId: summary.holdId });

    let approved = false;
    if (typeof this.o.confirmPurchase === 'function') {
      let timer;
      approved = await Promise.race([
        Promise.resolve(this.o.confirmPurchase(summary)).then(v => v === true),
        new Promise(r => { timer = setTimeout(() => { this.log.warn('사용자 확인 응답 없음 → 결제하지 않음'); r(false); }, this.o.timeouts.confirmMs); }),
      ]).finally(() => clearTimeout(timer));
    } else {
      this.log.warn('confirmPurchase 훅이 없어 결제를 진행하지 않습니다.');
    }

    if (!approved) {
      this.log.info('사용자가 결제를 승인하지 않음 → 선점 좌석 반환');
      this.dialogs.intent.cancel = true;
      await page.locator('#cancel-btn').click();
      await page.waitForURL(/seats\.html/, { timeout: this.o.timeouts.stepMs }).catch(() => {});
      this.dialogs.intent.cancel = false;
      return this.sm.to(S.CANCELLED, { reason: 'user-declined' });
    }

    this.sm.to(S.PAYING);
    await page.locator('#agree').check();
    await page.locator('#pay-btn').click();
    await page.waitForURL(/done\.html/, { timeout: this.o.timeouts.stepMs });
    await page.locator('#order-id').filter({ hasText: /ORD-/ }).waitFor();
    const orderId = (await page.locator('#order-id').textContent()).trim();
    this.sm.set({ orderId });
    this.sm.to(S.DONE, { orderId });
  }
}
