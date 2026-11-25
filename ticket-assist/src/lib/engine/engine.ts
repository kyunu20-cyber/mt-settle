// 공통 예매 보조 엔진: 사이트별 Adapter 를 구동하는 상태 흐름 + 제어(시작/일시정지/종료) + 사용자 확인
import path from 'node:path';
import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { BrowserManager } from './browser';
import { DialogGuard } from './dialogs';
import { FailureLog } from './failures';
import { Ledger, MinInterval, assertAllowedUrl, findSecretKeys } from './guards';
import { desktopNotify } from './notify';
import { sleep, syncClock, offsetFromDateHeader, syncByDateBoundary, waitUntil } from './timing';
import {
  DEFAULT_TIMEOUTS, TERMINAL_STAGES,
  type BookingConfig, type ConfirmDecision, type ConfirmRequest, type CountdownInfo, type EngineEvent, type EngineStatus,
  type EventLevel, type EventType, type RunResult, type Stage, type Timeouts,
} from './types';
import { resolveAdapter } from '../adapters/registry';
import type { AdapterContext, SiteAdapter, SiteStage } from '../adapters/types';
import { ScheduleNotFoundError } from '../adapters/types';
import { analyze } from '../seats/analyze';
import { HIGHLIGHT_JS } from '../seats/browserScripts';
import type { Recommendation, Seat, SeatAnalysis, SeatPrefs } from '../seats/types';
import { DEFAULT_WEIGHTS } from '../seats/types';

class StopSignal extends Error { constructor() { super('사용자가 종료함'); } }
class FailError extends Error { constructor(public reason: string, message: string) { super(message); } }

export const DATA_DIR = process.env.TICKET_ASSIST_DATA_DIR || path.join(process.cwd(), 'data');

const MAX_SEAT_ATTEMPTS = 6;
const MAX_RESCANS = 8;

export class BookingEngine {
  private events: EngineEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: EngineEvent) => void>();
  private stopped = false;
  private paused = false;
  private resumeGate: (() => void) | null = null;
  private pauseWait: Promise<void> | null = null;
  private confirmResolver: ((d: ConfirmDecision | 'stop' | 'timeout') => void) | null = null;
  private runPromise: Promise<void> | null = null;
  private page: Page | null = null;
  private adapter: SiteAdapter | null = null;
  private paymentSubmitted = false;
  private ledgerKey = '';

  readonly browser = new BrowserManager((connected, detail) => {
    this.status.browser = { connected, mode: this.browser?.mode ?? null, pages: this.browser?.pages().length ?? 0 };
    this.emit(connected ? 'info' : 'warn', 'browser', `브라우저 ${connected ? '연결됨' : '연결 끊김'}: ${detail}`, { connected });
    if (!connected && this.running && !this.stopped) this.notify('브라우저 연결 끊김', detail);
  });
  readonly ledger = new Ledger(path.join(DATA_DIR, 'ledger.json'));
  readonly failures = new FailureLog(DATA_DIR);
  readonly dialogs = new DialogGuard(ev => this.emit(ev.type === 'alert' ? 'warn' : 'info', 'log', `팝업[${ev.type}] "${ev.message}" → ${ev.decision === 'accept' ? '확인' : '취소'}`));

  status: EngineStatus = this.freshStatus();

  private freshStatus(): EngineStatus {
    return {
      running: false, paused: false, stage: 'idle', adapter: null,
      browser: { connected: this.browser?.connected ?? false, mode: this.browser?.mode ?? null, pages: 0 },
      countdown: null, queue: null, seats: null, seatPoints: null, pendingConfirm: null,
      network: { failures: 0, serverErrors: 0, last: null }, result: null, config: null, startedAt: null,
    };
  }

  get running() { return this.status.running; }

  // ---------------- 이벤트 ----------------
  subscribe(fn: (e: EngineEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  recentEvents(after = 0) { return this.events.filter(e => e.seq > after); }

  private emit(level: EventLevel, type: EventType, message: string, data?: unknown) {
    const e: EngineEvent = { seq: ++this.seq, t: Date.now(), level, type, message, data };
    this.events.push(e);
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
    for (const l of this.listeners) { try { l(e); } catch { /* ignore */ } }
  }
  private log(message: string, level: EventLevel = 'info') { this.emit(level, 'log', message); }

  private setStage(stage: Stage, message?: string) {
    if (this.status.stage === stage) { if (message) this.emit('info', 'log', message); return; }
    this.status.stage = stage;
    this.emit('info', 'stage', message ?? `단계: ${stage}`, { stage });
  }

  private notify(title: string, body: string) {
    this.emit('warn', 'notify', `${title} — ${body}`, { title, body });
    void desktopNotify(title, body, this.status.config?.notifications?.desktop ?? true);
  }

  // ---------------- 제어 ----------------
  async start(input: BookingConfig): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.running) return { ok: false, error: '이미 실행 중입니다.' };
    const secrets = findSecretKeys(input);
    if (secrets.length) return { ok: false, error: `비밀번호·결제정보는 설정에 넣을 수 없습니다 (평문 저장 금지): ${secrets.join(', ')}` };
    let cfg: BookingConfig, adapter: SiteAdapter;
    try {
      cfg = normalizeConfig(input);
      adapter = resolveAdapter(cfg.url, cfg.adapterId);
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (adapter.support.status === 'unsupported') return { ok: false, error: `${adapter.name}: ${adapter.support.reason}` };

    this.ledgerKey = Ledger.keyOf(adapter.id, cfg.url, cfg.performanceDate, cfg.performanceTime);
    const chk = this.ledger.check(this.ledgerKey);
    if (!chk.ok) return { ok: false, error: chk.reason };

    this.status = { ...this.freshStatus(), running: true, adapter: { id: adapter.id, name: adapter.name }, config: cfg, startedAt: Date.now() };
    this.stopped = false; this.paused = false; this.paymentSubmitted = false; this.browserRequired = false; this.adapter = adapter; this.page = null;
    this.dialogs.events = [];
    this.ledger.set(this.ledgerKey, 'in-progress');
    this.emit('info', 'status', `시작: ${adapter.name} · ${cfg.performanceDate} ${cfg.performanceTime} · ${cfg.quantity}매`);
    this.runPromise = this.run(cfg, adapter);
    return { ok: true };
  }

  pause() {
    if (!this.running || this.paused) return false;
    this.paused = true; this.status.paused = true;
    this.pauseWait = new Promise(r => { this.resumeGate = r; });
    this.emit('warn', 'status', '일시정지 — 다음 안전 지점에서 멈춥니다');
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false; this.status.paused = false;
    this.resumeGate?.(); this.resumeGate = null; this.pauseWait = null;
    this.emit('info', 'status', '재개');
    return true;
  }

  async stop() {
    if (!this.running) return false;
    this.stopped = true;
    this.resume();
    this.confirmResolver?.('stop');
    this.emit('warn', 'status', '종료 요청');
    await this.runPromise?.catch(() => {});
    return true;
  }

  respond(id: string, decision: ConfirmDecision) {
    const req = this.status.pendingConfirm;
    if (!req || req.id !== id || !this.confirmResolver) return false;
    this.confirmResolver(decision);
    return true;
  }

  async waitIdle() { await this.runPromise?.catch(() => {}); }

  private browserRequired = false;
  private async checkpoint() {
    if (this.stopped) throw new StopSignal();
    if (this.browserRequired && !this.browser.connected) throw new FailError('browser-closed', '브라우저 연결이 끊겼습니다 (사용자가 닫았거나 충돌)');
    if (this.pauseWait) { this.setStageNote('일시정지 중'); await this.pauseWait; }
    if (this.stopped) throw new StopSignal();
  }
  private setStageNote(msg: string) { this.emit('debug', 'log', msg); }

  private ctx(cfg: BookingConfig): AdapterContext {
    return {
      log: (m, l = 'info') => this.log(m, l),
      dialogs: this.dialogs,
      timeouts: { ...DEFAULT_TIMEOUTS, ...cfg.timeouts },
      sleep: async (ms) => { await this.checkpoint(); await sleep(ms); },
    };
  }

  // ---------------- 실행 ----------------
  private async run(cfg: BookingConfig, adapter: SiteAdapter) {
    const T: Timeouts = { ...DEFAULT_TIMEOUTS, ...cfg.timeouts };
    const ctx = this.ctx(cfg);
    let outcome: RunResult;
    try {
      outcome = await this.flow(cfg, adapter, T, ctx);
    } catch (err) {
      if (err instanceof StopSignal) {
        outcome = { outcome: 'stopped', reason: '사용자 종료', finishedAt: Date.now() };
        await this.safeRelease(adapter, ctx);
      } else {
        const reason = err instanceof FailError ? err.reason : classify(err as Error);
        const message = (err as Error).message;
        this.emit('error', 'log', `실패 [${reason}] ${message}`);
        const rec = await this.failures.record({ stage: this.status.stage, reason, message, url: this.page?.url(), adapter: adapter.id }, this.page);
        if (rec.screenshot) this.log(`실패 화면 저장: ${rec.screenshot}`, 'debug');
        this.notify('예매 실패', `${reason}: ${message}`);
        outcome = { outcome: 'failed', reason: `${reason}: ${message}`, finishedAt: Date.now() };
      }
    }
    if (outcome.outcome !== 'done' && outcome.outcome !== 'payment-handover') {
      const cur = this.ledger.get(this.ledgerKey);
      // 결제 요청 후 결과가 불확실하면 'held' 로 남겨 중복 예매를 막는다. 결제 요청 전이면 해제.
      if (cur?.status === 'in-progress' || (cur?.status === 'held' && !this.paymentSubmitted)) {
        this.ledger.set(this.ledgerKey, outcome.outcome === 'failed' ? 'failed' : 'cancelled', { note: outcome.reason });
      } else if (cur?.status === 'held' && this.paymentSubmitted) {
        this.emit('error', 'log', '결제 요청 후 결과를 확인하지 못했습니다. 사이트의 예매 내역을 직접 확인하세요 (장부는 held 로 유지되어 재시작이 차단됩니다).');
      }
    }
    this.status.result = outcome;
    this.status.pendingConfirm = null;
    const stage: Stage = outcome.outcome === 'payment-handover' ? 'payment-handover' : outcome.outcome;
    this.status.stage = stage;
    this.emit(outcome.outcome === 'done' ? 'success' : outcome.outcome === 'failed' ? 'error' : 'warn', 'result', `종료: ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ''}`, outcome);
    this.emit('info', 'stage', `단계: ${stage}`, { stage });
    this.status.running = false; this.status.paused = false; this.paused = false; this.browserRequired = false;
    await this.highlight(null);
  }

  private async flow(cfg: BookingConfig, adapter: SiteAdapter, T: Timeouts, ctx: AdapterContext): Promise<RunResult> {
    this.setStage('preflight');
    const target = assertAllowedUrl(cfg.url, adapter.hosts);
    const openAt = Date.parse(cfg.openAt);
    if (Number.isNaN(openAt)) throw new FailError('config', `오픈 시각 형식 오류: ${cfg.openAt}`);
    if (adapter.support.status === 'assist-only') this.log(`${adapter.name}: ${adapter.support.reason}`, 'warn');

    // 1. 브라우저 연결
    this.setStage('connecting');
    const context = await this.browser.connect(cfg.browser, target.origin).catch(e => { throw new FailError('browser', `브라우저 연결 실패: ${e.message}`); });
    context.on('page', p => {
      this.emit('info', 'browser', `신규 탭/팝업 감지: ${p.url() || '(로딩 중)'}`);
      this.watchPage(p, adapter);
      this.status.browser.pages = context.pages().length;
    });
    this.browserRequired = true;
    const existing = context.pages().find(p => p.url().startsWith(target.origin));
    const page = existing ?? (context.pages().find(p => p.url() === 'about:blank') || await context.newPage());
    this.page = page;
    this.watchPage(page, adapter);
    await this.gotoGuarded(page, target.href, adapter);
    this.status.browser.pages = context.pages().length;

    // 2. 로그인 세션 확인 (비밀번호는 다루지 않는다 — 로그인은 사용자가 브라우저에서 직접)
    if (adapter.support.status === 'full') await this.ensureLoggedIn(page, adapter, target.href, T);

    // 3. 서버 시각 동기화 + 카운트다운
    this.setStage('countdown');
    const siteOpenAt = adapter.readOpenTime ? await adapter.readOpenTime(page).catch(() => null) : null;
    if (siteOpenAt && Math.abs(siteOpenAt - openAt) > 1000) {
      this.log(`설정한 오픈 시각과 페이지에 표시된 오픈 시각이 다릅니다 (설정 ${new Date(openAt).toLocaleString('ko-KR')} / 페이지 ${new Date(siteOpenAt).toLocaleString('ko-KR')}). 설정값을 사용합니다.`, 'warn');
    }
    let clock = await this.syncSiteClock(page, adapter, target);
    const updateCountdown = () => {
      this.status.countdown = { openAt, offsetMs: clock.offsetMs, rttMs: clock.rttMs, source: clock.source, siteOpenAt };
      this.emit('info', 'countdown', `오픈 ${new Date(openAt).toLocaleString('ko-KR')} · 서버 오프셋 ${clock.offsetMs.toFixed(0)}ms (RTT ${clock.rttMs}ms, ${clock.source})`, this.status.countdown);
    };
    updateCountdown();
    if (openAt - (Date.now() + clock.offsetMs) > T.openWaitMs) throw new FailError('config', '오픈 시각이 너무 멉니다');

    const remain0 = openAt - (Date.now() + clock.offsetMs);
    const alerts = [60_000, 10_000].filter(a => a < remain0); // 이미 지난 임계값은 알리지 않음
    const onTick = (remain: number) => { while (alerts.length && remain <= alerts[0]) this.notify('예매 오픈 임박', `${alerts.shift()! / 1000}초 전입니다`); };
    if (openAt - (Date.now() + clock.offsetMs) > 25_000) {
      // 오래 기다렸다면 오픈 15초 전에 시각 재보정 + 세션 재확인
      await waitUntil(openAt - 15_000, clock.offsetMs, { checkpoint: () => this.checkpoint(), onTick });
      const c2 = await this.syncSiteClock(page, adapter, target).catch(() => null);
      if (c2) { clock = c2; updateCountdown(); }
      if (adapter.support.status === 'full' && (await adapter.detectSession(page)) === 'logged-out') await this.ensureLoggedIn(page, adapter, target.href, T);
      this.setStage('countdown');
    }
    await waitUntil(openAt - 150, clock.offsetMs, { checkpoint: () => this.checkpoint(), onTick });

    if (adapter.support.status === 'assist-only') {
      await waitUntil(openAt, clock.offsetMs, { checkpoint: () => this.checkpoint() });
      this.notify('예매 오픈', `${adapter.name} 예매가 열렸습니다. 브라우저에서 직접 진행하세요.`);
      await page.bringToFront().catch(() => {});
      return { outcome: 'payment-handover', reason: '보조 모드: 오픈 시각 알림 후 사용자에게 제어권 전달', finishedAt: Date.now() };
    }

    // 4. 예매 버튼 활성화 감지
    this.setStage('waiting-open');
    const reloads = new MinInterval(adapter.policy.minReloadIntervalMs);
    for (;;) {
      await this.checkpoint();
      const st = await adapter.isBookingOpen(page);
      if (st === 'enabled') break;
      if (Date.now() + clock.offsetMs < openAt) { await sleep(5); continue; }
      if (st === 'needs-reload') {
        if (reloads.count >= adapter.policy.maxReloadsAfterOpen) throw new FailError('open-timeout', '오픈 후에도 예매 버튼이 활성화되지 않음');
        await reloads.wait();
        this.log(`새로고침 (${reloads.count}) — 최소 간격 ${adapter.policy.minReloadIntervalMs}ms 준수`, 'debug');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(e => this.log(`새로고침 실패: ${e.message}`, 'warn'));
        continue;
      }
      if (Date.now() + clock.offsetMs > openAt + T.stepMs * 2) throw new FailError('open-timeout', '예매 버튼 활성화 대기 시간 초과');
      await sleep(20);
    }
    const lag = Date.now() + clock.offsetMs - openAt;
    this.emit('success', 'log', `예매 버튼 활성화 감지 (오픈 대비 ${lag >= 0 ? '+' : ''}${lag.toFixed(0)}ms, 새로고침 ${reloads.count}회)`, { lagMs: lag });

    // 5. 예매 진입 (팝업/신규 탭)
    this.setStage('entering');
    await this.checkpoint();
    const bp = await adapter.openBooking(page, ctx);
    if (bp !== page) this.watchPage(bp, adapter);
    this.page = bp;
    await bp.bringToFront().catch(() => {});

    // 6. 사이트 단계 루프
    return this.bookingLoop(bp, cfg, adapter, T, ctx);
  }

  private async bookingLoop(page: Page, cfg: BookingConfig, adapter: SiteAdapter, T: Timeouts, ctx: AdapterContext): Promise<RunResult> {
    const prefs: SeatPrefs = { quantity: cfg.quantity, sections: cfg.sections, grades: cfg.grades, weights: cfg.weights, allowSplit: cfg.allowSplit, maxPrice: cfg.maxPrice, exclude: [] };
    let lastStage: SiteStage | null = null, stageSince = Date.now(), seatAttempts = 0, rescans = 0, notOpenReloads = 0;
    const reloads = new MinInterval(adapter.policy.minReloadIntervalMs);

    for (;;) {
      await this.checkpoint();
      if (page.isClosed()) throw new FailError('popup-closed', '예매 창이 닫혔습니다');
      const st = await adapter.detectStage(page);
      if (st !== lastStage) { this.log(`사이트 화면: ${st}`, 'debug'); lastStage = st; stageSince = Date.now(); }

      switch (st) {
        case 'loading': case 'unknown':
          if (Date.now() - stageSince > T.stepMs) throw new FailError('unknown-page', `화면을 인식할 수 없습니다 (${page.url()})`);
          await sleep(100); break;

        case 'not-open':
          if (++notOpenReloads > adapter.policy.maxReloadsAfterOpen) throw new FailError('open-timeout', '예매 페이지가 열리지 않음');
          await reloads.wait();
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          break;

        case 'error':
          throw new FailError('site-error', '사이트 오류 화면');

        case 'login': {
          this.setStage('awaiting-login', '세션 만료/로그인 필요 → 사용자에게 제어권 전달');
          this.notify('로그인 필요', '세션이 만료되었습니다. 예매 창에서 다시 로그인해 주세요.');
          await page.bringToFront().catch(() => {});
          await this.waitStageChange(page, adapter, ['login'], T.humanMs, '로그인 대기 시간 초과');
          this.log('로그인 확인 — 자동 진행 재개', 'success');
          break;
        }

        case 'queue': {
          this.setStage('queue');
          const since = this.status.queue?.since ?? Date.now();
          let lastPos: number | null = -1;
          const end = Date.now() + T.queueMs;
          while ((await adapter.detectStage(page)) === 'queue') {
            await this.checkpoint();
            const q = adapter.queueStatus ? await adapter.queueStatus(page) : { position: null };
            this.status.queue = { position: q.position, since };
            if (q.position !== lastPos) { this.emit('info', 'queue', `대기열 순번: ${q.position ?? '알 수 없음'}`, this.status.queue); lastPos = q.position; }
            if (Date.now() > end) throw new FailError('queue-timeout', '대기열 대기 시간 초과');
            await sleep(500);
          }
          this.log(`대기열 통과 (${((Date.now() - since) / 1000).toFixed(1)}s)`, 'success');
          break;
        }

        case 'captcha': case 'identity': {
          const what = st === 'captcha' ? '보안문자(CAPTCHA)' : '본인인증';
          this.setStage('human-verification', `${what} 감지 → 사용자에게 제어권 전달 (자동 입력/우회하지 않음)`);
          this.notify(`${what} 입력 필요`, '예매 창에서 직접 입력해 주세요. 완료되면 자동으로 이어서 진행합니다.');
          await page.bringToFront().catch(() => {});
          await this.waitStageChange(page, adapter, [st], T.humanMs, `${what} 대기 시간 초과`);
          this.log(`${what} 완료 확인`, 'success');
          break;
        }

        case 'schedule':
          this.setStage('schedule', `관람일/회차 선택: ${cfg.performanceDate} ${cfg.performanceTime}`);
          try { await adapter.selectSchedule(page, { date: cfg.performanceDate, time: cfg.performanceTime }, ctx); }
          catch (e) { if (e instanceof ScheduleNotFoundError) throw new FailError('schedule-not-found', e.message); throw e; }
          await this.waitStageChange(page, adapter, ['schedule'], T.stepMs, '회차 선택 후 화면 전환 없음');
          break;

        case 'seats': {
          if (seatAttempts >= MAX_SEAT_ATTEMPTS) throw new FailError('seat-attempts', `좌석 선점 ${seatAttempts}회 실패`);
          this.setStage('seat-analysis');
          let map;
          try { map = await adapter.readSeatMap(page, ctx); }
          catch (e) {
            if (e instanceof StopSignal) throw e;
            this.emit('warn', 'network', `좌석 배치 읽기 실패: ${(e as Error).message} — 재시도`);
            if (++rescans > MAX_RESCANS) throw new FailError('seatmap-unavailable', '좌석 배치를 읽지 못했습니다');
            await sleep(1000); break;
          }
          const analysis = analyze(map, prefs, 5);
          this.status.seats = analysis;
          this.status.seatPoints = map.seats.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h), s: s.status === 'available' ? 'a' : s.status === 'unavailable' ? 'u' : '?' }));
          this.emit('info', 'seats', `좌석 분석(${analysis.renderMode}): 가능 ${analysis.available} / 불가 ${analysis.unavailable}${analysis.unknown ? ` / 미확인 ${analysis.unknown}` : ''} · 추천 ${analysis.recommendations.length}건${analysis.usedFallback ? ' (차선책)' : ''}`, summarizeAnalysis(analysis));
          const avail = map.seats.filter(s => s.status === 'available');
          await this.highlight(page, avail, analysis.recommendations[0]?.seats ?? [], `선택 가능 ${avail.length}석 · 추천 ${analysis.recommendations[0]?.seats.map(s => s.id).join(', ') ?? '없음'}`);
          if (!analysis.recommendations.length) {
            if (++rescans > MAX_RESCANS) throw new FailError('no-seats', `조건에 맞는 좌석 없음 (가능 ${analysis.available}석, ${cfg.quantity}매${cfg.allowSplit ? '' : ' 연석'})`);
            this.log(`조건에 맞는 좌석 없음 — 취소표 대기 후 재탐색 (${rescans}/${MAX_RESCANS})`, 'warn');
            await sleep(1500); break;
          }
          if (analysis.usedFallback) this.notify('선호 구역 좌석 없음', `차선책: ${analysis.recommendations[0].reason}`);

          // 사용자 확인
          this.setStage('awaiting-seat-confirm');
          this.notify('좌석 확인 필요', `${analysis.recommendations[0].seats.map(s => s.id).join(', ')} 외 ${analysis.recommendations.length - 1}건 — 대시보드에서 선택하세요`);
          const d = await this.askConfirm({ kind: 'seats', title: '좌석 선택 확인', message: '선택할 좌석을 고르세요. 승인하면 해당 좌석을 클릭하고 다음 단계로 진행합니다.', options: analysis.recommendations }, T.confirmMs, page);
          if (d === 'timeout' || !d.approve) {
            await this.highlight(null);
            return { outcome: 'cancelled', reason: d === 'timeout' ? '좌석 확인 응답 시간 초과' : '사용자가 좌석 선택을 거절', finishedAt: Date.now() };
          }
          const choice: Recommendation = analysis.recommendations[d.optionIndex ?? 0] ?? analysis.recommendations[0];

          // 확인 대기 중 상황이 바뀌었을 수 있으므로 재확인
          this.setStage('selecting-seats');
          const fresh = await adapter.readSeatMap(page, ctx);
          const gone = choice.seats.filter(s => fresh.seats.find(f => f.id === s.id)?.status !== 'available');
          if (gone.length) {
            this.notify('좌석 상태 변경', `${gone.map(s => s.id).join(', ')} 이(가) 확인 대기 중 판매되었습니다. 다시 분석합니다.`);
            prefs.exclude!.push(...gone.map(s => s.id)); seatAttempts++; break;
          }
          try { await adapter.selectSeats(page, choice.seats, ctx); }
          catch (e) {
            this.log(`좌석 클릭 실패: ${(e as Error).message}`, 'warn');
            prefs.exclude!.push(...choice.seats.map(s => s.id)); seatAttempts++;
            await reloads.wait(); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
          }
          await this.highlight(null);
          const r = await adapter.submitSeats(page, ctx);
          if (r.ok) { this.emit('success', 'log', `좌석 선점 성공: ${choice.seats.map(s => s.id).join(', ')}`); break; }
          seatAttempts++;
          if (r.reason === 'taken') { this.emit('warn', 'log', `좌석 경합 실패: ${r.message} → 해당 좌석 제외 후 재분석`); prefs.exclude!.push(...choice.seats.map(s => s.id)); }
          else if (r.reason === 'limit') throw new FailError('purchase-limit', r.message);
          else if (r.reason === 'network') { this.emit('warn', 'network', `선점 요청 실패: ${r.message} → ${seatAttempts}s 후 재시도`); await sleep(1000 * seatAttempts); }
          else if (r.reason !== 'session') throw new FailError('hold-failed', r.message);
          break;
        }

        case 'payment': {
          this.setStage('payment-review');
          const order = await adapter.readOrderSummary(page, ctx);
          this.ledger.set(this.ledgerKey, 'held', { note: `선점 ${order.holdId}` });
          this.emit('info', 'log', `선점 확인: ${order.seatIds.join(', ')} · ${order.total.toLocaleString('ko-KR')}원 · 남은 시간 ${order.expiresIn ?? '-'}`);

          if (!adapter.support.automatedPayment || !adapter.completePayment) {
            this.notify('결제 단계', '좌석이 선점되었습니다. 결제는 브라우저에서 직접 진행하세요.');
            await page.bringToFront().catch(() => {});
            return { outcome: 'payment-handover', reason: '결제는 사용자가 직접 진행', seats: order.seatIds, total: order.total, finishedAt: Date.now() };
          }

          this.setStage('awaiting-payment-confirm');
          this.notify('결제 확인 필요', `${order.seatIds.join(', ')} · ${order.total.toLocaleString('ko-KR')}원 — 대시보드에서 승인하세요`);
          const d = await this.askConfirm({ kind: 'payment', title: '최종 결제 확인', message: '아래 내용으로 결제합니다. 승인 전까지 결제는 진행되지 않습니다.', order }, T.confirmMs, page);
          if (d === 'timeout' || !d.approve) {
            this.log('결제 미승인 → 선점 좌석 반환', 'warn');
            await adapter.cancelHold(page, ctx).catch(e => this.log(`선점 취소 실패: ${e.message}`, 'error'));
            this.ledger.set(this.ledgerKey, 'cancelled', { note: d === 'timeout' ? 'confirm-timeout' : 'user-declined' });
            return { outcome: 'cancelled', reason: d === 'timeout' ? '결제 확인 응답 시간 초과' : '사용자가 결제를 거절', seats: order.seatIds, finishedAt: Date.now() };
          }
          // 중복 결제 방지: 엔진 내 1회 + 장부 확인
          if (this.paymentSubmitted || this.ledger.get(this.ledgerKey)?.status === 'completed') throw new FailError('duplicate-payment', '이미 결제를 요청했습니다 (중복 결제 차단)');
          this.paymentSubmitted = true;
          this.setStage('paying');
          let orderId: string;
          try { ({ orderId } = await adapter.completePayment(page, ctx)); }
          catch (e) {
            if (/만료/.test((e as Error).message)) { this.paymentSubmitted = false; throw new FailError('hold-expired', (e as Error).message); }
            throw e;
          }
          this.ledger.set(this.ledgerKey, 'completed', { orderId });
          this.notify('예매 완료', `주문번호 ${orderId}`);
          return { outcome: 'done', orderId, seats: order.seatIds, total: order.total, finishedAt: Date.now() };
        }

        case 'done':
          return { outcome: 'done', reason: '사이트에서 완료 화면 확인', finishedAt: Date.now() };
      }
    }
  }

  // ---------------- 보조 ----------------
  private async askConfirm(req: Omit<ConfirmRequest, 'id' | 'createdAt' | 'expiresAt'>, timeoutMs: number, page?: Page): Promise<ConfirmDecision | 'timeout'> {
    const full: ConfirmRequest = { ...req, id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + timeoutMs };
    this.status.pendingConfirm = full;
    this.emit('warn', 'confirm', `사용자 확인 요청: ${full.title}`, full);
    let timer: NodeJS.Timeout | undefined;
    let onClose: (() => void) | undefined;
    const d = await new Promise<ConfirmDecision | 'stop' | 'timeout' | 'closed'>(resolve => {
      this.confirmResolver = resolve;
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      if (page) { onClose = () => resolve('closed'); page.once('close', onClose); }
    }).finally(() => { clearTimeout(timer); if (page && onClose) page.off('close', onClose); this.confirmResolver = null; this.status.pendingConfirm = null; });
    if (d === 'stop') throw new StopSignal();
    if (d === 'closed') throw new FailError('popup-closed', '사용자 확인 대기 중 예매 창이 닫혔습니다');
    this.emit('info', 'confirm', d === 'timeout' ? '확인 응답 시간 초과' : d.approve ? `승인 (옵션 ${(d.optionIndex ?? 0) + 1})` : '거절', { id: full.id, decision: d });
    return d;
  }

  private async waitStageChange(page: Page, adapter: SiteAdapter, from: SiteStage[], timeout: number, msg: string) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await this.checkpoint();
      if (page.isClosed()) throw new FailError('popup-closed', '예매 창이 닫혔습니다');
      const st = await adapter.detectStage(page);
      if (!from.includes(st) && st !== 'loading') return st;
      await sleep(250);
    }
    throw new FailError('timeout', msg);
  }

  private async ensureLoggedIn(page: Page, adapter: SiteAdapter, url: string, T: Timeouts) {
    this.setStage('session-check');
    const s = await adapter.detectSession(page);
    if (s === 'logged-in') { this.log('로그인 세션 확인됨 (브라우저 프로필 세션 유지)', 'success'); return; }
    if (s === 'unknown') { this.log('로그인 상태를 확인할 수 없음 — 계속 진행', 'warn'); return; }
    this.setStage('awaiting-login', '로그인 필요 → 브라우저에서 직접 로그인해 주세요 (비밀번호는 이 프로그램에 저장되지 않음)');
    this.notify('로그인 필요', '열린 브라우저에서 예매 사이트에 로그인해 주세요.');
    await page.bringToFront().catch(() => {});
    const end = Date.now() + T.humanMs;
    while (Date.now() < end) {
      await this.checkpoint();
      await sleep(1000);
      if ((await adapter.detectSession(page)) === 'logged-in') {
        this.log('로그인 확인됨', 'success');
        if (!page.url().startsWith(url)) await this.gotoGuarded(page, url, adapter);
        return;
      }
    }
    throw new FailError('login-timeout', '로그인 대기 시간 초과');
  }

  private async syncSiteClock(page: Page, adapter: SiteAdapter, target: URL) {
    if (adapter.serverTime) {
      const r = await syncClock(() => adapter.serverTime!(page)).catch(() => null);
      if (r) return { ...r, source: 'site-time-api' };
    }
    // 대안: HTTP Date 헤더 (초 단위) — 초가 바뀌는 순간을 포착해 정밀도 향상
    const head = async () => {
      const t0 = Date.now();
      const res = await page.request.head(target.origin, { timeout: 5000 }).catch(() => null);
      return { date: res?.headers()['date'] ?? null, t0, t1: Date.now() };
    };
    const precise = await syncByDateBoundary(head);
    if (precise) return { ...precise, source: 'http-date-boundary' };
    const one = await head();
    if (one.date) return { ...offsetFromDateHeader(one.date, one.t0, one.t1), source: 'http-date-header' };
    this.log('서버 시각을 얻지 못해 로컬 시계를 사용합니다', 'warn');
    return { offsetMs: 0, rttMs: 0, source: 'local-clock' };
  }

  private async gotoGuarded(page: Page, url: string, adapter: SiteAdapter) {
    assertAllowedUrl(url, adapter.hosts);
    for (let i = 1; ; i++) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); break; }
      catch (e) {
        this.emit('warn', 'network', `페이지 열기 실패 (${i}/3): ${(e as Error).message.split('\n')[0]}`);
        if (i >= 3) throw new FailError('network', `페이지를 열 수 없습니다: ${url}`);
        await this.checkpoint(); await sleep(1000 * i);
      }
    }
    for (const o of adapter.overlays) {
      await page.addLocatorHandler(page.locator(o.locator), async (el) => {
        this.log(`레이어 팝업 감지: ${o.name} → 닫기`);
        await el.locator(o.close).click({ timeout: 2000 }).catch(() => {});
      }).catch(() => {});
    }
  }

  private watched = new WeakSet<Page>();
  private watchPage(page: Page, adapter: SiteAdapter) {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    this.dialogs.attach(page);
    adapter.attach?.(page, this.ctx(this.status.config!));
    page.on('requestfailed', req => {
      const f = req.failure()?.errorText ?? '';
      if (/ERR_ABORTED|cancelled/i.test(f)) return;
      this.status.network.failures++; this.status.network.last = `${f} ${req.url()}`;
      this.emit('warn', 'network', `네트워크 오류: ${f} (${shortUrl(req.url())})`);
    });
    page.on('response', res => {
      const s = res.status();
      if (s >= 500 || s === 429) {
        this.status.network.serverErrors++; this.status.network.last = `${s} ${res.url()}`;
        this.emit('warn', 'network', `서버 응답 ${s}${s === 429 ? ' (요청 제한)' : ''}: ${shortUrl(res.url())}`);
      }
    });
    page.on('pageerror', err => this.log(`페이지 스크립트 오류: ${err.message}`, 'debug'));
    page.on('crash', () => this.emit('error', 'browser', '페이지 충돌(crash)'));
    page.on('close', () => { if (this.running) this.emit('warn', 'browser', `탭 닫힘: ${shortUrl(page.url())}`); this.status.browser.pages = this.browser.pages().length; });
  }

  private async highlight(page: Page | null, avail: Seat[] = [], rec: Seat[] = [], label = '') {
    const p = page ?? this.page;
    if (!p || p.isClosed()) return;
    const arg = page ? { label, rects: [...avail.map(s => ({ x: s.x, y: s.y, w: s.w, h: s.h, kind: 'available' })), ...rec.map(s => ({ x: s.x, y: s.y, w: s.w, h: s.h, kind: 'recommended' }))] } : null;
    await p.evaluate(`(${HIGHLIGHT_JS})(${JSON.stringify(arg)})`).catch(() => {});
  }

  private async safeRelease(adapter: SiteAdapter, ctx: AdapterContext) {
    // 종료 시 선점이 남아 있으면 반환 (결제 전이라면)
    const p = this.page;
    if (!p || p.isClosed() || this.paymentSubmitted) return;
    if ((await adapter.detectStage(p).catch(() => 'unknown')) === 'payment') {
      this.log('종료 — 선점 좌석 반환', 'warn');
      const c = { ...ctx, sleep };
      await adapter.cancelHold(p, c).catch(() => {});
    }
  }
}

function shortUrl(u: string) { try { const x = new URL(u); return x.pathname + (x.search ? '?…' : ''); } catch { return u; } }

function classify(e: Error): string {
  const m = e.message;
  if (/Target page, context or browser has been closed|browser has disconnected/i.test(m)) return 'browser-closed';
  if (/net::|ERR_|ECONN|ETIMEDOUT/i.test(m)) return 'network';
  if (/Timeout/i.test(m)) return 'timeout';
  if (/지원되지 않음/.test(m)) return 'not-supported';
  return 'unexpected';
}

function summarizeAnalysis(a: SeatAnalysis) {
  return { ...a, recommendations: a.recommendations.map(r => ({ ...r, seats: r.seats.map(s => ({ id: s.id, section: s.section, row: s.row, number: s.number, grade: s.grade, price: s.price, x: s.x, y: s.y })) })) };
}

export function normalizeConfig(c: BookingConfig): BookingConfig {
  if (!c || typeof c.url !== 'string') throw new Error('예매 페이지 URL 이 필요합니다');
  new URL(c.url);
  const q = Number(c.quantity);
  if (!Number.isInteger(q) || q < 1 || q > 10) throw new Error('매수는 1~10 사이 정수여야 합니다');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.performanceDate ?? '')) throw new Error('공연 날짜 형식: YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(c.performanceTime ?? '')) throw new Error('회차 시간 형식: HH:mm');
  if (Number.isNaN(Date.parse(c.openAt))) throw new Error('오픈 시각 형식 오류');
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []);
  return {
    ...c, quantity: q, sections: list(c.sections), grades: list(c.grades),
    weights: { ...DEFAULT_WEIGHTS, ...(c.weights ?? {}) },
    allowSplit: !!c.allowSplit, maxPrice: c.maxPrice ? Number(c.maxPrice) : null,
    browser: { ...c.browser, mode: c.browser?.mode === 'cdp' ? 'cdp' : 'launch' },
    notifications: { desktop: c.notifications?.desktop ?? true },
  };
}

const g = globalThis as unknown as { __bookingEngine?: BookingEngine };
export function engine(): BookingEngine { return (g.__bookingEngine ??= new BookingEngine()); }

export { TERMINAL_STAGES };
export type { CountdownInfo };
