'use client';
// 모의 예매 창: 서버의 단계(step)에 따라 대기열 → 보안문자 → 본인인증 → 날짜/회차 → 좌석 → 결제 → 완료
import { useCallback, useEffect, useRef, useState } from 'react';
import { mockApi, won } from '../api';

type Step = 'enter' | 'not-open' | 'login-required' | 'queue' | 'captcha' | 'identity' | 'schedule' | 'seats' | 'payment' | 'done' | 'loading' | 'error';
interface StepRes { step: Step; queue: number; renderMode: 'dom' | 'svg' | 'canvas'; showtimeId: string | null; orderId: string | null }

export default function BookingWindow() {
  const [st, setSt] = useState<StepRes>({ step: 'loading', queue: 0, renderMode: 'dom', showtimeId: null, orderId: null });
  const [err, setErr] = useState('');
  const refresh = useCallback(async () => {
    const r = await mockApi<StepRes>('step');
    if (!r.ok) { setSt(s => ({ ...s, step: 'error' })); setErr('서버 응답 오류'); return; }
    if (r.data.step === 'enter') {
      const e = await mockApi<{ step: Step; error?: string }>('enter', {});
      if (!e.ok) { setErr(e.data.error ?? '진입 실패'); setSt({ ...r.data, step: e.status === 401 ? 'login-required' : 'not-open' }); return; }
      return refresh();
    }
    setSt(r.data);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <main className="mx-auto max-w-5xl p-4" data-mock-stage={st.step}>
      {st.step === 'loading' && <p>예매 페이지 진입 중…</p>}
      {(st.step === 'not-open' || st.step === 'error') && <p id="mock-error" className="text-red-600">{err || '아직 예매 오픈 전입니다.'}</p>}
      {st.step === 'login-required' && (
        <div className="rounded-xl border p-6">
          <p id="mock-login-required" className="font-bold">로그인이 필요하거나 세션이 만료되었습니다.</p>
          <a id="mock-login-link" href="/mock/login?next=/mock/booking" className="mt-2 inline-block text-rose-600 underline">다시 로그인</a>
        </div>
      )}
      {st.step === 'queue' && <Queue initial={st.queue} onDone={refresh} />}
      {st.step === 'captcha' && <Captcha onDone={refresh} />}
      {st.step === 'identity' && <Identity onDone={refresh} />}
      {st.step === 'schedule' && <Schedule onDone={refresh} />}
      {st.step === 'seats' && <Seats mode={st.renderMode} onDone={refresh} />}
      {st.step === 'payment' && <Payment onDone={refresh} />}
      {st.step === 'done' && <Done />}
    </main>
  );
}

function Queue({ initial, onDone }: { initial: number; onDone: () => void }) {
  const [pos, setPos] = useState(initial);
  useEffect(() => {
    const id = setInterval(async () => {
      const r = await mockApi<StepRes>('step');
      if (r.data.step !== 'queue') { clearInterval(id); onDone(); } else setPos(r.data.queue);
    }, 700);
    return () => clearInterval(id);
  }, [onDone]);
  return (
    <div className="rounded-xl border p-6 text-center">
      <h1 className="text-xl font-bold">접속 대기 중</h1>
      <p className="mt-2">내 앞 대기 인원 <b id="mock-queue-position" className="text-2xl text-rose-600">{pos}</b>명</p>
      <p className="mt-1 text-sm text-slate-500">새로고침 시 대기 순서가 초기화될 수 있습니다.</p>
    </div>
  );
}

function Captcha({ onDone }: { onDone: () => void }) {
  const [src, setSrc] = useState('');
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const load = () => { setSrc('/api/mock/captcha.svg?t=' + Date.now()); setV(''); };
  useEffect(load, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await mockApi('captcha', { answer: v });
    if (r.ok) onDone(); else { setErr(String(r.data.error)); load(); }
  };
  return (
    <form onSubmit={submit} className="rounded-xl border p-6">
      <h1 className="text-xl font-bold">자동입력 방지 문자</h1>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img id="mock-captcha-img" src={src} alt="보안문자" width={200} height={64} className="mt-3" />}
      <div className="mt-3 flex gap-2">
        <input id="mock-captcha-input" value={v} onChange={e => setV(e.target.value)} className="rounded border p-2" autoComplete="off" />
        <button id="mock-captcha-submit" className="rounded bg-rose-600 px-4 text-white">입력</button>
        <button type="button" onClick={load} className="text-sm underline">새로고침</button>
      </div>
      <p id="mock-captcha-error" className="mt-2 text-red-600">{err}</p>
    </form>
  );
}

function Identity({ onDone }: { onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="rounded-xl border p-6">
      <h1 className="text-xl font-bold">본인인증 (모의)</h1>
      <button id="mock-identity-request" onClick={async () => { await mockApi('identity/request', {}); setSent(true); }} className="mt-3 rounded border px-3 py-1">인증번호 요청</button>
      {sent && (
        <div className="mt-3 flex gap-2">
          <input id="mock-identity-code" value={code} onChange={e => setCode(e.target.value)} className="rounded border p-2" placeholder="문자로 받은 6자리" />
          <button id="mock-identity-submit" onClick={async () => { const r = await mockApi('identity/verify', { code }); if (r.ok) onDone(); else setErr(String(r.data.error)); }} className="rounded bg-rose-600 px-4 text-white">확인</button>
        </div>
      )}
      <p className="mt-2 text-red-600">{err}</p>
    </div>
  );
}

function Schedule({ onDone }: { onDone: () => void }) {
  const [shows, setShows] = useState<{ id: string; date: string; time: string }[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  useEffect(() => { mockApi<{ showtimes: typeof shows }>('event').then(r => setShows(r.data.showtimes)); }, []);
  const dates = [...new Set(shows.map(s => s.date))];
  return (
    <div className="rounded-xl border p-6">
      <h1 className="text-xl font-bold">관람일 / 회차 선택</h1>
      <div className="mt-3 flex gap-2" id="mock-dates">
        {dates.map(d => (
          <button key={d} data-date={d} aria-pressed={date === d} onClick={() => { setDate(d); setSid(null); }}
            className={`mock-date rounded border px-3 py-2 ${date === d ? 'border-rose-600 bg-rose-50 font-bold' : ''}`}>{d}</button>
        ))}
      </div>
      {date && (
        <div className="mt-3 flex gap-2" id="mock-times">
          {shows.filter(s => s.date === date).map(s => (
            <button key={s.id} data-showtime-id={s.id} data-time={s.time} aria-pressed={sid === s.id} onClick={() => setSid(s.id)}
              className={`mock-time rounded border px-3 py-2 ${sid === s.id ? 'border-rose-600 bg-rose-50 font-bold' : ''}`}>{s.time}</button>
          ))}
        </div>
      )}
      <button id="mock-schedule-next" disabled={!sid} onClick={async () => { await mockApi('schedule', { showtimeId: sid }); onDone(); }}
        className="mt-4 rounded bg-rose-600 px-4 py-2 font-bold text-white disabled:bg-slate-300">좌석 선택</button>
    </div>
  );
}

interface MSeat { id: string; section: string; grade: string; price: number; row: number; number: number; x: number; y: number; w: number; h: number; status: 'available' | 'sold' }
interface SeatsRes { seats: MSeat[]; canvas: { width: number; height: number; stage: { x: number; y: number; w: number; h: number } }; maxPerOrder: number }
const COLOR = { available: '#22c55e', sold: '#9ca3af', selected: '#6366f1' };

function Seats({ mode, onDone }: { mode: 'dom' | 'svg' | 'canvas'; onDone: () => void }) {
  const [data, setData] = useState<SeatsRes | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await mockApi<SeatsRes & { error?: string }>('seats');
    if (r.status === 401 || r.status === 403) return onDone();
    if (!r.ok) { setMsg(`좌석 정보를 불러오지 못했습니다 (${r.status}). 잠시 후 다시 시도합니다.`); return; }
    setMsg('');
    setData(r.data);
    setSel(s => s.filter(id => r.data.seats.find(x => x.id === id)?.status === 'available'));
  }, [onDone]);
  useEffect(() => { load(); const id = setInterval(load, 2000); return () => clearInterval(id); }, [load]);

  const toggle = (seat: MSeat) => {
    if (seat.status !== 'available') return;
    setSel(s => s.includes(seat.id) ? s.filter(x => x !== seat.id) : s.length >= (data?.maxPerOrder ?? 4) ? (alert(`최대 ${data?.maxPerOrder}매까지 선택 가능합니다.`), s) : [...s, seat.id]);
  };
  const next = async () => {
    setBusy(true);
    const r = await mockApi<{ error?: string }>('hold', { seatIds: sel });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 401) return onDone();
    alert(r.data.error ?? `좌석 선점 실패 (${r.status})`);
    setSel([]);
    load();
  };
  const seats = data?.seats ?? [];
  const selected = seats.filter(s => sel.includes(s.id));

  return (
    <div className="rounded-xl border p-4">
      <h1 className="text-lg font-bold">좌석 선택 <span className="text-sm font-normal text-slate-500">(렌더링: {mode})</span></h1>
      {msg && <p id="mock-seat-error" className="text-red-600">{msg}</p>}
      <div className="mt-2 overflow-auto">
        {data && mode === 'dom' && <DomMap data={data} sel={sel} toggle={toggle} />}
        {data && mode === 'svg' && <SvgMap data={data} sel={sel} toggle={toggle} />}
        {data && mode === 'canvas' && <CanvasMap data={data} sel={sel} toggle={toggle} />}
      </div>
      <div className="sticky bottom-0 mt-2 flex flex-wrap items-center gap-3 border-t bg-white py-2">
        <span>선택 <b id="mock-selected-count">{sel.length}</b>매</span>
        <span id="mock-selected-list" className="text-sm">{selected.map(s => `${s.section}구역 ${s.row}열 ${s.number}번`).join(', ')}</span>
        <span>합계 <b>{won(selected.reduce((a, s) => a + s.price, 0))}</b>원</span>
        <button id="mock-seat-next" disabled={!sel.length || busy} onClick={next} className="ml-auto rounded bg-rose-600 px-4 py-2 font-bold text-white disabled:bg-slate-300">좌석 선택 완료</button>
      </div>
    </div>
  );
}

type MapProps = { data: SeatsRes; sel: string[]; toggle: (s: MSeat) => void };

function DomMap({ data, sel, toggle }: MapProps) {
  const st = data.canvas.stage;
  return (
    <div id="mock-seatmap-dom" className="relative" style={{ width: data.canvas.width, height: data.canvas.height }}>
      <div id="mock-stage" className="absolute flex items-center justify-center rounded bg-slate-800 text-xs tracking-[.4em] text-white" style={{ left: st.x - st.w / 2, top: st.y - st.h / 2, width: st.w, height: st.h }}>STAGE</div>
      {data.seats.map(s => {
        const on = sel.includes(s.id);
        return (
          <button key={s.id} className={`mock-seat absolute rounded-t ${on ? 'is-selected' : s.status === 'available' ? 'is-available' : 'is-sold'}`}
            data-seat-id={s.id} data-section={s.section} data-grade={s.grade} data-row={s.row} data-number={s.number} data-price={s.price}
            aria-disabled={s.status !== 'available'} title={`${s.section}구역 ${s.row}열 ${s.number}번`}
            style={{ left: s.x - s.w / 2, top: s.y - s.h / 2, width: s.w, height: s.h, background: on ? COLOR.selected : COLOR[s.status] }}
            onClick={() => toggle(s)} />
        );
      })}
    </div>
  );
}

function SvgMap({ data, sel, toggle }: MapProps) {
  const st = data.canvas.stage;
  const bySec = new Map<string, MSeat[]>();
  data.seats.forEach(s => { if (!bySec.has(s.section)) bySec.set(s.section, []); bySec.get(s.section)!.push(s); });
  return (
    <svg id="mock-seatmap-svg" width={data.canvas.width} height={data.canvas.height} viewBox={`0 0 ${data.canvas.width} ${data.canvas.height}`}>
      <rect id="mock-stage-svg" x={st.x - st.w / 2} y={st.y - st.h / 2} width={st.w} height={st.h} rx={6} fill="#1e293b" />
      <text x={st.x} y={st.y + 5} textAnchor="middle" fill="#fff" fontSize={14} letterSpacing={6}>STAGE</text>
      {[...bySec].map(([sec, list]) => (
        <g key={sec} className="mock-svg-section" data-section={sec} data-grade={list[0].grade} data-price={list[0].price}>
          {list.map(s => (
            <rect key={s.id} className="mock-svg-seat" data-seat={s.id} data-row={s.row} data-no={s.number}
              x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h} rx={3}
              fill={sel.includes(s.id) ? COLOR.selected : COLOR[s.status]} style={{ cursor: s.status === 'available' ? 'pointer' : 'default' }}
              onClick={() => toggle(s)} />
          ))}
        </g>
      ))}
    </svg>
  );
}

function CanvasMap({ data, sel, toggle }: MapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    const st = data.canvas.stage;
    ctx.fillStyle = '#1e293b'; ctx.fillRect(st.x - st.w / 2, st.y - st.h / 2, st.w, st.h);
    ctx.fillStyle = '#ffffff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('STAGE', st.x, st.y + 5);
    for (const s of data.seats) {
      ctx.fillStyle = sel.includes(s.id) ? COLOR.selected : COLOR[s.status];
      ctx.fillRect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h);
    }
  }, [data, sel]);
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) * (e.currentTarget.width / r.width), y = (e.clientY - r.top) * (e.currentTarget.height / r.height);
    const hit = data.seats.find(s => Math.abs(s.x - x) <= s.w / 2 && Math.abs(s.y - y) <= s.h / 2);
    if (hit) toggle(hit);
  };
  return <canvas id="mock-seatmap-canvas" ref={ref} width={data.canvas.width} height={data.canvas.height} onClick={onClick} style={{ width: data.canvas.width, height: data.canvas.height }} />;
}

interface HoldRes { id: string; seatIds: string[]; total: number; expiresAt: number; now: number; showtime: { date: string; time: string }; seats: MSeat[] }

function Payment({ onDone }: { onDone: () => void }) {
  const [h, setH] = useState<HoldRes | null>(null);
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  useEffect(() => { mockApi<HoldRes>('hold').then(r => (r.ok ? setH(r.data) : onDone())); }, [onDone]);
  useEffect(() => {
    if (!h) return;
    const off = h.now - Date.now();
    const id = setInterval(() => setLeft(Math.max(0, h.expiresAt - (Date.now() + off))), 250);
    return () => clearInterval(id);
  }, [h]);
  if (!h) return <p>불러오는 중…</p>;
  const pay = async () => {
    if (!agree) { setErr('약관에 동의해 주세요.'); return; }
    setBusy(true);
    // 같은 선점에 대해 항상 같은 키 → 중복 클릭/재시도에도 결제는 1회
    const r = await mockApi<{ error?: string }>('pay', { holdId: h.id, idempotencyKey: `pay-${h.id}`, agree: true });
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.data.error ?? '결제 실패');
  };
  const cancel = async () => {
    if (!confirm('예매를 취소하고 좌석을 반환하시겠습니까?')) return;
    await mockApi('release', {});
    onDone();
  };
  return (
    <div className="rounded-xl border p-6">
      <h1 className="text-xl font-bold">결제 (모의)</h1>
      <div id="mock-pay-summary" data-hold-id={h.id} data-seat-ids={h.seatIds.join(',')} data-total={h.total} className="mt-3">
        <p>{h.showtime.date} {h.showtime.time}</p>
        <ul className="list-disc pl-5">{h.seats.map(s => <li key={s.id}>{s.section}구역 {s.row}열 {s.number}번 · {s.grade}석 {won(s.price)}원</li>)}</ul>
        <p className="mt-1">합계 <b>{won(h.total)}</b>원</p>
      </div>
      <p className="mt-2 text-sm">선점 남은 시간 <b id="mock-hold-timer">{Math.floor(left / 60000)}:{String(Math.floor(left / 1000) % 60).padStart(2, '0')}</b></p>
      <label className="mt-3 flex items-center gap-2"><input id="mock-pay-agree" type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> 취소 수수료 및 약관 동의</label>
      <div className="mt-4 flex gap-2">
        <button id="mock-pay-cancel" onClick={cancel} className="rounded border px-4 py-2">예매 취소</button>
        <button id="mock-pay-submit" onClick={pay} disabled={busy} className="rounded bg-rose-600 px-4 py-2 font-bold text-white disabled:bg-slate-300">결제하기 (모의)</button>
      </div>
      <p id="mock-pay-error" className="mt-2 text-red-600">{err}</p>
    </div>
  );
}

function Done() {
  const [o, setO] = useState<{ orderId: string; seatIds: string[]; total: number } | null>(null);
  useEffect(() => { mockApi<{ orderId: string; seatIds: string[]; total: number }>('order').then(r => r.ok && setO(r.data)); }, []);
  return (
    <div className="rounded-xl border p-6">
      <h1 className="text-xl font-bold">예매 완료 (모의 — 실제 결제 없음)</h1>
      <p className="mt-2">예매번호 <b id="mock-order-id">{o?.orderId ?? '…'}</b></p>
      {o && <p className="text-sm">{o.seatIds.join(', ')} · {won(o.total)}원</p>}
    </div>
  );
}
