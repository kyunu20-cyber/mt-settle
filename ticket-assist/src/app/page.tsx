'use client';
// 예매 보조 대시보드
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BookingConfig, EngineEvent, EngineStatus, Stage } from '@/lib/engine/types';

interface AdapterInfo { id: string; name: string; hosts: string[]; support: { status: string; reason?: string; automatedPayment: boolean } }
interface ApiState { status: EngineStatus; adapters: AdapterInfo[]; ledger: { key: string; status: string; updatedAt: number; orderId?: string; note?: string }[]; failures: { t: number; stage: string; reason: string; message: string; screenshot?: string }[]; platform: string; now: number }

const H = { 'Content-Type': 'application/json', 'x-ticket-assist': '1' };
const post = (body: unknown) => fetch('/api/engine', { method: 'POST', headers: H, body: JSON.stringify(body) }).then(r => r.json());

const STEPS: { id: Stage[]; label: string }[] = [
  { id: ['preflight', 'connecting'], label: '브라우저 연결' },
  { id: ['session-check', 'awaiting-login'], label: '로그인 세션' },
  { id: ['countdown'], label: '카운트다운' },
  { id: ['waiting-open', 'entering'], label: '오픈 감지/진입' },
  { id: ['queue', 'human-verification'], label: '대기열/인증' },
  { id: ['schedule'], label: '날짜·회차' },
  { id: ['seat-analysis', 'awaiting-seat-confirm', 'selecting-seats'], label: '좌석 분석/선택' },
  { id: ['payment-review', 'awaiting-payment-confirm', 'paying', 'payment-handover'], label: '결제 확인' },
  { id: ['done', 'cancelled', 'failed', 'stopped'], label: '종료' },
];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function toLocalInput(t: number) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

interface Form {
  url: string; openAtLocal: string; performanceDate: string; performanceTime: string; quantity: number;
  sections: string; grades: string; wStage: number; wCenter: number; wSection: number; allowSplit: boolean; maxPrice: string;
  browserMode: 'launch' | 'cdp'; channel: 'chrome' | 'chromium'; headless: boolean; cdpUrl: string; profileDir: string; desktopNotify: boolean;
}

function defaultForm(): Form {
  return {
    url: typeof location !== 'undefined' ? `${location.origin}/mock` : '', openAtLocal: toLocalInput(Date.now() + 60_000),
    performanceDate: '2026-12-20', performanceTime: '19:00', quantity: 2, sections: 'A, B, C', grades: 'VIP, R',
    wStage: 0.5, wCenter: 0.3, wSection: 0.2, allowSplit: false, maxPrice: '',
    browserMode: 'launch', channel: 'chromium', headless: false, cdpUrl: 'http://127.0.0.1:9222', profileDir: '', desktopNotify: true,
  };
}

function formToConfig(f: Form): BookingConfig {
  const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
  return {
    url: f.url, openAt: new Date(f.openAtLocal).toISOString(), performanceDate: f.performanceDate, performanceTime: f.performanceTime,
    quantity: Number(f.quantity), sections: list(f.sections), grades: list(f.grades),
    weights: { stage: f.wStage, center: f.wCenter, section: f.wSection }, allowSplit: f.allowSplit, maxPrice: f.maxPrice ? Number(f.maxPrice) : null,
    browser: { mode: f.browserMode, channel: f.channel, headless: f.headless, cdpUrl: f.cdpUrl, profileDir: f.profileDir || undefined },
    notifications: { desktop: f.desktopNotify },
  };
}

// 폼 기본값·알림 권한 등이 브라우저 환경(location, 현재 시각)에 의존하므로 서버 렌더와 달라진다.
// 하이드레이션 불일치를 피하기 위해 마운트 후에만 렌더링한다.
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Dashboard /> : <p className="p-6 text-sm text-slate-500">대시보드 불러오는 중…</p>;
}

function Dashboard() {
  const [api, setApi] = useState<ApiState | null>(null);
  const [form, setForm] = useState<Form>(defaultForm);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [err, setErr] = useState('');
  const [sse, setSse] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/engine', { cache: 'no-store' }).catch(() => null);
    if (r?.ok) setApi(await r.json());
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1000);
    fetch('/api/config').then(r => r.json()).then(c => { if (c) setForm(f => ({ ...f, ...c, openAtLocal: f.openAtLocal })); }).catch(() => {});
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    let es: EventSource | null = null, stop = false;
    const connect = () => {
      es = new EventSource(`/api/engine/events?after=${lastSeq.current}`);
      es.onopen = () => setSse('open');
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as EngineEvent;
        if (ev.seq <= lastSeq.current) return;
        lastSeq.current = ev.seq;
        setEvents(list => [...list.slice(-499), ev]);
        if (ev.type === 'notify' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const d = ev.data as { title: string; body: string };
          new Notification(d.title, { body: d.body });
        }
        if (['stage', 'confirm', 'result', 'seats', 'status'].includes(ev.type)) refresh();
      };
      es.onerror = () => { setSse('closed'); es?.close(); if (!stop) setTimeout(connect, 1500); };
    };
    connect();
    return () => { stop = true; es?.close(); };
  }, [refresh]);

  const st = api?.status;
  const [adapter, setAdapter] = useState<AdapterInfo | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      fetch('/api/engine/resolve?url=' + encodeURIComponent(form.url)).then(r => (r.ok ? r.json() : null)).then(setAdapter).catch(() => setAdapter(null));
    }, 200);
    return () => clearTimeout(t);
  }, [form.url]);

  const act = async (body: Record<string, unknown>) => {
    setErr('');
    const r = await post(body);
    if (r.ok === false || r.error) setErr(r.error ?? '요청 실패');
    refresh();
  };
  const start = () => act({ action: 'start', config: formToConfig(form) });
  const save = async () => {
    const { openAtLocal, ...rest } = form; void openAtLocal;
    const r = await fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify(rest) }).then(x => x.json());
    setErr(r.error ?? '');
  };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto max-w-[1400px] p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">🎫 Ticket Assist <span className="text-sm font-normal text-slate-500">예매 보조 대시보드</span></h1>
        <Pill id="browser-status" ok={!!st?.browser.connected} label={st?.browser.connected ? `브라우저 연결됨 (${st.browser.mode}, 탭 ${st.browser.pages})` : '브라우저 미연결'} />
        <Pill id="stage-pill" ok={st?.stage === 'done'} warn={!!st?.pendingConfirm} label={`단계: ${st?.stage ?? '-'}${st?.paused ? ' (일시정지)' : ''}`} />
        <Pill ok={sse === 'open'} label={`실시간 ${sse === 'open' ? '수신 중' : '재연결 중'}`} />
        {typeof Notification !== 'undefined' && Notification.permission !== 'granted' && (
          <button className="rounded border px-2 py-1 text-xs" onClick={() => Notification.requestPermission().then(refresh)}>브라우저 알림 허용</button>
        )}
      </header>

      {err && <p id="dash-error" className="mb-3 rounded bg-red-100 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{err}</p>}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        {/* 설정 */}
        <section className="space-y-3 rounded-xl bg-white p-4 shadow-sm dark:bg-slate-900">
          <h2 className="font-semibold">예매 설정</h2>
          <Field label="예매 페이지 URL">
            <input id="cfg-url" className="inp" value={form.url} onChange={e => set('url', e.target.value)} />
            <p id="cfg-adapter" className="mt-1 text-xs">
              {adapter ? <>Adapter: <b>{adapter.name}</b> · <SupportBadge s={adapter.support.status} /></> : <span className="text-red-600">지원하지 않는 사이트</span>}
            </p>
            {adapter?.support.reason && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{adapter.support.reason}</p>}
          </Field>
          <Field label="예매 오픈 일시 (초 단위)"><input id="cfg-open" type="datetime-local" step={1} className="inp" value={form.openAtLocal} onChange={e => set('openAtLocal', e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="공연 날짜"><input id="cfg-date" type="date" className="inp" value={form.performanceDate} onChange={e => set('performanceDate', e.target.value)} /></Field>
            <Field label="회차(시간)"><input id="cfg-time" type="time" className="inp" value={form.performanceTime} onChange={e => set('performanceTime', e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="매수"><input id="cfg-qty" type="number" min={1} max={10} className="inp" value={form.quantity} onChange={e => set('quantity', Number(e.target.value))} /></Field>
            <Field label="1매 최대 가격"><input id="cfg-maxprice" type="number" className="inp" placeholder="제한 없음" value={form.maxPrice} onChange={e => set('maxPrice', e.target.value)} /></Field>
          </div>
          <Field label="선호 구역 (우선순위 순, 쉼표)"><input id="cfg-sections" className="inp" value={form.sections} onChange={e => set('sections', e.target.value)} /></Field>
          <Field label="선호 등급 (쉼표)"><input id="cfg-grades" className="inp" value={form.grades} onChange={e => set('grades', e.target.value)} /></Field>
          <fieldset className="rounded border p-2 text-sm dark:border-slate-700">
            <legend className="px-1 text-xs text-slate-500">좌석 우선순위 가중치</legend>
            <Slider label="무대와의 거리" v={form.wStage} on={v => set('wStage', v)} />
            <Slider label="중앙 위치" v={form.wCenter} on={v => set('wCenter', v)} />
            <Slider label="구역 선호 순위" v={form.wSection} on={v => set('wSection', v)} />
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><input id="cfg-split" type="checkbox" checked={form.allowSplit} onChange={e => set('allowSplit', e.target.checked)} /> 연석이 없으면 분산 좌석 허용</label>
          <fieldset className="space-y-2 rounded border p-2 text-sm dark:border-slate-700">
            <legend className="px-1 text-xs text-slate-500">브라우저</legend>
            <select id="cfg-browser-mode" className="inp" value={form.browserMode} onChange={e => set('browserMode', e.target.value as Form['browserMode'])}>
              <option value="launch">전용 프로필로 실행 (로그인 세션 유지)</option>
              <option value="cdp">실행 중인 내 Chrome 에 연결 (CDP)</option>
            </select>
            {form.browserMode === 'launch' ? (
              <>
                <select id="cfg-channel" className="inp" value={form.channel} onChange={e => set('channel', e.target.value as Form['channel'])}>
                  <option value="chrome">Google Chrome (macOS 권장)</option>
                  <option value="chromium">Playwright Chromium</option>
                </select>
                <input id="cfg-profile" className="inp" placeholder="프로필 경로 (기본 ~/.ticket-assist/chrome-profile)" value={form.profileDir} onChange={e => set('profileDir', e.target.value)} />
                <label className="flex items-center gap-2"><input id="cfg-headless" type="checkbox" checked={form.headless} onChange={e => set('headless', e.target.checked)} /> 창 숨김(headless) — CAPTCHA/로그인 직접 입력 불가</label>
              </>
            ) : <input id="cfg-cdp" className="inp" value={form.cdpUrl} onChange={e => set('cdpUrl', e.target.value)} />}
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.desktopNotify} onChange={e => set('desktopNotify', e.target.checked)} /> macOS 데스크톱 알림</label>
          <div className="flex flex-wrap gap-2 pt-1">
            <button id="btn-start" disabled={!!st?.running} onClick={start} className="btn bg-emerald-600 text-white">시작</button>
            {st?.paused
              ? <button id="btn-resume" onClick={() => act({ action: 'resume' })} className="btn bg-sky-600 text-white">재개</button>
              : <button id="btn-pause" disabled={!st?.running} onClick={() => act({ action: 'pause' })} className="btn bg-amber-500 text-white">일시정지</button>}
            <button id="btn-stop" disabled={!st?.running} onClick={() => act({ action: 'stop' })} className="btn bg-rose-600 text-white">종료</button>
            <button onClick={save} className="btn border">설정 저장</button>
          </div>
          <p className="text-xs text-slate-500">비밀번호·결제정보는 입력/저장하지 않습니다. 로그인과 CAPTCHA·본인인증은 브라우저에서 직접 하세요.</p>
          {adapter?.id.startsWith('mock') && <MockControls onDone={(openAt) => set('openAtLocal', toLocalInput(openAt))} />}
        </section>

        {/* 현황 */}
        <section className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Countdown status={st} fallbackOpenAt={Date.parse(form.openAtLocal)} />
            <Stepper stage={st?.stage ?? 'idle'} status={st} />
          </div>
          {st?.pendingConfirm && <ConfirmPanel status={st} onAnswer={(approve, optionIndex) => act({ action: 'respond', id: st.pendingConfirm!.id, approve, optionIndex })} />}
          <SeatPanel status={st} />
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <LogPanel events={events} />
            <HistoryPanel api={api} onClear={(key) => act({ action: 'clear-ledger', key })} />
          </div>
        </section>
      </div>
    </div>
  );
}

function Pill({ ok, warn, label, id }: { ok: boolean; warn?: boolean; label: string; id?: string }) {
  return <span id={id} className={`rounded-full px-3 py-1 text-xs font-medium ${warn ? 'bg-amber-200 text-amber-900' : ok ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{label}</span>;
}
function SupportBadge({ s }: { s: string }) {
  const m: Record<string, [string, string]> = { full: ['자동화 지원', 'bg-emerald-100 text-emerald-800'], 'assist-only': ['보조 모드(카운트다운·알림만)', 'bg-amber-100 text-amber-900'], unsupported: ['미지원', 'bg-red-100 text-red-800'] };
  const [t, c] = m[s] ?? [s, ''];
  return <span className={`rounded px-1.5 py-0.5 ${c}`}>{t}</span>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{label}</span>{children}</label>;
}
function Slider({ label, v, on }: { label: string; v: number; on: (v: number) => void }) {
  return <div className="flex items-center gap-2"><span className="w-28">{label}</span><input type="range" min={0} max={1} step={0.05} value={v} onChange={e => on(Number(e.target.value))} className="flex-1" /><span className="w-10 text-right tabular-nums">{v.toFixed(2)}</span></div>;
}

function Countdown({ status, fallbackOpenAt }: { status?: EngineStatus; fallbackOpenAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const cd = status?.countdown;
  const openAt = cd?.openAt ?? fallbackOpenAt;
  const offset = cd?.offsetMs ?? 0;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const remain = openAt - (Date.now() + offset);
      if (ref.current) {
        const a = Math.abs(remain), sign = remain < 0 ? '+' : '';
        const h = Math.floor(a / 3600_000), m = Math.floor(a / 60_000) % 60, s = Math.floor(a / 1000) % 60, ms = Math.floor(a % 1000);
        ref.current.textContent = Number.isNaN(remain) ? '--:--:--.---' : `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
        ref.current.dataset.remainMs = String(Math.round(remain));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [openAt, offset]);
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-slate-900">
      <h2 className="text-sm text-slate-500">예매 오픈까지 {cd ? '(서버 시각 기준)' : '(로컬 시각 · 시작 전)'}</h2>
      <span id="countdown" ref={ref} className="mt-1 block font-mono text-4xl font-bold tabular-nums">--:--:--.---</span>
      <p className="mt-1 text-xs text-slate-500">
        {Number.isNaN(openAt) ? '' : new Date(openAt).toLocaleString('ko-KR')}
        {cd && <> · 서버 오프셋 {cd.offsetMs.toFixed(0)}ms · RTT {cd.rttMs}ms · {cd.source}</>}
      </p>
      {status?.queue && <p id="queue-status" className="mt-2 text-sm">대기열 순번: <b>{status.queue.position ?? '?'}</b> (경과 {((Date.now() - status.queue.since) / 1000).toFixed(0)}s)</p>}
      {status && (status.network.failures + status.network.serverErrors > 0) && <p id="network-status" className="mt-1 text-xs text-amber-700">네트워크 오류 {status.network.failures} · 서버 오류 {status.network.serverErrors} · 최근: {status.network.last}</p>}
    </div>
  );
}

function Stepper({ stage, status }: { stage: Stage; status?: EngineStatus }) {
  const idx = STEPS.findIndex(s => s.id.includes(stage));
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-slate-900">
      <h2 className="mb-2 text-sm text-slate-500">현재 예매 단계 <span id="stage" data-stage={stage} className="ml-1 font-mono text-slate-900 dark:text-slate-100">{stage}</span></h2>
      <ol className="grid grid-cols-3 gap-1 text-xs">
        {STEPS.map((s, i) => (
          <li key={s.label} className={`rounded px-2 py-1 ${i === idx ? 'bg-indigo-600 text-white' : i < idx ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{s.label}</li>
        ))}
      </ol>
      {status?.result && <p id="result" data-outcome={status.result.outcome} className={`mt-3 text-sm font-semibold ${status.result.outcome === 'done' ? 'text-emerald-600' : status.result.outcome === 'failed' ? 'text-red-600' : 'text-amber-600'}`}>
        결과: {status.result.outcome}{status.result.orderId ? ` · 주문 ${status.result.orderId}` : ''}{status.result.reason ? ` · ${status.result.reason}` : ''}</p>}
    </div>
  );
}

function ConfirmPanel({ status, onAnswer }: { status: EngineStatus; onAnswer: (approve: boolean, idx?: number) => void }) {
  const req = status.pendingConfirm!;
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(0);
  useEffect(() => { const id = setInterval(() => setLeft(Math.max(0, req.expiresAt - Date.now())), 250); return () => clearInterval(id); }, [req.expiresAt]);
  return (
    <div id="confirm-panel" data-kind={req.kind} className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 shadow dark:bg-amber-950/40">
      <h2 className="font-bold">⚠ {req.title} <span className="text-sm font-normal">({Math.ceil(left / 1000)}초 내 응답, 미응답 시 진행 안 함)</span></h2>
      <p className="text-sm">{req.message}</p>
      {req.kind === 'seats' && req.options && (
        <ul className="mt-2 space-y-1">
          {req.options.map((o, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40">
                <input type="radio" name="opt" className="confirm-option mt-1" checked={idx === i} onChange={() => setIdx(i)} />
                <span className="text-sm"><b>{o.seats.map(s => `${s.section}구역 ${s.row}열 ${s.number}번`).join(', ')}</b>
                  <span className="ml-2 text-xs text-slate-600 dark:text-slate-300">[{o.contiguous ? '연석' : '분산'} · tier {o.tier} · 점수 {o.score.toFixed(3)}] {o.reason}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {req.kind === 'payment' && req.order && (
        <pre id="confirm-order" className="mt-2 whitespace-pre-wrap rounded bg-white p-2 text-sm dark:bg-slate-900">{req.order.text}{'\n'}선점 남은 시간: {req.order.expiresIn}</pre>
      )}
      <div className="mt-3 flex gap-2">
        <button id="btn-approve" onClick={() => onAnswer(true, idx)} className="btn bg-emerald-600 text-white">{req.kind === 'payment' ? '결제 진행 승인' : '이 좌석으로 진행'}</button>
        <button id="btn-reject" onClick={() => onAnswer(false)} className="btn bg-slate-600 text-white">{req.kind === 'payment' ? '결제 안 함 (좌석 반환)' : '거절'}</button>
      </div>
    </div>
  );
}

function SeatPanel({ status }: { status?: EngineStatus }) {
  const a = status?.seats, pts = status?.seatPoints;
  if (!a) return <div className="rounded-xl bg-white p-4 text-sm text-slate-500 shadow-sm dark:bg-slate-900">좌석 탐색 결과가 여기에 표시됩니다.</div>;
  const rec = new Set(a.recommendations[0]?.seats.map(s => s.id) ?? []);
  const xs = pts?.map(p => p.x) ?? [0], ys = pts?.map(p => p.y) ?? [0];
  const minX = Math.min(...xs) - 20, minY = Math.min(...ys) - 60, w = Math.max(...xs) - minX + 20, h = Math.max(...ys) - minY + 20;
  return (
    <div id="seat-panel" className="rounded-xl bg-white p-4 shadow-sm dark:bg-slate-900">
      <h2 className="text-sm text-slate-500">좌석 탐색 결과 <span className="font-mono">({a.renderMode})</span></h2>
      <p id="seat-summary" className="mt-1 text-sm">전체 {a.total} · <span className="text-emerald-600">가능 {a.available}</span> · 불가 {a.unavailable}{a.unknown ? ` · 미확인 ${a.unknown}` : ''} {a.usedFallback && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-900">차선책 추천</span>}</p>
      <div className="mt-2 grid gap-4 md:grid-cols-[1fr_280px]">
        {pts && (
          <svg viewBox={`${minX} ${minY} ${w} ${h}`} className="max-h-72 w-full rounded bg-slate-50 dark:bg-slate-950">
            {pts.map(p => <rect key={p.id} x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={2}
              fill={rec.has(p.id) ? '#f43f5e' : p.s === 'a' ? '#22c55e' : p.s === 'u' ? '#cbd5e1' : '#facc15'} opacity={p.s === 'u' ? 0.6 : 1} />)}
          </svg>
        )}
        <div className="text-sm">
          <table className="w-full text-xs"><thead><tr className="text-left text-slate-500"><th>구역</th><th>가능/전체</th></tr></thead>
            <tbody>{Object.entries(a.bySection).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.available}/{v.total}</td></tr>)}</tbody></table>
          <h3 className="mt-2 text-xs text-slate-500">추천</h3>
          <ol id="seat-recs" className="list-decimal pl-4 text-xs">
            {a.recommendations.map((r, i) => <li key={i}>{r.seats.map(s => s.id).join(', ')} <span className="text-slate-500">({r.contiguous ? '연석' : '분산'}, tier {r.tier})</span></li>)}
          </ol>
          {a.notes.map((n, i) => <p key={i} className="mt-1 text-xs text-slate-500">· {n}</p>)}
        </div>
      </div>
    </div>
  );
}

function LogPanel({ events }: { events: EngineEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [debug, setDebug] = useState(false);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [events]);
  const color: Record<string, string> = { error: 'text-red-500', warn: 'text-amber-500', success: 'text-emerald-500', info: '', debug: 'text-slate-400' };
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-slate-900">
      <div className="flex items-center"><h2 className="text-sm text-slate-500">실시간 이벤트 로그</h2>
        <label className="ml-auto text-xs"><input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} /> debug</label></div>
      <div id="event-log" ref={ref} className="mt-2 h-80 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-100">
        {events.filter(e => debug || e.level !== 'debug').map(e => {
          const d = new Date(e.t);
          return <div key={e.seq} className={color[e.level]} data-type={e.type}>{pad(d.getHours())}:{pad(d.getMinutes())}:{pad(d.getSeconds())}.{pad(d.getMilliseconds(), 3)} [{e.type}] {e.message}</div>;
        })}
      </div>
    </div>
  );
}

function HistoryPanel({ api, onClear }: { api: ApiState | null; onClear: (key: string) => void }) {
  return (
    <div className="space-y-3 rounded-xl bg-white p-4 text-xs shadow-sm dark:bg-slate-900">
      <h2 className="text-sm text-slate-500">예매 장부 (중복 예매 방지)</h2>
      <ul id="ledger" className="space-y-1">
        {api?.ledger.length ? api.ledger.map(l => (
          <li key={l.key} className="rounded bg-slate-50 p-1 dark:bg-slate-800">
            <b>{l.status}</b> {l.orderId ?? ''} <span className="break-all text-slate-500">{l.key}</span>
            {!api.status.running && <button className="ml-1 underline" onClick={() => onClear(l.key)}>기록 삭제</button>}
          </li>)) : <li className="text-slate-500">없음</li>}
      </ul>
      <h2 className="text-sm text-slate-500">실패 원인 기록</h2>
      <ul id="failures" className="space-y-1">
        {api?.failures.length ? api.failures.map(f => <li key={f.t}><b>{f.reason}</b> @{f.stage} — {f.message}</li>) : <li className="text-slate-500">없음</li>}
      </ul>
    </div>
  );
}

function MockControls({ onDone }: { onDone: (openAt: number) => void }) {
  const [o, setO] = useState({ openInSec: 20, renderMode: 'dom', queue: false, captcha: false, identity: false, competitorPerSec: 0, requireLogin: true });
  const [msg, setMsg] = useState('');
  const reset = async () => {
    const r = await fetch('/api/mock/admin/reset', { method: 'POST', headers: H, body: JSON.stringify({
      openInMs: o.openInSec * 1000, renderMode: o.renderMode, queue: { enabled: o.queue }, captcha: o.captcha, identity: o.identity,
      competitorPerSec: o.competitorPerSec, requireLogin: o.requireLogin,
    }) }).then(x => x.json());
    onDone(r.openAt);
    setMsg(`모의 사이트 초기화 — ${new Date(r.openAt).toLocaleTimeString('ko-KR')} 오픈`);
  };
  return (
    <fieldset className="space-y-1 rounded border border-dashed p-2 text-xs dark:border-slate-700">
      <legend className="px-1 text-slate-500">모의 사이트 시나리오</legend>
      <div className="flex items-center gap-2">오픈까지 <input id="mock-open-in" type="number" className="inp w-16" value={o.openInSec} onChange={e => setO({ ...o, openInSec: Number(e.target.value) })} />초
        <select id="mock-render" className="inp w-24" value={o.renderMode} onChange={e => setO({ ...o, renderMode: e.target.value })}><option>dom</option><option>svg</option><option>canvas</option></select></div>
      <div className="flex flex-wrap gap-2">
        {(['queue', 'captcha', 'identity', 'requireLogin'] as const).map(k => <label key={k}><input id={`mock-${k}`} type="checkbox" checked={o[k]} onChange={e => setO({ ...o, [k]: e.target.checked })} /> {k}</label>)}
        <label>경쟁 구매 <input type="number" className="inp w-14" value={o.competitorPerSec} onChange={e => setO({ ...o, competitorPerSec: Number(e.target.value) })} />/s</label>
      </div>
      <button id="mock-reset" onClick={reset} className="btn border">모의 사이트 초기화 + 오픈 시각 반영</button>
      {msg && <p>{msg}</p>}
    </fieldset>
  );
}
