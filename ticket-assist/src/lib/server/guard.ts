import { NextRequest, NextResponse } from 'next/server';

/** 대시보드 API 보호: 로컬 접속 + 사용자 정의 헤더(타 사이트의 CSRF 요청은 CORS preflight 에서 막힘) */
export function guardRequest(req: NextRequest, { write = false } = {}): NextResponse | null {
  const host = req.headers.get('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return NextResponse.json({ error: 'local only' }, { status: 403 });
  if (write && req.headers.get('x-ticket-assist') !== '1') return NextResponse.json({ error: 'missing x-ticket-assist header' }, { status: 403 });
  return null;
}
