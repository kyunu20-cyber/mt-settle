import type { Recommendation, SeatAnalysis, SeatWeights } from '../seats/types';

export interface BrowserOptions {
  /** launch: 전용 Chrome 프로필로 실행(로그인 세션이 프로필에 유지) / cdp: 이미 실행 중인 내 Chrome 에 연결 */
  mode: 'launch' | 'cdp';
  cdpUrl?: string;
  profileDir?: string;
  headless?: boolean;
  /** 'chrome' 이면 설치된 Google Chrome 사용(macOS 권장), 'chromium' 이면 Playwright Chromium */
  channel?: 'chrome' | 'chromium';
  /** launch 모드에서 원격 디버깅 포트를 열어 둘지 (사람 개입 테스트/외부 도구 연결용) */
  debugPort?: number;
}

export interface BookingConfig {
  url: string;
  adapterId?: string;
  /** 예매 오픈 시각 (ISO 8601, 예: 2026-12-01T20:00:00+09:00) */
  openAt: string;
  performanceDate: string; // YYYY-MM-DD
  performanceTime: string; // HH:mm
  quantity: number;
  sections: string[];
  grades: string[];
  weights: SeatWeights;
  allowSplit: boolean;
  maxPrice?: number | null;
  browser: BrowserOptions;
  timeouts?: Partial<Timeouts>;
  notifications?: { desktop: boolean };
}

export interface Timeouts { stepMs: number; humanMs: number; queueMs: number; confirmMs: number; openWaitMs: number }
export const DEFAULT_TIMEOUTS: Timeouts = { stepMs: 15_000, humanMs: 10 * 60_000, queueMs: 30 * 60_000, confirmMs: 3 * 60_000, openWaitMs: 24 * 3600_000 };

export type Stage =
  | 'idle' | 'preflight' | 'connecting' | 'session-check' | 'awaiting-login' | 'countdown' | 'waiting-open' | 'entering'
  | 'queue' | 'human-verification' | 'schedule' | 'seat-analysis' | 'awaiting-seat-confirm' | 'selecting-seats'
  | 'payment-review' | 'awaiting-payment-confirm' | 'paying' | 'payment-handover'
  | 'done' | 'cancelled' | 'failed' | 'stopped';

export const TERMINAL_STAGES: Stage[] = ['done', 'cancelled', 'failed', 'stopped'];

export type EventLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';
export type EventType = 'log' | 'stage' | 'browser' | 'countdown' | 'seats' | 'confirm' | 'queue' | 'notify' | 'network' | 'result' | 'status';

export interface EngineEvent { seq: number; t: number; level: EventLevel; type: EventType; message: string; data?: unknown }

export interface OrderSummary { holdId: string; seatIds: string[]; total: number; text: string; expiresIn?: string }

export interface ConfirmRequest {
  id: string;
  kind: 'seats' | 'payment';
  title: string;
  message: string;
  options?: Recommendation[];
  order?: OrderSummary;
  createdAt: number;
  expiresAt: number;
}

export interface ConfirmDecision { approve: boolean; optionIndex?: number }

export interface CountdownInfo { openAt: number; offsetMs: number; rttMs: number; source: string; siteOpenAt?: number | null }

export interface RunResult {
  outcome: 'done' | 'cancelled' | 'failed' | 'stopped' | 'payment-handover';
  reason?: string;
  orderId?: string;
  seats?: string[];
  total?: number;
  finishedAt: number;
}

export interface EngineStatus {
  running: boolean;
  paused: boolean;
  stage: Stage;
  adapter: { id: string; name: string } | null;
  browser: { connected: boolean; mode: string | null; pages: number };
  countdown: CountdownInfo | null;
  queue: { position: number | null; since: number } | null;
  seats: SeatAnalysis | null;
  /** 대시보드 미니맵용 좌석 좌표/상태 */
  seatPoints: { id: string; x: number; y: number; w: number; h: number; s: 'a' | 'u' | '?' }[] | null;
  pendingConfirm: ConfirmRequest | null;
  network: { failures: number; serverErrors: number; last: string | null };
  result: RunResult | null;
  config: BookingConfig | null;
  startedAt: number | null;
}
