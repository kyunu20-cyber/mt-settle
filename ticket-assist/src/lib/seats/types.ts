export type RenderMode = 'dom' | 'svg' | 'canvas';
export type SeatStatus = 'available' | 'unavailable' | 'unknown';

export interface Rect { x: number; y: number; w: number; h: number }

/** 좌석 하나. x,y 는 좌석 중심(뷰포트 좌표, px) */
export interface Seat extends Rect {
  id: string;
  section: string;
  grade?: string;
  row: string;
  number: number;
  price?: number;
  status: SeatStatus;
}

export interface SeatMap {
  renderMode: RenderMode;
  seats: Seat[];
  stage: Rect | null;
  bounds: Rect;
  /** 분석 근거 (예: canvas 픽셀 검증 불일치 수) */
  notes?: string[];
}

export interface SeatWeights { stage: number; center: number; section: number }

export interface SeatPrefs {
  quantity: number;
  /** 우선순위 순서의 선호 구역. 비어 있으면 전체 */
  sections: string[];
  /** 선호 등급 (비어 있으면 전체) */
  grades: string[];
  weights: SeatWeights;
  allowSplit: boolean;
  maxPrice?: number | null;
  exclude?: string[];
}

export type Tier = 1 | 2 | 3 | 4;

export interface Recommendation {
  seats: Seat[];
  contiguous: boolean;
  tier: Tier;
  reason: string;
  score: number;
}

export interface SeatAnalysis {
  renderMode: RenderMode;
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
  bySection: Record<string, { available: number; total: number }>;
  recommendations: Recommendation[];
  /** 선호 구역에 조건 맞는 좌석이 없어 차선책을 제시했는지 */
  usedFallback: boolean;
  notes: string[];
}

export const DEFAULT_WEIGHTS: SeatWeights = { stage: 0.5, center: 0.3, section: 0.2 };
