// 예매 설정 저장/불러오기 — 비밀번호·결제정보는 저장 거부
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { DATA_DIR } from '@/lib/engine/engine';
import { findSecretKeys } from '@/lib/engine/guards';
import { guardRequest } from '@/lib/server/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const FILE = path.join(DATA_DIR, 'config.json');

export async function GET(req: NextRequest) {
  const bad = guardRequest(req); if (bad) return bad;
  try { return NextResponse.json(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return NextResponse.json(null); }
}

export async function PUT(req: NextRequest) {
  const bad = guardRequest(req, { write: true }); if (bad) return bad;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const secrets = findSecretKeys(body);
  if (secrets.length) return NextResponse.json({ error: `민감정보 필드는 저장할 수 없습니다: ${secrets.join(', ')}` }, { status: 400 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(body, null, 2), { mode: 0o600 });
  return NextResponse.json({ ok: true });
}
