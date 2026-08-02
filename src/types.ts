export type PayStatus = 'paid' | 'unpaid' | 'none' // 납부 / 미납 / 불참(해당없음)

export type Payment = { amount: number; status: PayStatus }

export type Participant = {
  id: string
  name: string
  payments: Record<string, Payment> // key = collection.id
}

/** 수금 항목 (회비, 버스 대절비 …). optional=true면 참여자만 부담. */
export type Collection = {
  id: string
  name: string
  defaultAmount: number
  optional?: boolean
}

export type Expense = {
  id: string
  name: string
  amount: number
  payer: string
  link: string
  amountSource: 'manual' | 'paste'
}

export type Board = {
  title: string
  collections: Collection[]
  participants: Participant[]
  expenses: Expense[]
}

export const emptyBoard = (): Board => ({
  title: 'MT 정산',
  collections: [
    { id: 'due', name: '회비', defaultAmount: 0 },
    { id: 'bus', name: '버스 대절비', defaultAmount: 0, optional: true },
    { id: 'extra', name: '추가 납부금액', defaultAmount: 0 },
  ],
  participants: [],
  expenses: [],
})

/** 항목 신규 참여 시 기본 상태: 필수=납부, 선택=불참 */
export const defaultStatus = (c: Collection): PayStatus =>
  c.optional ? 'none' : 'paid'

/** 결제 레코드 조회 (구버전 {paid:boolean} 데이터도 자동 변환) */
export const getPayment = (p: Participant, cid: string): Payment => {
  const raw = p.payments?.[cid] as
    | Payment
    | { amount?: number; paid?: boolean }
    | undefined
  if (!raw) return { amount: 0, status: 'none' }
  if ('status' in raw && raw.status)
    return { amount: raw.amount || 0, status: raw.status }
  const legacy = raw as { amount?: number; paid?: boolean }
  return { amount: legacy.amount || 0, status: legacy.paid ? 'paid' : 'unpaid' }
}
