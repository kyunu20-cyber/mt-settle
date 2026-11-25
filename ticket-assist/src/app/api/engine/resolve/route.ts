import { NextRequest, NextResponse } from 'next/server';
import { resolveAdapter } from '@/lib/adapters/registry';
import { guardRequest } from '@/lib/server/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// URL → Adapter 식별 (대시보드 표시용, 엔진과 같은 규칙)
export async function GET(req: NextRequest) {
  const bad = guardRequest(req); if (bad) return bad;
  try {
    const a = resolveAdapter(req.nextUrl.searchParams.get('url') ?? '');
    return NextResponse.json({ id: a.id, name: a.name, hosts: a.hosts, support: a.support });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}
