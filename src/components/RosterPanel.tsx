import { useState } from 'react'
import type { Board, Participant } from '../types'
import { newId } from '../lib/format'

type Props = {
  board: Board
  onChange: (next: Board) => void
  readOnly?: boolean
}

export default function RosterPanel({ board, onChange, readOnly }: Props) {
  const [name, setName] = useState('')

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const payments: Participant['payments'] = {}
    board.collections.forEach((c) => {
      payments[c.id] = { amount: c.defaultAmount, paid: false }
    })
    onChange({
      ...board,
      participants: [...board.participants, { id: newId(), name: trimmed, payments }],
    })
    setName('')
  }

  const remove = (id: string) =>
    onChange({
      ...board,
      participants: board.participants.filter((p) => p.id !== id),
    })

  return (
    <section className="panel">
      <h2>
        참가자 <span className="count">{board.participants.length}명</span>
      </h2>

      {!readOnly && (
        <div className="add-row">
          <input
            placeholder="참가자 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button onClick={add}>추가</button>
        </div>
      )}

      {board.participants.length === 0 ? (
        <p className="empty">참가자를 추가하면 아래 항목들에 자동으로 들어가요.</p>
      ) : (
        <ul className="chips">
          {board.participants.map((p) => (
            <li key={p.id} className="chip">
              {p.name}
              {!readOnly && (
                <button className="chip-del" onClick={() => remove(p.id)}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
