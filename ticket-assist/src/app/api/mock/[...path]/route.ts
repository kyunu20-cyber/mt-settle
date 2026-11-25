// 모의 예매 사이트 API. /api/mock/admin/* 은 테스트 하네스 전용(loopback).
import { NextRequest, NextResponse } from 'next/server';
import { mockStore, CANVAS, SECTIONS, type MockConfig } from '@/lib/mock/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

function json(body: unknown, status = 200, sid?: string) {
  const res = NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Server-Time': String(Date.now()) } });
  if (sid) res.cookies.set('mock_sid', sid, { path: '/', httpOnly: true, sameSite: 'lax' });
  return res;
}

function captchaSvg(answer: string) {
  const r = () => Math.random();
  const letters = [...answer].map((ch, i) => {
    const x = 20 + i * 34, y = 44 + (r() * 10 - 5), rot = r() * 40 - 20;
    return `<text x="${x}" y="${y}" transform="rotate(${rot.toFixed(1)} ${x} ${y})" font-size="32" font-family="serif" fill="#1e293b">${ch}</text>`;
  }).join('');
  const lines = Array.from({ length: 8 }, () => `<line x1="${r() * 200}" y1="${r() * 64}" x2="${r() * 200}" y2="${r() * 64}" stroke="#64748b"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64"><rect width="200" height="64" fill="#e2e8f0"/>${lines}${letters}</svg>`;
}

const isLoopback = (req: NextRequest) => {
  const host = req.headers.get('host') ?? '';
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
};

async function handle(req: NextRequest, ctx: Ctx) {
  const store = mockStore();
  const path = (await ctx.params).path.join('/');
  const method = req.method;
  const body = method === 'POST' ? await req.json().catch(() => ({})) : {};

  // ---------- 관리자(테스트) ----------
  if (path.startsWith('admin/')) {
    if (!isLoopback(req)) return json({ error: 'loopback only' }, 403);
    if (path === 'admin/reset') return json(store.reset(body as Partial<MockConfig>));
    if (path === 'admin/state') {
      store.expireHolds();
      const seats = Object.fromEntries([...store.seatMaps].map(([k, m]) => [k, [...m.values()].map(({ id, status }) => ({ id, status }))]));
      return json({ config: store.cfg, now: Date.now(), holds: [...store.holds.values()], orders: store.orders, log: store.log, seats,
        sessions: [...store.sessions.values()].map(s => ({ sid: s.sid, user: s.user, step: store.step(s) })) });
    }
    if (path === 'admin/expire-sessions') { store.expireAll(); return json({ ok: true }); }
    if (path === 'admin/fault') { Object.assign(store.cfg.faults, body); return json(store.cfg.faults); }
    if (path === 'admin/sell') {
      const { showtimeId, seatIds } = body as { showtimeId: string; seatIds: string[] };
      seatIds.forEach(id => { const s = store.seatMaps.get(showtimeId)?.get(id); if (s && s.status === 'available') s.status = 'sold'; });
      return json({ ok: true });
    }
    // "사람"이 화면을 보고 입력하는 행위를 테스트에서 흉내내기 위한 정답 조회. 엔진/Adapter 는 사용하지 않는다.
    if (path === 'admin/human-answers') {
      return json([...store.sessions.values()].map(s => ({ sid: s.sid, captcha: s.captchaAnswer, identity: s.identityCode })));
    }
    return json({ error: 'not found' }, 404);
  }

  const { s, isNew } = store.session(req.cookies.get('mock_sid')?.value);
  const sid = isNew ? s.sid : undefined;
  const now = Date.now();
  s.hits = s.hits.filter(t => now - t < 1000); s.hits.push(now);
  if (s.hits.length > store.cfg.rateLimitPerSec) return json({ error: '요청이 너무 많습니다.' }, 429, sid);

  const cfg = store.cfg;
  const needStep = (...ok: string[]) => {
    const st = store.step(s);
    return ok.includes(st) ? null : json({ error: `현재 단계(${st})에서 허용되지 않는 요청`, step: st }, st === 'login-required' ? 401 : 403, sid);
  };

  switch (`${method} ${path}`) {
    case 'GET time': return json({ now: Date.now() }, 200, sid);
    case 'GET event': return json({
      title: cfg.title, openAt: cfg.openAt, now: Date.now(), open: store.isOpen(), requireReload: cfg.requireReload,
      popups: cfg.popups, showtimes: store.showtimes, user: store.loggedIn(s) ? s.user ?? 'guest' : null,
      grades: SECTIONS.map(x => ({ section: x.id, grade: x.grade, price: x.price })),
    }, 200, sid);
    case 'POST login': store.login(s, String((body as { user?: string }).user ?? '')); return json({ ok: true }, 200, sid);
    case 'POST logout': s.user = null; return json({ ok: true }, 200, sid);
    case 'GET step': return json({ step: store.step(s), queue: store.queuePosition(s), renderMode: cfg.renderMode, showtimeId: s.showtimeId, orderId: s.orderId }, 200, sid);
    case 'POST enter': {
      const st = store.step(s);
      if (st === 'login-required') return json({ error: '로그인이 필요합니다.' }, 401, sid);
      if (st === 'not-open') return json({ error: '아직 예매 오픈 전입니다.' }, 403, sid);
      store.enter(s); return json({ step: store.step(s) }, 200, sid);
    }
    case 'GET captcha.svg': {
      const bad = needStep('captcha'); if (bad) return bad;
      return new NextResponse(captchaSvg(store.newCaptcha(s)), { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
    }
    case 'POST captcha': {
      const ok = s.captchaAnswer && String((body as { answer?: string }).answer ?? '').trim().toUpperCase() === s.captchaAnswer;
      s.captchaAnswer = null;
      if (!ok) return json({ error: '보안문자가 일치하지 않습니다.' }, 400, sid);
      s.captchaPassed = true; return json({ step: store.step(s) }, 200, sid);
    }
    case 'POST identity/request': { const bad = needStep('identity'); if (bad) return bad; store.newIdentityCode(s); return json({ sent: true }, 200, sid); }
    case 'POST identity/verify': {
      if (!s.identityCode || (body as { code?: string }).code !== s.identityCode) return json({ error: '인증번호가 올바르지 않습니다.' }, 400, sid);
      s.identityPassed = true; return json({ step: store.step(s) }, 200, sid);
    }
    case 'POST schedule': {
      const bad = needStep('schedule', 'seats'); if (bad) return bad;
      const id = (body as { showtimeId?: string }).showtimeId;
      if (!store.showtimes.some(x => x.id === id)) return json({ error: '존재하지 않는 회차' }, 400, sid);
      s.showtimeId = id!; return json({ step: store.step(s) }, 200, sid);
    }
    case 'GET seats': {
      const bad = needStep('seats', 'payment'); if (bad) return bad;
      if (cfg.faults.seats5xx > 0) { cfg.faults.seats5xx--; return json({ error: '일시적인 서버 오류' }, 503, sid); }
      store.expireHolds();
      const map = store.seatMaps.get(s.showtimeId!)!;
      return json({
        showtimeId: s.showtimeId, renderMode: cfg.renderMode, canvas: CANVAS, maxPerOrder: cfg.maxPerOrder,
        sections: SECTIONS.map(x => ({ id: x.id, grade: x.grade, price: x.price })),
        seats: [...map.values()].map(({ holdId, status, ...x }) => ({ ...x, status: status === 'available' ? 'available' : 'sold' })),
      }, 200, sid);
    }
    case 'POST hold': {
      const bad = needStep('seats'); if (bad) return bad;
      if (cfg.faults.hold5xx > 0) { cfg.faults.hold5xx--; return json({ error: '일시적인 서버 오류' }, 503, sid); }
      const r = store.hold(s, (body as { seatIds: string[] }).seatIds);
      return json(r.body, r.code, sid);
    }
    case 'GET hold': {
      store.expireHolds();
      const h = s.holdId ? store.holds.get(s.holdId) : null;
      if (!h) return json({ error: '선점 내역 없음' }, 404, sid);
      const map = store.seatMaps.get(h.showtimeId)!;
      const st = store.showtimes.find(x => x.id === h.showtimeId)!;
      return json({ ...h, showtime: st, seats: h.seatIds.map(id => map.get(id)), now: Date.now() }, 200, sid);
    }
    case 'POST release': { if (s.holdId) store.release(s.holdId); return json({ ok: true }, 200, sid); }
    case 'POST pay': {
      const bad = needStep('payment', 'done', 'seats'); if (bad) return bad;
      const b = body as { holdId: string; idempotencyKey: string; agree: boolean };
      if (!s.orderId && !store.orders.some(o => o.idempotencyKey === b.idempotencyKey) && !(s.holdId && store.holds.has(s.holdId))) {
        return json({ error: '선점 시간이 만료되었습니다. 좌석을 다시 선택해 주세요.' }, 410, sid);
      }
      if (!b.agree) return json({ error: '약관 동의 필요' }, 400, sid);
      if (!b.idempotencyKey) return json({ error: 'idempotencyKey 필요' }, 400, sid);
      const r = store.pay(s, b.holdId, b.idempotencyKey);
      return json(r.body, r.code, sid);
    }
    case 'GET order': {
      const o = store.orders.find(x => x.orderId === s.orderId);
      return o ? json(o, 200, sid) : json({ error: 'not found' }, 404, sid);
    }
    case 'POST reset-flow': { s.entered = false; s.orderId = null; s.showtimeId = null; return json({ ok: true }, 200, sid); }
  }
  return json({ error: 'not found' }, 404, sid);
}

export const GET = handle;
export const POST = handle;
