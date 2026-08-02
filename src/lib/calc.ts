import type { Board, Expense, Participant } from '../types'
import { getPayment } from '../types'

const sum = (nums: number[]) => nums.reduce((a, b) => a + b, 0)

export const expenseTotal = (expenses: Expense[]) =>
  sum(expenses.map((e) => e.amount || 0))

export const perPerson = (total: number, headcount: number) =>
  headcount > 0 ? Math.round(total / headcount) : 0

// 실제 걷힌 금액 (status === 'paid')
export const collectionCollected = (participants: Participant[], cid: string) =>
  sum(
    participants.map((p) => {
      const pay = getPayment(p, cid)
      return pay.status === 'paid' ? pay.amount || 0 : 0
    }),
  )

// 걷어야 할 금액 (불참 제외 = status !== 'none')
export const collectionExpected = (participants: Participant[], cid: string) =>
  sum(
    participants.map((p) => {
      const pay = getPayment(p, cid)
      return pay.status === 'none' ? 0 : pay.amount || 0
    }),
  )

export const paidFor = (participants: Participant[], cid: string) =>
  participants.filter((p) => {
    const pay = getPayment(p, cid)
    return pay.status === 'paid' && pay.amount > 0
  })

export const unpaidFor = (participants: Participant[], cid: string) =>
  participants.filter((p) => {
    const pay = getPayment(p, cid)
    return pay.status === 'unpaid' && pay.amount > 0
  })

// 참여자 수 (불참 제외) — 선택 항목에서 사용
export const participantsIn = (participants: Participant[], cid: string) =>
  participants.filter((p) => getPayment(p, cid).status !== 'none')

export const totalCollected = (board: Board) =>
  sum(board.collections.map((c) => collectionCollected(board.participants, c.id)))

export type Summary = {
  headcount: number
  expenseTotal: number
  perPerson: number
  collected: number
  balance: number // 남은 돈 = 총 걷힘 − 총 지출
}

export const summarize = (board: Board): Summary => {
  const total = expenseTotal(board.expenses)
  const collected = totalCollected(board)
  return {
    headcount: board.participants.length,
    expenseTotal: total,
    perPerson: perPerson(total, board.participants.length),
    collected,
    balance: collected - total,
  }
}
