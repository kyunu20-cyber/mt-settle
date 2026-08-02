export type Payment = { amount: number; paid: boolean }

export type Participant = {
  id: string
  name: string
  payments: Record<string, Payment> // key = collection.id
}

/** 수금 항목 (회비, 버스 대절비 …) */
export type Collection = {
  id: string
  name: string
  defaultAmount: number
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
    { id: 'bus', name: '버스 대절비', defaultAmount: 0 },
    { id: 'extra', name: '추가 납부금액', defaultAmount: 0 },
  ],
  participants: [],
  expenses: [],
})

export const getPayment = (p: Participant, cid: string): Payment =>
  p.payments?.[cid] ?? { amount: 0, paid: false }
