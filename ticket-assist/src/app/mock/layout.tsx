import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata = { title: 'MOCK TICKET (모의 예매)' };

export default function MockLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="flex items-center gap-3 bg-rose-600 px-5 py-3 text-white">
        <Link href="/mock" className="font-bold">🎟 MOCK TICKET</Link>
        <span className="rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-slate-900">실제 판매 없음 · 로컬 테스트용 모의 사이트</span>
      </header>
      {children}
    </div>
  );
}
