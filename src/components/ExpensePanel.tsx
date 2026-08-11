import { useState, type ChangeEvent } from 'react'
import type { Board, Expense } from '../types'
import { newId, won } from '../lib/format'
import { expenseTotal, perPerson } from '../lib/calc'
import { uploadReceipt } from '../lib/receipt'
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
      receipt: '',
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

  const update = (id: string, patch: Partial<Expense>) =>
    onChange({
      ...board,
      expenses: board.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)),
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
              <ReceiptUpload
                receipt={e.receipt || ''}
                onChange={(url) => update(e.id, { receipt: url })}
                readOnly={readOnly}
              />
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

function ReceiptUpload({
  receipt,
  onChange,
  readOnly,
}: {
  receipt: string
  onChange: (url: string) => void
  readOnly?: boolean
}) {
  const [busy, setBusy] = useState(false)

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const url = await uploadReceipt(file)
      onChange(url)
    } catch {
      alert('영수증 업로드 실패. 잠시 후 다시 시도해주세요.')
    } finally {
      setBusy(false)
    }
  }

  if (receipt) {
    return (
      <span className="receipt">
        <a href={receipt} target="_blank" rel="noreferrer">
          <img src={receipt} alt="영수증" />
        </a>
        {!readOnly && (
          <button
            className="receipt-x"
            onClick={() => onChange('')}
            aria-label="영수증 삭제"
          >
            ✕
          </button>
        )}
      </span>
    )
  }

  if (readOnly) return null

  return (
    <label className={`receipt-add ${busy ? 'busy' : ''}`} title="영수증 첨부">
      {busy ? '…' : '🧾'}
      <input type="file" accept="image/*" hidden disabled={busy} onChange={onPick} />
    </label>
  )
}
