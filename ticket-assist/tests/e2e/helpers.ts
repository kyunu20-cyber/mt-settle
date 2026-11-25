import { chromium, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BASE = 'http://127.0.0.1:3210';
export const DEBUG_PORT = 9339;
const H = { 'x-ticket-assist': '1' };

export interface Status { running: boolean; paused: boolean; stage: string; pendingConfirm: null | { id: string; kind: string; options?: { seats: { id: string }[]; tier: number; reason: string; contiguous: boolean }[]; order?: { seatIds: string[]; total: number } }; result: null | { outcome: string; reason?: string; orderId?: string; seats?: string[]; finishedAt: number }; seats: null | { available: number; unavailable: number; unknown: number; usedFallback: boolean; notes: string[]; recommendations: { tier: number; reason: string }[] }; seatPoints: null | { id: string; s: string }[]; queue: null | { position: number | null }; network: { failures: number; serverErrors: number }; browser: { connected: boolean }; countdown: null | { offsetMs: number; source: string } }

export async function engineState(req: APIRequestContext) {
  return (await req.get('/api/engine')).json() as Promise<{ status: Status; ledger: { key: string; status: string; orderId?: string }[]; failures: { reason: string; message: string }[]; adapters: { id: string; support: { status: string } }[] }>;
}
export async function engineAction(req: APIRequestContext, body: Record<string, unknown>) {
  const r = await req.post('/api/engine', { data: body, headers: H });
  return { status: r.status(), body: await r.json() };
}
export async function mockReset(req: APIRequestContext, over: Record<string, unknown> = {}) {
  return (await req.post('/api/mock/admin/reset', { data: { openInMs: 3000, requireLogin: false, popups: { noticeDelayMs: 0 }, ...over } })).json();
}
export async function mockState(req: APIRequestContext) { return (await req.post('/api/mock/admin/state')).json(); }

/** 각 테스트 전: 엔진 종료 + 장부 정리 */
export async function cleanSlate(req: APIRequestContext) {
  const s = await engineState(req);
  if (s.status.running) await engineAction(req, { action: 'stop' });
  for (const l of s.ledger) await engineAction(req, { action: 'clear-ledger', key: l.key });
}

export function config(openAt: number, over: Record<string, unknown> = {}) {
  return {
    url: `${BASE}/mock`, openAt: new Date(openAt).toISOString(), performanceDate: '2026-12-20', performanceTime: '19:00',
    quantity: 2, sections: ['A', 'B', 'C'], grades: [], weights: { stage: 0.5, center: 0.3, section: 0.2 }, allowSplit: false,
    browser: { mode: 'launch', headless: true, profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ta-prof-')), debugPort: DEBUG_PORT },
    timeouts: { confirmMs: 60_000, humanMs: 60_000, stepMs: 15_000 },
    ...over,
  };
}

export async function startRun(req: APIRequestContext, over: Record<string, unknown> = {}, mock: Record<string, unknown> = {}) {
  const m = await mockReset(req, mock);
  const r = await engineAction(req, { action: 'start', config: config(m.openAt, over) });
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true });
  return m;
}

export async function waitStatus(req: APIRequestContext, pred: (s: Status) => boolean, timeout = 60_000, what = 'condition') {
  const end = Date.now() + timeout;
  let last: Status | null = null;
  while (Date.now() < end) {
    last = (await engineState(req)).status;
    if (pred(last)) return last;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`waitStatus timeout: ${what}; last stage=${last?.stage} result=${JSON.stringify(last?.result)}`);
}

export const waitConfirm = (req: APIRequestContext, kind: 'seats' | 'payment', timeout = 60_000) =>
  waitStatus(req, s => s.pendingConfirm?.kind === kind || (!s.running && !!s.result), timeout, `confirm ${kind}`);

export async function respond(req: APIRequestContext, s: Status, approve: boolean, optionIndex = 0) {
  const r = await engineAction(req, { action: 'respond', id: s.pendingConfirm!.id, approve, optionIndex });
  expect(r.body.ok).toBe(true);
}

export const waitDone = (req: APIRequestContext, timeout = 60_000) => waitStatus(req, s => !s.running && !!s.result, timeout, 'finish');

export async function events(_req: APIRequestContext): Promise<{ type: string; level: string; message: string }[]> {
  // SSE 백로그를 읽고, 마지막 실행("시작:" 이벤트) 이후 것만 반환
  const res = await fetch(`${BASE}/api/engine/events?after=0`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.body) return [];
  const reader = res.body.getReader(); const dec = new TextDecoder(); let text = '';
  const end = Date.now() + 2500;
  try {
    while (Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<null>(ok => setTimeout(() => ok(null), 300))]);
      if (!r) { if (text) break; continue; } // 백로그를 다 받으면 스트림이 잠잠해짐
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
  } catch { /* timeout */ }
  reader.cancel().catch(() => {});
  const all = text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const startIdx = all.map(e => e.type === 'status' && String(e.message).startsWith('시작:')).lastIndexOf(true);
  return all.slice(Math.max(0, startIdx));
}

/** "사람" 역할: 엔진이 띄운 브라우저에 CDP 로 붙어서 사용자가 하는 행동(로그인·보안문자 입력)을 흉내낸다 */
export async function human(): Promise<{ browser: Browser; page: (re: RegExp) => Promise<Page> }> {
  let browser: Browser | null = null;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => null);
    if (!browser) await new Promise(r => setTimeout(r, 300));
  }
  if (!browser) throw new Error('human: CDP 연결 실패');
  return {
    browser: browser!,
    page: async (re: RegExp) => {
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        for (const c of browser!.contexts()) for (const p of c.pages()) if (re.test(p.url())) return p;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`human: page ${re} not found`);
    },
  };
}

export async function humanAnswers(req: APIRequestContext) {
  return (await req.post('/api/mock/admin/human-answers')).json() as Promise<{ sid: string; captcha: string | null; identity: string | null }[]>;
}

/** 사람이 화면의 공지 모달을 닫는 행동 (떠 있을 때만) */
export async function dismissNotice(p: Page) {
  const close = p.locator('#mock-notice-close');
  await close.waitFor({ timeout: 2000 }).then(() => close.click()).catch(() => {});
}
