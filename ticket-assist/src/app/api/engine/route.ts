import { NextRequest, NextResponse } from 'next/server';
import { engine } from '@/lib/engine/engine';
import { adapterInfo } from '@/lib/adapters/registry';
import { guardRequest } from '@/lib/server/guard';
import type { BookingConfig } from '@/lib/engine/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const bad = guardRequest(req); if (bad) return bad;
  const e = engine();
  return NextResponse.json({
    status: e.status, adapters: adapterInfo(), ledger: Object.values(e.ledger.all()), failures: e.failures.list(20),
    platform: process.platform, now: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const bad = guardRequest(req, { write: true }); if (bad) return bad;
  const e = engine();
  const body = await req.json().catch(() => ({})) as { action?: string; config?: BookingConfig; id?: string; approve?: boolean; optionIndex?: number; key?: string };
  switch (body.action) {
    case 'start': {
      const r = await e.start(body.config as BookingConfig);
      return NextResponse.json(r, { status: r.ok ? 200 : 400 });
    }
    case 'pause': return NextResponse.json({ ok: e.pause() });
    case 'resume': return NextResponse.json({ ok: e.resume() });
    case 'stop': return NextResponse.json({ ok: await e.stop() });
    case 'respond': return NextResponse.json({ ok: e.respond(String(body.id), { approve: !!body.approve, optionIndex: body.optionIndex }) });
    case 'disconnect-browser': if (e.running) return NextResponse.json({ ok: false, error: '실행 중에는 끊을 수 없습니다' }, { status: 409 }); await e.browser.disconnect(); return NextResponse.json({ ok: true });
    case 'clear-ledger': if (e.running) return NextResponse.json({ ok: false, error: '실행 중' }, { status: 409 }); e.ledger.remove(String(body.key)); return NextResponse.json({ ok: true });
    case 'wait-idle': await e.waitIdle(); return NextResponse.json({ ok: true, status: e.status });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
