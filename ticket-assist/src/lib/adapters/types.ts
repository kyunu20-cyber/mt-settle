import type { Page } from 'playwright';
import type { Seat, SeatMap } from '../seats/types';
import type { OrderSummary, Timeouts } from '../engine/types';
import type { DialogGuard } from '../engine/dialogs';

export type SiteStage =
  | 'loading' | 'unknown' | 'not-open' | 'login' | 'queue' | 'captcha' | 'identity'
  | 'schedule' | 'seats' | 'payment' | 'done' | 'error';

export interface AdapterContext {
  log: (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void;
  dialogs: DialogGuard;
  timeouts: Timeouts;
  sleep: (ms: number) => Promise<void>;
}

export type SubmitResult = { ok: true } | { ok: false; reason: 'taken' | 'session' | 'network' | 'limit' | 'other'; message: string };

export interface OverlayRule { name: string; locator: string; close: string }

export interface AdapterSupport {
  /**
   * full: 셀렉터/흐름이 실제 구조로 검증되었고, 해당 사이트가 이 방식의 자동화를 허용함이 확인됨
   * assist-only: 페이지 열기·시간 동기화·카운트다운·알림까지만. 사이트 화면 조작(클릭/입력)은 하지 않고 사용자에게 넘긴다
   * unsupported: 실행 거부
   */
  status: 'full' | 'assist-only' | 'unsupported';
  reason?: string;
  verified?: { at: string; by: string };
  /** 최종 결제를 엔진이 버튼까지 눌러도 되는지 (모의 사이트만 true). false 면 결제 단계에서 사용자에게 넘긴다. */
  automatedPayment: boolean;
}

export interface SiteAdapter {
  id: string;
  name: string;
  /** URL 로 Adapter 를 식별하기 위한 호스트 */
  hosts: string[];
  matches(url: URL): boolean;
  support: AdapterSupport;
  policy: { minReloadIntervalMs: number; maxReloadsAfterOpen: number };
  overlays: OverlayRule[];

  attach?(page: Page, ctx: AdapterContext): void;
  serverTime?(page: Page): Promise<number>;
  readOpenTime?(page: Page): Promise<number | null>;
  detectSession(page: Page): Promise<'logged-in' | 'logged-out' | 'unknown'>;
  isBookingOpen(page: Page): Promise<'enabled' | 'needs-reload' | 'waiting'>;
  openBooking(page: Page, ctx: AdapterContext): Promise<Page>;
  detectStage(page: Page): Promise<SiteStage>;
  queueStatus?(page: Page): Promise<{ position: number | null }>;
  selectSchedule(page: Page, sel: { date: string; time: string }, ctx: AdapterContext): Promise<void>;
  readSeatMap(page: Page, ctx: AdapterContext): Promise<SeatMap>;
  selectSeats(page: Page, seats: Seat[], ctx: AdapterContext): Promise<void>;
  submitSeats(page: Page, ctx: AdapterContext): Promise<SubmitResult>;
  readOrderSummary(page: Page, ctx: AdapterContext): Promise<OrderSummary>;
  completePayment?(page: Page, ctx: AdapterContext): Promise<{ orderId: string }>;
  cancelHold(page: Page, ctx: AdapterContext): Promise<void>;
}

export class NotSupportedError extends Error {
  constructor(adapter: string, what: string) { super(`[${adapter}] ${what}: 지원되지 않음 (실제 구조 미검증)`); }
}
export class ScheduleNotFoundError extends Error {}
