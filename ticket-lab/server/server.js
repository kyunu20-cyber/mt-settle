// 모의 티켓 예매 서버 (의존성 없음, node:http)
// 실제 서비스가 아니며, 자동화 기술(시간 감지·좌석 탐색·팝업·상태 관리)을 검증하기 위한 로컬 전용 환경이다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSeats, mulberry32, DEFAULT_SECTIONS } from './layout.js';
import { newCaptcha, captchaSvg } from './captcha.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const DEFAULT_CONFIG = {
  title: '2026 겨울 라이브 투어 — 서울 (모의)',
  venue: '랩 아레나',
  openInMs: 10_000,          // 지금부터 몇 ms 뒤 오픈 (openAt 이 없을 때)
  openAt: null,              // epoch ms
  requireReload: true,       // true면 오픈 후 새로고침해야 예매 버튼이 활성화됨
  queue: { enabled: false, initialAhead: 30, passPerSec: 20 },
  captcha: false,
  popups: { notice: true, noticeDelayMs: 500, ad: true, adDelayMs: 300, confirmOnHold: true, bookingInNewWindow: true },
  competitor: { soldPerSec: 0 }, // 다른 사용자들이 초당 팔아가는 좌석 수
  stealFirstHold: false,      // true면 첫 선점 요청 좌석을 직전에 타인이 가져간 것으로 처리(경합 재현)
  maxPerOrder: 4,
  holdTtlMs: 5 * 60_000,
  rateLimitPerSec: 30,
  seed: 42,
  soldRatio: 0.55,
  sections: DEFAULT_SECTIONS,
  soldSeatIds: null,
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function createLab(initialConfig = {}) {
  let cfg, seats, sessions, holds, orders, competitorTimer, rnd, log;

  function reset(over = {}) {
    cfg = deepMerge(DEFAULT_CONFIG, over);
    if (!cfg.openAt) cfg.openAt = Date.now() + cfg.openInMs;
    rnd = mulberry32(cfg.seed + 7);
    seats = buildSeats(cfg);
    sessions = new Map();
    holds = new Map();
    orders = [];
    log = [];
    clearInterval(competitorTimer);
    competitorTimer = null;
    if (cfg.competitor.soldPerSec > 0) {
      const intervalMs = Math.max(20, Math.round(1000 / cfg.competitor.soldPerSec));
      competitorTimer = setInterval(() => {
        if (Date.now() < cfg.openAt) return;
        const avail = [...seats.values()].filter(s => s.status === 'available');
        if (!avail.length) return;
        const s = avail[Math.floor(rnd() * avail.length)];
        s.status = 'sold';
      }, intervalMs);
      competitorTimer.unref?.();
    }
    return publicConfig();
  }

  function publicConfig() {
    return { ...cfg, sections: cfg.sections.map(s => ({ ...s })) };
  }

  const isOpen = () => Date.now() >= cfg.openAt;

  function getSession(req, res) {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    let sid = m && m[1];
    if (!sid || !sessions.has(sid)) {
      sid = crypto.randomBytes(12).toString('hex');
      sessions.set(sid, { sid, entered: false, queue: null, captchaAnswer: null, captchaPassed: false, holdId: null, hits: [] });
      res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return sessions.get(sid);
  }

  function queuePosition(sess) {
    if (!cfg.queue.enabled) return 0;
    if (!sess.queue) return null;
    const elapsed = (Date.now() - sess.queue.enteredAt) / 1000;
    return Math.max(0, Math.ceil(sess.queue.ahead - elapsed * cfg.queue.passPerSec));
  }

  // 다음 단계 결정: 대기열 → 보안문자 → 좌석
  function nextStep(sess) {
    if (!sess.entered) return 'event';
    if (cfg.queue.enabled && queuePosition(sess) > 0) return 'queue';
    if (cfg.captcha && !sess.captchaPassed) return 'captcha';
    if (sess.holdId && holds.has(sess.holdId)) return 'checkout';
    return 'seats';
  }

  function expireHolds() {
    const now = Date.now();
    for (const [id, h] of holds) {
      if (h.status === 'held' && now > h.expiresAt) releaseHold(id, 'expired');
    }
  }

  function releaseHold(id, reason = 'released') {
    const h = holds.get(id);
    if (!h) return;
    for (const sid of h.seatIds) {
      const s = seats.get(sid);
      if (s && s.holdId === id) { s.status = 'available'; s.holdId = null; }
    }
    h.status = reason;
    holds.delete(id);
    const sess = sessions.get(h.sid);
    if (sess && sess.holdId === id) sess.holdId = null;
  }

  // 연석 검증(서버측): 같은 구역·같은 열·연속 번호·통로 미포함
  function isContiguous(list) {
    if (list.length <= 1) return true;
    const sorted = [...list].sort((a, b) => a.number - b.number);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1], c = sorted[i];
      if (p.section !== c.section || p.row !== c.row || c.number !== p.number + 1 || p.aisleAfter) return false;
    }
    return true;
  }

  function send(res, code, body, headers = {}) {
    const isStr = typeof body === 'string';
    res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  }

  async function readJson(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) break; }
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }

  const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    res.setHeader('X-Server-Time', String(Date.now()));

    if (!p.startsWith('/api/')) return serveStatic(p, res);

    // ---- 관리자(테스트 하네스) API: loopback 전용 ----
    if (p.startsWith('/api/admin/')) {
      if (!isLoopback(req)) return send(res, 403, { error: 'admin is loopback-only' });
      if (p === '/api/admin/reset' && req.method === 'POST') return send(res, 200, reset(await readJson(req)));
      if (p === '/api/admin/state') {
        expireHolds();
        return send(res, 200, {
          config: publicConfig(), now: Date.now(),
          counts: countSeats(), holds: [...holds.values()], orders,
          sessions: [...sessions.values()].map(s => ({ sid: s.sid, entered: s.entered, step: nextStep(s), holdId: s.holdId })),
          log,
        });
      }
      // 테스트에서 "사람이 CAPTCHA를 읽고 입력하는 행위"를 흉내내기 위한 엔드포인트. 봇 코드는 사용하지 않는다.
      if (p === '/api/admin/captcha-answer') {
        const sess = sessions.get(url.searchParams.get('sid'));
        return send(res, 200, { answer: sess?.captchaAnswer ?? null });
      }
      if (p === '/api/admin/sell' && req.method === 'POST') {
        const { seatIds = [] } = await readJson(req);
        for (const id of seatIds) { const s = seats.get(id); if (s && s.status === 'available') s.status = 'sold'; }
        return send(res, 200, countSeats());
      }
      return send(res, 404, { error: 'not found' });
    }

    const sess = getSession(req, res);

    // 레이트 리밋: 정상 사용자 수준 이상의 과도한 요청 차단
    const now = Date.now();
    sess.hits = sess.hits.filter(t => now - t < 1000);
    sess.hits.push(now);
    if (sess.hits.length > cfg.rateLimitPerSec) {
      log.push({ t: now, sid: sess.sid, ev: 'rate-limited', path: p });
      return send(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }, { 'Retry-After': '1' });
    }

    if (p === '/api/time') return send(res, 200, { now: Date.now() });

    if (p === '/api/event') {
      return send(res, 200, {
        title: cfg.title, venue: cfg.venue, openAt: cfg.openAt, now: Date.now(), open: isOpen(),
        requireReload: cfg.requireReload, popups: cfg.popups, maxPerOrder: cfg.maxPerOrder,
        grades: cfg.sections.map(s => ({ section: s.id, grade: s.grade, price: s.price })),
      });
    }

    if (p === '/api/booking/enter' && req.method === 'POST') {
      if (!isOpen()) return send(res, 403, { error: '아직 예매 시작 전입니다.', openAt: cfg.openAt });
      if (!sess.entered) {
        sess.entered = true;
        if (cfg.queue.enabled) sess.queue = { enteredAt: Date.now(), ahead: cfg.queue.initialAhead };
        log.push({ t: now, sid: sess.sid, ev: 'enter' });
      }
      return send(res, 200, { next: nextStep(sess) });
    }

    if (p === '/api/booking/step') return send(res, 200, { next: nextStep(sess), open: isOpen() });

    if (p === '/api/queue/status') {
      const position = queuePosition(sess);
      return send(res, 200, { position, passed: position === 0, next: nextStep(sess) });
    }

    if (p === '/api/captcha.svg') {
      if (!sess.entered) return send(res, 403, 'forbidden');
      sess.captchaAnswer = newCaptcha();
      return send(res, 200, captchaSvg(sess.captchaAnswer), { 'Content-Type': 'image/svg+xml' });
    }

    if (p === '/api/captcha' && req.method === 'POST') {
      const { answer } = await readJson(req);
      if (sess.captchaAnswer && String(answer || '').trim().toUpperCase() === sess.captchaAnswer) {
        sess.captchaPassed = true;
        log.push({ t: now, sid: sess.sid, ev: 'captcha-pass' });
        return send(res, 200, { ok: true, next: nextStep(sess) });
      }
      sess.captchaAnswer = null; // 틀리면 새 문자 필요
      return send(res, 400, { ok: false, error: '문자가 일치하지 않습니다.' });
    }

    // 이하 좌석/선점/결제는 단계 게이트 통과 필요 — 대기열·CAPTCHA 우회 불가
    const gate = () => {
      const step = nextStep(sess);
      if (step === 'event' || step === 'queue' || step === 'captcha') return send(res, 403, { error: `접근 불가 단계: ${step}`, next: step }), false;
      return true;
    };

    if (p === '/api/seats') {
      if (!gate()) return;
      expireHolds();
      return send(res, 200, {
        maxPerOrder: cfg.maxPerOrder,
        sections: cfg.sections.map(s => ({ id: s.id, grade: s.grade, price: s.price, rows: s.rows, seatsPerRow: s.seatsPerRow, aisleAfter: s.aisleAfter })),
        seats: [...seats.values()].map(({ holdId, ...s }) => ({ ...s, status: s.status === 'held' && holdId === sess.holdId ? 'mine' : s.status === 'held' ? 'sold' : s.status })),
      });
    }

    if (p === '/api/hold' && req.method === 'POST') {
      if (!gate()) return;
      expireHolds();
      const { seatIds = [] } = await readJson(req);
      if (!Array.isArray(seatIds) || seatIds.length < 1) return send(res, 400, { error: '좌석을 선택하세요.' });
      if (seatIds.length > cfg.maxPerOrder) return send(res, 400, { error: `1회 최대 ${cfg.maxPerOrder}매까지 예매 가능합니다.` });
      if (sess.holdId) return send(res, 409, { error: '이미 선점한 좌석이 있습니다.', holdId: sess.holdId });
      const list = seatIds.map(id => seats.get(id));
      if (list.some(s => !s)) return send(res, 400, { error: '존재하지 않는 좌석입니다.' });
      if (cfg.stealFirstHold && !log.some(e => e.ev === 'stolen')) {
        list.forEach(s => { if (s.status === 'available') s.status = 'sold'; });
        log.push({ t: now, sid: sess.sid, ev: 'stolen', seatIds });
      }
      const taken = list.filter(s => s.status !== 'available').map(s => s.id);
      if (taken.length) {
        log.push({ t: now, sid: sess.sid, ev: 'hold-conflict', seatIds, taken });
        return send(res, 409, { error: '이미 선택된 좌석입니다.', taken });
      }
      const id = 'H' + crypto.randomBytes(5).toString('hex');
      const hold = { id, sid: sess.sid, seatIds, contiguous: isContiguous(list), total: list.reduce((a, s) => a + s.price, 0), status: 'held', createdAt: now, expiresAt: now + cfg.holdTtlMs };
      list.forEach(s => { s.status = 'held'; s.holdId = id; });
      holds.set(id, hold);
      sess.holdId = id;
      log.push({ t: now, sid: sess.sid, ev: 'hold', seatIds });
      return send(res, 200, hold);
    }

    if (p === '/api/hold' && req.method === 'GET') {
      expireHolds();
      const h = sess.holdId && holds.get(sess.holdId);
      if (!h) return send(res, 404, { error: '선점한 좌석이 없습니다(만료되었을 수 있음).' });
      return send(res, 200, { ...h, seats: h.seatIds.map(i => seats.get(i)), now: Date.now() });
    }

    if (p === '/api/release' && req.method === 'POST') {
      if (sess.holdId) { log.push({ t: now, sid: sess.sid, ev: 'release' }); releaseHold(sess.holdId); }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/pay' && req.method === 'POST') {
      expireHolds();
      const h = sess.holdId && holds.get(sess.holdId);
      if (!h) return send(res, 410, { error: '선점 시간이 만료되었습니다.' });
      const { agree } = await readJson(req);
      if (agree !== true) return send(res, 400, { error: '결제 동의가 필요합니다.' });
      const order = { orderId: 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase(), seatIds: h.seatIds, total: h.total, paidAt: now, sid: sess.sid };
      h.seatIds.forEach(i => { const s = seats.get(i); s.status = 'sold'; s.holdId = null; });
      holds.delete(h.id);
      sess.holdId = null;
      orders.push(order);
      log.push({ t: now, sid: sess.sid, ev: 'paid', orderId: order.orderId });
      return send(res, 200, order);
    }

    if (p.startsWith('/api/order/')) {
      const o = orders.find(o => o.orderId === p.split('/').pop() && o.sid === sess.sid);
      return o ? send(res, 200, o) : send(res, 404, { error: 'not found' });
    }

    return send(res, 404, { error: 'not found' });
  }

  function countSeats() {
    const c = { available: 0, sold: 0, held: 0 };
    for (const s of seats.values()) c[s.status]++;
    return c;
  }

  function serveStatic(p, res) {
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  reset(initialConfig);
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => { console.error(err); send(res, 500, { error: String(err) }); });
  });
  server.on('close', () => clearInterval(competitorTimer));
  return { server, reset, get config() { return cfg; } };
}

export function startLab({ port = 0, host = '127.0.0.1', config = {} } = {}) {
  const lab = createLab(config);
  return new Promise(resolve => {
    lab.server.listen(port, host, () => {
      const { port: actual } = lab.server.address();
      resolve({ ...lab, url: `http://${host}:${actual}`, close: () => new Promise(r => { lab.server.closeAllConnections?.(); lab.server.close(() => r()); }) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4100);
  const openInMs = Number(process.env.OPEN_IN_SEC || 30) * 1000;
  const config = {
    openInMs,
    queue: { enabled: process.env.QUEUE === '1' },
    captcha: process.env.CAPTCHA === '1',
    competitor: { soldPerSec: Number(process.env.COMPETITOR || 0) },
  };
  startLab({ port, config }).then(({ url, config: c }) => {
    console.log(`[ticket-lab] 모의 예매 사이트: ${url}`);
    console.log(`[ticket-lab] 오픈 시각: ${new Date(c.openAt).toLocaleString('ko-KR')} (대기열=${c.queue.enabled}, CAPTCHA=${c.captcha})`);
  });
}
