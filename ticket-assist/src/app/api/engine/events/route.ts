import { NextRequest } from 'next/server';
import { engine } from '@/lib/engine/engine';
import { guardRequest } from '@/lib/server/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Server-Sent Events: 실시간 이벤트 로그 / 상태 변경
export async function GET(req: NextRequest) {
  const bad = guardRequest(req); if (bad) return bad;
  const e = engine();
  const after = Number(req.nextUrl.searchParams.get('after') ?? 0);
  const enc = new TextEncoder();
  let unsub = () => {};
  let ping: NodeJS.Timeout;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: unknown) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ } };
      for (const ev of e.recentEvents(after)) send(ev);
      unsub = (() => { const u = e.subscribe(send); return () => { u(); }; })();
      ping = setInterval(() => { try { controller.enqueue(enc.encode(': ping\n\n')); } catch { /* closed */ } }, 15_000);
      req.signal.addEventListener('abort', () => { unsub(); clearInterval(ping); try { controller.close(); } catch { /* */ } });
    },
    cancel() { unsub(); clearInterval(ping); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
}
