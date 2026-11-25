// 실제 예매 사이트 Adapter (NOL 티켓 / YES24 티켓 / 멜론티켓 / 티켓링크)
//
// ⚠ 셀렉터·API 엔드포인트를 의도적으로 비워 두었다.
//  - 실제 페이지 구조를 확인·검증하기 전에는 임의로 만들어 넣지 않는다.
//  - 국내 예매 사이트 약관은 일반적으로 매크로 등 자동화 프로그램을 이용한 예매를 금지한다.
//    운영사가 자동화를 허용한 범위(서면 확인 등)가 확인되기 전까지 화면 조작은 하지 않는다.
//
// 그래서 지원 수준은 'assist-only': 사용자 Chrome(로그인 세션)으로 페이지를 열고,
// 서버 시각(HTTP Date 헤더)을 동기화해 카운트다운·데스크톱 알림을 제공한 뒤 제어권을 사용자에게 넘긴다.
// 화면 조작이 필요한 메서드는 모두 NotSupportedError 를 던진다.
import type { SiteAdapter } from './types';
import { NotSupportedError } from './types';

export function assistOnly(id: string, name: string, hosts: string[], matches?: (u: URL) => boolean): SiteAdapter {
  const ns = (what: string) => async (): Promise<never> => { throw new NotSupportedError(name, what); };
  return {
    id, name, hosts,
    matches: matches ?? ((u) => hosts.includes(u.hostname)),
    support: {
      status: 'assist-only',
      automatedPayment: false,
      reason: '실제 페이지 구조가 검증되지 않았고, 사이트 약관상 자동화 예매 허용 여부가 확인되지 않아 화면 조작은 하지 않습니다. 카운트다운·알림 후 사용자가 직접 진행합니다.',
    },
    policy: { minReloadIntervalMs: 2000, maxReloadsAfterOpen: 0 },
    overlays: [],
    detectSession: async () => 'unknown',
    isBookingOpen: async () => 'waiting',
    openBooking: ns('예매 창 열기'),
    detectStage: async () => 'unknown',
    selectSchedule: ns('날짜/회차 선택'),
    readSeatMap: ns('좌석 배치 분석'),
    selectSeats: ns('좌석 선택'),
    submitSeats: ns('좌석 선점'),
    readOrderSummary: ns('주문 요약'),
    cancelHold: ns('선점 취소'),
  };
}

// 호스트는 URL 로 사이트를 식별하는 용도로만 쓴다. 사용 전 실제 도메인을 확인해 필요하면 추가하라.
export const nolAdapter = assistOnly('nol', 'NOL 티켓', ['nol.interpark.com', 'tickets.interpark.com', 'ticket.interpark.com']);
export const yes24Adapter = assistOnly('yes24', 'YES24 티켓', ['ticket.yes24.com']);
export const melonAdapter = assistOnly('melon', '멜론티켓', ['ticket.melon.com']);
export const ticketlinkAdapter = assistOnly('ticketlink', '티켓링크', ['www.ticketlink.co.kr', 'ticketlink.co.kr']);

// 보조 모드 엔진 경로를 실제 사이트에 접속하지 않고 검증하기 위한 로컬 전용 Adapter (같은 팩토리 사용)
export const mockAssistAdapter = assistOnly('mock-assist', '모의 사이트 (보조 모드 검증용)', ['localhost', '127.0.0.1'],
  (u) => ['localhost', '127.0.0.1'].includes(u.hostname) && u.pathname.startsWith('/mock') && u.searchParams.get('mode') === 'assist');
