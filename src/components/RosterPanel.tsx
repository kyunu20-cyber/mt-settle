import { useState } from 'react'
import type { Board, Participant } from '../types'
import { defaultStatus } from '../types'
import { newId } from '../lib/format'

type Props = {
  board: Board
  onChange: (next: Board) => void
  readOnly?: boolean
}

/** 쉼표·공백·줄바꿈으로 여러 이름 분리. 괄호 메모는 앞 이름에 붙임. */
function parseNames(raw: string): string[] {
  const tokens = raw
    .split(/[,\n]+/)
    .flatMap((seg) => seg.split(/\s+/))
    .map((t) => t.trim())
    .filter(Boolean)
  const names: string[] = []
  for (const tok of tokens) {
    if (tok.startsWith('(') && names.length > 0) {
      names[names.length - 1] = `${names[names.length - 1]} ${tok}`
    } else {
      names.push(tok)
    }
  }
  return names
}

export default function RosterPanel({ board, onChange, readOnly }: Props) {
  const [name, setName] = useState('')

  const seedPayments = (): Participant['payments'] => {
    const payments: Participant['payments'] = {}
    board.collections.forEach((c) => {
      payments[c.id] = { amount: c.defaultAmount, status: defaultStatus(c) }
    })
    return payments
  }

  const add = () => {
    const names = parseNames(name)
    if (names.length === 0) return
    const added = names.map((n) => ({
      id: newId(),
      name: n,
      payments: seedPayments(),
    }))
    onChange({ ...board, participants: [...board.participants, ...added] })
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
