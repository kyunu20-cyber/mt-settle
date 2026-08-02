import { useState } from 'react'
import type { Board, Expense } from '../types'
import { newId, won } from '../lib/format'
import { expenseTotal, perPerson } from '../lib/calc'
import CollapsePanel from './CollapsePanel'

type Props = {
  board: Board
  onChange: (next: Board) => void
  readOnly?: boolean
}

export default function ExpensePanel({ board, onChange, readOnly }: Props) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [payer, setPayer] = useState('')
  const [link, setLink] = useState('')

  const addExpense = () => {
    const trimmed = name.trim()
    const value = Number(amount) || 0
    if (!trimmed || value <= 0) return
    const e: Expense = {
      id: newId(),
      name: trimmed,
      amount: value,
      payer,
      link: link.trim(),
      amountSource: 'manual',
    }
    onChange({ ...board, expenses: [...board.expenses, e] })
    setName('')
    setAmount('')
    setLink('')
  }

  const remove = (id: string) =>
    onChange({
      ...board,
      expenses: board.expenses.filter((e) => e.id !== id),
    })

  const total = expenseTotal(board.expenses)
  const each = perPerson(total, board.participants.length)

  return (
    <CollapsePanel
      header={<h2>지출 정산</h2>}
      summary={
        <>
          총 {won(total)} · 1인당 {won(each)}
        </>
      }
      defaultOpen={false}
    >
      {!readOnly && (
        <div className="add-expense">
          <input
            placeholder="항목 (예: 고기)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="number"
            inputMode="numeric"
            placeholder="금액"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <select value={payer} onChange={(e) => setPayer(e.target.value)}>
            <option value="">결제자(선택)</option>
            {board.participants.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            placeholder="링크(선택)"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button onClick={addExpense}>추가</button>
        </div>
      )}

      {board.expenses.length === 0 ? (
        <p className="empty">아직 지출 항목이 없어요.</p>
      ) : (
        <ul className="list">
          {board.expenses.map((e) => (
            <li key={e.id} className="expense">
              <span className="ename">
                {e.link ? (
                  <a href={e.link} target="_blank" rel="noreferrer">
                    {e.name}
                  </a>
                ) : (
                  e.name
                )}
                {e.payer && <em className="payer"> · {e.payer}</em>}
              </span>
              <span className="eamount">{won(e.amount)}</span>
              {!readOnly && (
                <button className="del" onClick={() => remove(e.id)}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mini-summary">
        <div>
          총 지출 <b>{won(total)}</b>
        </div>
        <div>
          참가 {board.participants.length}명 · 1인당 <b>{won(each)}</b>
        </div>
      </div>
    </CollapsePanel>
  )
}
