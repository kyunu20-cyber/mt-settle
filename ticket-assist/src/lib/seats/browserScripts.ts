// 브라우저 안에서 실행되는 좌석 추출/하이라이트 스크립트.
// Next(SWC) 트랜스파일 헬퍼가 끼어들지 않도록 순수 JS 문자열로 보관하고 page.evaluate 로 주입한다.
import type { Rect } from './types';

/** DOM / SVG 공통: 요소 기반 좌석 배치 명세 (사이트 Adapter 가 실제 구조를 확인한 뒤 제공) */
export interface ElementSeatSpec {
  container: string;
  seat: string;
  attrs: { id: string; row: string; number: string; section?: string; grade?: string; price?: string };
  /** 구역이 상위 요소(예: SVG <g data-section>)에 있는 경우 */
  sectionFromAncestor?: { selector: string; attr: string };
  gradeFromAncestor?: { selector: string; attr: string };
  /** 예매 가능 판정 규칙: CSS 선택자 일치 / 계산된 fill 색(rgb) / 속성 값 중 하나라도 맞으면 가능 */
  available: StatusRule;
  /** 지정 시: 이 규칙에 맞으면 불가, 둘 다 아니면 unknown. 미지정 시: available 이 아니면 불가 */
  unavailable?: StatusRule;
  stage?: string;
}
export interface StatusRule { selector?: string; fills?: string[]; attr?: { name: string; values: string[] } }

export interface RawSeat { id: string; section: string; grade?: string; row: string; number: number; price?: number; status: 'available' | 'unavailable' | 'unknown'; x: number; y: number; w: number; h: number }
export interface ElementExtractResult { seats: RawSeat[]; stage: Rect | null; bounds: Rect; found: boolean }

export const EXTRACT_ELEMENTS_JS = String.raw`(spec) => {
  const root = document.querySelector(spec.container);
  if (!root) return { seats: [], stage: null, bounds: { x: 0, y: 0, w: 0, h: 0 }, found: false };
  const norm = (c) => (c || '').replace(/\s+/g, '').toLowerCase();
  const fills = (rule) => (rule && rule.fills ? rule.fills.map(norm) : []);
  const match = (el, rule) => {
    if (!rule) return false;
    if (rule.selector && el.matches(rule.selector)) return true;
    if (rule.fills && rule.fills.length) {
      const f = norm(getComputedStyle(el).fill || el.getAttribute('fill'));
      if (fills(rule).includes(f)) return true;
    }
    if (rule.attr) {
      const v = el.getAttribute(rule.attr.name);
      if (v != null && rule.attr.values.includes(v)) return true;
    }
    return false;
  };
  const fromAncestor = (el, a) => { if (!a) return null; const p = el.closest(a.selector); return p ? p.getAttribute(a.attr) : null; };
  const seats = [];
  for (const el of root.querySelectorAll(spec.seat)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const g = (k) => (spec.attrs[k] ? el.getAttribute(spec.attrs[k]) : null);
    let status;
    if (match(el, spec.available)) status = 'available';
    else if (!spec.unavailable || match(el, spec.unavailable)) status = 'unavailable';
    else status = 'unknown';
    seats.push({
      id: g('id'), section: g('section') || fromAncestor(el, spec.sectionFromAncestor) || '?',
      grade: g('grade') || fromAncestor(el, spec.gradeFromAncestor) || undefined,
      row: String(g('row')), number: Number(g('number')),
      price: g('price') != null ? Number(g('price')) : undefined,
      status, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
    });
  }
  let stage = null;
  if (spec.stage) { const s = document.querySelector(spec.stage); if (s) { const r = s.getBoundingClientRect(); stage = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; } }
  const rb = root.getBoundingClientRect();
  return { seats, stage, bounds: { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2, w: rb.width, h: rb.height }, found: true };
}`;

/** Canvas: 좌석 좌표(캔버스 내부 픽셀)의 실제 픽셀 색을 읽어 상태를 판정하고 뷰포트 좌표로 변환 */
export interface CanvasSampleSpec {
  canvas: string;
  points: { id: string; cx: number; cy: number; w: number; h: number }[];
  palette: { available: number[][]; unavailable: number[][] };
  tolerance?: number;
}
export interface CanvasSampleResult { found: boolean; rect: Rect; scale: number; results: { id: string; status: 'available' | 'unavailable' | 'unknown'; rgb: number[]; x: number; y: number; w: number; h: number }[] }

export const SAMPLE_CANVAS_JS = String.raw`(spec) => {
  const c = document.querySelector(spec.canvas);
  if (!c || !c.getContext) return { found: false, rect: { x: 0, y: 0, w: 0, h: 0 }, scale: 1, results: [] };
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const r = c.getBoundingClientRect();
  const sx = r.width / c.width, sy = r.height / c.height;
  const tol = spec.tolerance == null ? 40 : spec.tolerance;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const results = spec.points.map((p) => {
    const d = ctx.getImageData(Math.round(p.cx), Math.round(p.cy), 1, 1).data;
    const rgb = [d[0], d[1], d[2]];
    const da = Math.min(...spec.palette.available.map((q) => dist(rgb, q)));
    const du = Math.min(...spec.palette.unavailable.map((q) => dist(rgb, q)));
    const status = da <= tol && da < du ? 'available' : du <= tol ? 'unavailable' : 'unknown';
    return { id: p.id, status, rgb, x: r.left + p.cx * sx, y: r.top + p.cy * sy, w: p.w * sx, h: p.h * sy };
  });
  return { found: true, rect: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }, scale: sx, results };
}`;

/** Canvas: 좌석 데이터 없이 픽셀만으로 좌석 블롭(색 덩어리)을 찾는다 — 구조 분석/교차검증용 */
export interface CanvasBlob { cx: number; cy: number; w: number; h: number; cls: 'available' | 'unavailable'; x: number; y: number }
export const DETECT_CANVAS_BLOBS_JS = String.raw`(spec) => {
  const c = document.querySelector(spec.canvas);
  if (!c) return [];
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height, img = ctx.getImageData(0, 0, W, H).data;
  const tol = spec.tolerance == null ? 40 : spec.tolerance, minArea = spec.minArea || 20;
  const cls = new Int8Array(W * H);
  const near = (i, list) => list.some((q) => Math.hypot(img[i] - q[0], img[i + 1] - q[1], img[i + 2] - q[2]) <= tol);
  for (let p = 0; p < W * H; p++) { const i = p * 4; cls[p] = near(i, spec.palette.available) ? 1 : near(i, spec.palette.unavailable) ? 2 : 0; }
  const seen = new Uint8Array(W * H), blobs = [], r = c.getBoundingClientRect(), sx = r.width / W, sy = r.height / H;
  for (let p = 0; p < W * H; p++) {
    if (!cls[p] || seen[p]) continue;
    const k = cls[p]; let minX = W, minY = H, maxX = 0, maxY = 0, area = 0; const stack = [p]; seen[p] = 1;
    while (stack.length) {
      const q = stack.pop(), x = q % W, y = (q - x) / W; area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const n of [q - 1, q + 1, q - W, q + W]) {
        if (n < 0 || n >= W * H || seen[n] || cls[n] !== k) continue;
        if ((n === q - 1 && x === 0) || (n === q + 1 && x === W - 1)) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    if (area >= minArea) {
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      blobs.push({ cx, cy, w: maxX - minX + 1, h: maxY - minY + 1, cls: k === 1 ? 'available' : 'unavailable', x: r.left + cx * sx, y: r.top + cy * sy });
    }
  }
  return blobs;
}`;

/** 선택 가능 좌석/추천 좌석을 화면에 하이라이트 (클릭을 가로채지 않도록 pointer-events:none) */
export interface HighlightRect { x: number; y: number; w: number; h: number; kind: 'available' | 'recommended' }
export const HIGHLIGHT_JS = String.raw`(arg) => {
  const ID = '__ticket_assist_overlay';
  document.getElementById(ID)?.remove();
  if (!arg || !arg.rects) return 0;
  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('data-ticket-assist', 'overlay');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const r of arg.rects) {
    const d = document.createElement('div');
    const rec = r.kind === 'recommended';
    d.setAttribute('data-kind', r.kind);
    d.style.cssText = 'position:fixed;box-sizing:border-box;border-radius:3px;left:' + (r.x - r.w / 2 - 2) + 'px;top:' + (r.y - r.h / 2 - 2) + 'px;width:' + (r.w + 4) + 'px;height:' + (r.h + 4) + 'px;border:' + (rec ? '3px solid #f43f5e' : '2px dashed #facc15') + ';box-shadow:' + (rec ? '0 0 8px #f43f5e' : 'none');
    root.appendChild(d);
  }
  if (arg.label) {
    const l = document.createElement('div');
    l.textContent = arg.label;
    l.style.cssText = 'position:fixed;right:12px;bottom:12px;background:#111827;color:#fff;font:12px system-ui;padding:6px 10px;border-radius:6px;opacity:.9';
    root.appendChild(l);
  }
  document.body.appendChild(root);
  return arg.rects.length;
}`;
