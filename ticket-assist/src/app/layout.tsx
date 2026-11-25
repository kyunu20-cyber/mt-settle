import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Ticket Assist', description: '티켓 예매 보조 대시보드' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">{children}</body>
    </html>
  );
}
