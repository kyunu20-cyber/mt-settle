'use client';
import { useEffect, useState } from 'react';
import { mockApi, won } from './api';

interface Ev { title: string; openAt: number; now: number; open: boolean; requireReload: boolean; user: string | null; popups: { notice: boolean; noticeDelayMs: number; bookingInNewTab: boolean }; grades: { section: string; grade: string; price: number }[]; showtimes: { id: string; date: string; time: string }[] }

export default function MockEventPage() {
  const [ev, setEv] = useState<Ev | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [needReload, setNeedReload] = useState(false);
  const [notice, setNotice] = useState(false);

  useEffect(() => {
    const t0 = Date.now();
    mockApi<Ev>('event').then(({ data }) => {
      const t1 = Date.now();
      setOffset(data.now - (t0 + t1) / 2);
      setEv(data);
      setEnabled(data.open);
      if (data.popups.notice) setTimeout(() => setNotice(true), data.popups.noticeDelayMs);
    });
  }, []);

  useEffect(() => {
    if (!ev) return;
    const id = setInterval(() => {
      const n = Date.now() + offset;
      setNow(n);
      if (n >= ev.openAt && !enabled) { if (ev.requireReload) setNeedReload(true); else setEnabled(true); }
    }, 100);
    return () => clearInterval(id);
  }, [ev, offset, enabled]);

  if (!ev) return <main className="p-8">불러오는 중…</main>;
  const remain = Math.max(0, ev.openAt - now);
  const s = Math.floor(remain / 1000);

  const book = () => {
    if (ev.popups.bookingInNewTab) window.open('/mock/booking', '_blank');
    else location.href = '/mock/booking';
  };

  return (
    <main className="mx-auto max-w-2xl p-6" data-mock-stage="event">
      <h1 id="mock-title" className="text-2xl font-bold">{ev.title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        로그인: <span id="mock-user">{ev.user ?? '로그아웃 상태'}</span>{' '}
        {!ev.user && <a id="mock-login-link" href="/mock/login?next=/mock" className="text-rose-600 underline">로그인</a>}
      </p>
      <div className="mt-4 rounded-xl border p-4">
        <p>예매 오픈: <b id="mock-open-at" data-open-at={ev.openAt}>{new Date(ev.openAt).toLocaleString('ko-KR')}</b></p>
        <p className="mt-2 font-mono text-xl" id="mock-countdown">{remain > 0 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(remain % 1000).padStart(3, '0')}` : '예매 진행 중'}</p>
        <table className="mt-3 text-sm">
          <tbody>{ev.grades.map(g => <tr key={g.section}><td className="pr-4">{g.section}구역</td><td className="pr-4">{g.grade}석</td><td>{won(g.price)}원</td></tr>)}</tbody>
        </table>
        <p className="mt-2 text-sm text-slate-500">공연일: {ev.showtimes.map(x => `${x.date} ${x.time}`).join(' / ')}</p>
        <button id="mock-book-btn" disabled={!enabled} onClick={book}
          className="mt-4 w-full rounded-lg bg-rose-600 py-3 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">
          {enabled ? '예매하기' : '오픈 예정'}
        </button>
        {needReload && <p id="mock-reload-hint" className="mt-2 text-sm text-amber-700">예매가 시작되었습니다. 새로고침 후 이용해 주세요.</p>}
      </div>
      {notice && (
        <div id="mock-notice" role="dialog" className="fixed inset-0 z-10 flex items-center justify-center bg-black/50">
          <div className="max-w-sm rounded-xl bg-white p-6">
            <h2 className="font-bold">공지사항</h2>
            <p className="mt-2 text-sm">1인 1회차 최대 4매까지 예매 가능합니다. 부정 예매(매크로 등) 적발 시 예매가 취소됩니다.</p>
            <button id="mock-notice-close" onClick={() => setNotice(false)} className="mt-4 rounded bg-slate-800 px-4 py-2 text-white">닫기</button>
          </div>
        </div>
      )}
    </main>
  );
}
