import type { Board, Collection, Payment } from '../types'
import { getPayment } from '../types'
import { won } from '../lib/format'
import {
  collectionCollected,
  collectionExpected,
  paidFor,
  unpaidFor,
} from '../lib/calc'

type Props = {
  board: Board
  collection: Collection
  onChange: (next: Board) => void
  readOnly?: boolean
}

export default function CollectionPanel({
  board,
  collection,
  onChange,
  readOnly,
}: Props) {
  const cid = collection.id

  const patchCollection = (patch: Partial<Collection>) =>
    onChange({
      ...board,
      collections: board.collections.map((c) =>
        c.id === cid ? { ...c, ...patch } : c,
      ),
    })

  const applyToAll = () =>
    onChange({
      ...board,
      participants: board.participants.map((p) => ({
        ...p,
        payments: {
          ...p.payments,
          [cid]: { amount: collection.defaultAmount, paid: getPayment(p, cid).paid },
        },
      })),
    })

  const setPayment = (pid: string, patch: Partial<Payment>) =>
    onChange({
      ...board,
      participants: board.participants.map((p) =>
        p.id === pid
          ? { ...p, payments: { ...p.payments, [cid]: { ...getPayment(p, cid), ...patch } } }
          : p,
      ),
    })

  const collected = collectionCollected(board.participants, cid)
  const expected = collectionExpected(board.participants, cid)
  const paid = paidFor(board.participants, cid)
  const unpaid = unpaidFor(board.participants, cid)

  return (
    <section className="panel">
      {readOnly ? (
        <h2>{collection.name}</h2>
      ) : (
        <input
          className="panel-title-input"
          value={collection.name}
          onChange={(e) => patchCollection({ name: e.target.value })}
          aria-label="항목 이름"
        />
      )}

      {!readOnly && (
        <div className="row">
          <label className="field">
            <span>1인 금액</span>
            <input
              type="number"
              inputMode="numeric"
              value={collection.defaultAmount || ''}
              placeholder="0"
              onChange={(e) =>
                patchCollection({ defaultAmount: Number(e.target.value) || 0 })
              }
            />
          </label>
          <button
            className="ghost"
            onClick={applyToAll}
            disabled={board.participants.length === 0}
          >
            모두 적용
          </button>
        </div>
      )}

      {board.participants.length === 0 ? (
        <p className="empty">참가자를 먼저 추가해주세요.</p>
      ) : (
        <ul className="list">
          {board.participants.map((p) => {
            const pay = getPayment(p, cid)
            return (
              <li key={p.id} className="participant">
                <span className="pname">{p.name}</span>
                {readOnly ? (
                  <span className="pdue">{won(pay.amount)}</span>
                ) : (
                  <input
                    className="pdue-input"
                    type="number"
                    inputMode="numeric"
                    value={pay.amount || ''}
                    placeholder="금액"
                    onChange={(e) =>
                      setPayment(p.id, { amount: Number(e.target.value) || 0 })
                    }
                  />
                )}
                <label className={`paid ${pay.paid ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={pay.paid}
                    disabled={readOnly}
                    onChange={(e) => setPayment(p.id, { paid: e.target.checked })}
                  />
                  {pay.paid ? '납부' : '미납'}
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mini-summary">
        <div>
          걷힘 <b>{won(collected)}</b> / {won(expected)}
        </div>
        {paid.length > 0 && (
          <div className="paid-list">
            납부 {paid.length}명: {paid.map((p) => p.name).join(', ')}
          </div>
        )}
        {unpaid.length > 0 && (
          <div className="unpaid">
            미납 {unpaid.length}명: {unpaid.map((p) => p.name).join(', ')}
          </div>
        )}
      </div>
    </section>
  )
}
