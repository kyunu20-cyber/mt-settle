// 모의 예매 사이트 Adapter — 이 저장소의 /mock 사이트 구조(직접 만든 것이므로 셀렉터가 검증됨)에 맞춘 구현
import type { Page } from 'playwright';
import type { AdapterContext, SiteAdapter, SiteStage, SubmitResult } from './types';
import { ScheduleNotFoundError } from './types';
import type { Seat, SeatMap } from '../seats/types';
import {
  EXTRACT_ELEMENTS_JS, SAMPLE_CANVAS_JS, DETECT_CANVAS_BLOBS_JS,
  type ElementExtractResult, type ElementSeatSpec, type CanvasSampleResult, type CanvasBlob,
} from '../seats/browserScripts';

const DOM_SPEC: ElementSeatSpec = {
  container: '#mock-seatmap-dom', seat: '.mock-seat',
  attrs: { id: 'data-seat-id', section: 'data-section', grade: 'data-grade', row: 'data-row', number: 'data-number', price: 'data-price' },
  available: { selector: '.is-available' }, unavailable: { selector: '.is-sold' }, stage: '#mock-stage',
};
const SVG_SPEC: ElementSeatSpec = {
  container: '#mock-seatmap-svg', seat: '.mock-svg-seat',
  attrs: { id: 'data-seat', row: 'data-row', number: 'data-no' },
  sectionFromAncestor: { selector: 'g[data-section]', attr: 'data-section' },
  gradeFromAncestor: { selector: 'g[data-grade]', attr: 'data-grade' },
  available: { fills: ['rgb(34, 197, 94)', '#22c55e'] }, unavailable: { fills: ['rgb(156, 163, 175)', '#9ca3af'] }, stage: '#mock-stage-svg',
};
const PALETTE = { available: [[34, 197, 94]], unavailable: [[156, 163, 175]] };

interface SeatsJson { seats: { id: string; section: string; grade: string; price: number; row: number; number: number; x: number; y: number; w: number; h: number; status: string }[]; canvas: { width: number; height: number; stage: { x: number; y: number; w: number; h: number } } }

const lastSeatsJson = new WeakMap<Page, SeatsJson>();

const stageOf = (page: Page) => page.evaluate(() => (document.querySelector('[data-mock-stage]') as HTMLElement | null)?.dataset.mockStage ?? null).catch(() => null);

async function renderModeOf(page: Page, timeout: number): Promise<'dom' | 'svg' | 'canvas'> {
  const loc = page.locator('#mock-seatmap-dom, #mock-seatmap-svg, #mock-seatmap-canvas').first();
  await loc.waitFor({ state: 'attached', timeout });
  const id = await loc.getAttribute('id');
  return id === 'mock-seatmap-svg' ? 'svg' : id === 'mock-seatmap-canvas' ? 'canvas' : 'dom';
}

async function readCanvas(page: Page, ctx: AdapterContext): Promise<SeatMap> {
  // 1) 좌석 의미 정보(구역/열/번호/좌표)는 페이지가 받은 좌석 JSON 응답을 가로채서 얻는다
  const end = Date.now() + ctx.timeouts.stepMs;
  while (!lastSeatsJson.get(page) && Date.now() < end) await ctx.sleep(100);
  const json = lastSeatsJson.get(page);
  if (!json) throw new Error('캔버스 좌석 데이터(네트워크 응답)를 받지 못했습니다');
  await page.locator('#mock-seatmap-canvas').scrollIntoViewIfNeeded();
  // 2) 상태는 실제로 그려진 픽셀 색으로 판정 (화면에 보이는 그대로)
  const sample = await page.evaluate(`(${SAMPLE_CANVAS_JS})(${JSON.stringify({
    canvas: '#mock-seatmap-canvas', palette: PALETTE,
    points: json.seats.map(s => ({ id: s.id, cx: s.x, cy: s.y, w: s.w, h: s.h })),
  })})`) as CanvasSampleResult;
  const blobs = await page.evaluate(`(${DETECT_CANVAS_BLOBS_JS})(${JSON.stringify({ canvas: '#mock-seatmap-canvas', palette: PALETTE, minArea: 30 })})`) as CanvasBlob[];
  const byId = new Map(sample.results.map(r => [r.id, r]));
  let mismatch = 0;
  const seats: Seat[] = json.seats.map(s => {
    const px = byId.get(s.id)!;
    const jsonStatus = s.status === 'available' ? 'available' : 'unavailable';
    if (px.status !== 'unknown' && px.status !== jsonStatus) mismatch++;
    // 보수적으로: 둘 중 하나라도 불가면 불가
    const status = px.status === 'unknown' ? 'unknown' : px.status === 'available' && jsonStatus === 'available' ? 'available' : 'unavailable';
    return { id: s.id, section: s.section, grade: s.grade, price: s.price, row: String(s.row), number: s.number, x: px.x, y: px.y, w: px.w, h: px.h, status };
  });
  const sc = sample.scale, st = json.canvas.stage, r = sample.rect;
  const left = r.x - r.w / 2, top = r.y - r.h / 2;
  return {
    renderMode: 'canvas', seats, bounds: sample.rect,
    stage: { x: left + st.x * sc, y: top + st.y * sc, w: st.w * sc, h: st.h * sc },
    notes: [
      `canvas 픽셀 블롭 ${blobs.length}개 (가능 ${blobs.filter(b => b.cls === 'available').length} / 불가 ${blobs.filter(b => b.cls === 'unavailable').length})`,
      `네트워크 좌석 데이터 ${json.seats.length}석, 픽셀-데이터 불일치 ${mismatch}석`,
    ],
  };
}

export const mockAdapter: SiteAdapter = {
  id: 'mock',
  name: '모의 예매 사이트 (로컬)',
  hosts: ['localhost', '127.0.0.1'],
  matches: (u) => ['localhost', '127.0.0.1'].includes(u.hostname) && u.pathname.startsWith('/mock'),
  support: { status: 'full', verified: { at: '2026-11-25', by: '이 저장소의 /mock 구현' }, automatedPayment: true },
  policy: { minReloadIntervalMs: 500, maxReloadsAfterOpen: 30 },
  overlays: [{ name: '공지 모달', locator: '#mock-notice', close: '#mock-notice-close' }],

  attach(page) {
    page.on('response', async (res) => {
      if (res.url().includes('/api/mock/seats') && res.ok()) {
        const j = await res.json().catch(() => null);
        if (j) lastSeatsJson.set(page, j as SeatsJson);
      }
    });
  },

  async serverTime(page) {
    return page.evaluate(async () => (await (await fetch('/api/mock/time', { cache: 'no-store' })).json()).now as number);
  },

  async readOpenTime(page) {
    const v = await page.locator('#mock-open-at').getAttribute('data-open-at', { timeout: 10_000 }).catch(() => null);
    return v ? Number(v) : null;
  },

  async detectSession(page) {
    if (/\/mock\/login/.test(page.url())) return 'logged-out';
    const user = await page.evaluate(async () => {
      const r = await fetch('/api/mock/event', { cache: 'no-store' });
      return r.ok ? ((await r.json()).user as string | null) : undefined;
    }).catch(() => undefined);
    return user === undefined ? 'unknown' : user ? 'logged-in' : 'logged-out';
  },

  async isBookingOpen(page) {
    return page.evaluate(() => {
      const b = document.querySelector('#mock-book-btn') as HTMLButtonElement | null;
      if (b && !b.disabled) return 'enabled' as const;
      if (document.querySelector('#mock-reload-hint')) return 'needs-reload' as const;
      return 'waiting' as const;
    }).catch(() => 'waiting' as const);
  },

  async openBooking(page, ctx) {
    const popup = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await page.locator('#mock-book-btn').click();
    const p = await popup;
    if (p) { ctx.log('신규 탭(예매 창) 감지 → 전환'); await p.waitForLoadState('domcontentloaded'); return p; }
    await page.waitForURL(/\/mock\/booking/, { timeout: ctx.timeouts.stepMs });
    return page;
  },

  async detectStage(page) {
    const s = await stageOf(page);
    const map: Record<string, SiteStage> = {
      loading: 'loading', enter: 'loading', 'not-open': 'not-open', 'login-required': 'login', login: 'login', queue: 'queue',
      captcha: 'captcha', identity: 'identity', schedule: 'schedule', seats: 'seats', payment: 'payment', done: 'done', error: 'error', event: 'unknown',
    };
    return s ? map[s] ?? 'unknown' : 'loading';
  },

  async queueStatus(page) {
    const t = await page.locator('#mock-queue-position').textContent({ timeout: 1000 }).catch(() => null);
    return { position: t != null && /^\d+$/.test(t.trim()) ? Number(t) : null };
  },

  async selectSchedule(page, { date, time }, ctx) {
    const d = page.locator(`.mock-date[data-date="${date}"]`);
    if (!(await d.count())) {
      const dates = await page.locator('.mock-date').evaluateAll(els => els.map(e => e.getAttribute('data-date')));
      throw new ScheduleNotFoundError(`관람일 ${date} 없음 (가능: ${dates.join(', ')})`);
    }
    await d.click();
    const t = page.locator(`.mock-time[data-time="${time}"]`);
    await page.locator('.mock-time').first().waitFor({ timeout: ctx.timeouts.stepMs });
    if (!(await t.count())) {
      const times = await page.locator('.mock-time').evaluateAll(els => els.map(e => e.getAttribute('data-time')));
      throw new ScheduleNotFoundError(`${date} 의 회차 ${time} 없음 (가능: ${times.join(', ')})`);
    }
    await t.click();
    await page.locator('#mock-schedule-next').click();
  },

  async readSeatMap(page, ctx) {
    const mode = await renderModeOf(page, ctx.timeouts.stepMs);
    if (mode === 'canvas') return readCanvas(page, ctx);
    const spec = mode === 'svg' ? SVG_SPEC : DOM_SPEC;
    await page.locator(`${spec.container} ${spec.seat}`).first().waitFor({ state: 'attached', timeout: ctx.timeouts.stepMs });
    const r = await page.evaluate(`(${EXTRACT_ELEMENTS_JS})(${JSON.stringify(spec)})`) as ElementExtractResult;
    return { renderMode: mode, seats: r.seats as Seat[], stage: r.stage, bounds: r.bounds, notes: [`${mode} 요소 ${r.seats.length}개 분석`] };
  },

  async selectSeats(page, seats, ctx) {
    const mode = await renderModeOf(page, ctx.timeouts.stepMs);
    for (const s of seats) {
      if (mode === 'dom') await page.locator(`.mock-seat[data-seat-id="${s.id}"]`).click({ timeout: 3000 });
      else if (mode === 'svg') await page.locator(`.mock-svg-seat[data-seat="${s.id}"]`).click({ timeout: 3000 });
      else {
        // 캔버스는 좌표 클릭: 최신 위치를 다시 계산
        const json = lastSeatsJson.get(page)!;
        const seat = json.seats.find(x => x.id === s.id)!;
        const r = await page.evaluate(`(${SAMPLE_CANVAS_JS})(${JSON.stringify({ canvas: '#mock-seatmap-canvas', palette: PALETTE, points: [{ id: s.id, cx: seat.x, cy: seat.y, w: seat.w, h: seat.h }] })})`) as CanvasSampleResult;
        await page.mouse.click(r.results[0].x, r.results[0].y);
      }
    }
    const count = Number(await page.locator('#mock-selected-count').textContent());
    if (count !== seats.length) throw new Error(`선택 불일치: 기대 ${seats.length}매, 실제 ${count}매 (선택 중 매진 가능성)`);
  },

  async submitSeats(page, ctx): Promise<SubmitResult> {
    const since = Date.now();
    await page.locator('#mock-seat-next').click();
    const end = since + ctx.timeouts.stepMs;
    while (Date.now() < end) {
      const st = await stageOf(page);
      if (st === 'payment') return { ok: true };
      if (st === 'login-required') return { ok: false, reason: 'session', message: '세션 만료' };
      const d = ctx.dialogs.since(since, e => e.type === 'alert');
      if (d) {
        if (/이미|선택한 좌석|매진/.test(d.message)) return { ok: false, reason: 'taken', message: d.message };
        if (/예매 내역|최대/.test(d.message)) return { ok: false, reason: 'limit', message: d.message };
        if (/\(5\d\d\)|오류/.test(d.message)) return { ok: false, reason: 'network', message: d.message };
        return { ok: false, reason: 'other', message: d.message };
      }
      await ctx.sleep(50);
    }
    return { ok: false, reason: 'network', message: '좌석 선점 응답 없음 (시간 초과)' };
  },

  async readOrderSummary(page, ctx) {
    const box = page.locator('#mock-pay-summary');
    await box.waitFor({ timeout: ctx.timeouts.stepMs });
    return {
      holdId: (await box.getAttribute('data-hold-id'))!,
      seatIds: (await box.getAttribute('data-seat-ids'))!.split(','),
      total: Number(await box.getAttribute('data-total')),
      text: (await box.innerText()).trim(),
      expiresIn: (await page.locator('#mock-hold-timer').textContent())?.trim(),
    };
  },

  async completePayment(page, ctx) {
    await page.locator('#mock-pay-agree').check();
    await page.locator('#mock-pay-submit').click();
    const err = page.locator('#mock-pay-error');
    const end = Date.now() + ctx.timeouts.stepMs;
    for (;;) {
      if (await page.locator('[data-mock-stage="done"]').count()) break;
      const msg = ((await err.textContent().catch(() => '')) ?? '').trim();
      if (msg) throw new Error(`결제 실패: ${msg}`);
      if (Date.now() > end) throw new Error('결제 결과 확인 시간 초과');
      await ctx.sleep(100);
    }
    const id = page.locator('#mock-order-id');
    await id.filter({ hasText: /MOCK-/ }).waitFor({ timeout: ctx.timeouts.stepMs });
    return { orderId: (await id.textContent())!.trim() };
  },

  async cancelHold(page, ctx) {
    ctx.dialogs.intent.cancel = true;
    try {
      await page.locator('#mock-pay-cancel').click();
      await page.locator('[data-mock-stage="seats"]').waitFor({ timeout: ctx.timeouts.stepMs });
    } finally { ctx.dialogs.intent.cancel = false; }
  },
};
