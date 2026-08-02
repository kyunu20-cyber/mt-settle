import type { Board, Collection, Payment, PayStatus } from '../types'
import { getPayment } from '../types'
import { won } from '../lib/format'
import {
  collectionCollected,
  collectionExpected,
  paidFor,
  participantsIn,
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
  const optional = !!collection.optional

  const patchCollection = (patch: Partial<Collection>) =>
    onChange({
      ...board,
      collections: board.collections.map((c) =>
        c.id === cid ? { ...c, ...patch } : c,
      ),
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

  // 선택 항목: 금액은 유지하되 참여 상태만 유지하며 기본금액 일괄 적용
  const applyToAll = () =>
    onChange({
      ...board,
      participants: board.participants.map((p) => {
        const cur = getPayment(p, cid)
        return {
          ...p,
          payments: {
            ...p.payments,
            [cid]: { amount: collection.defaultAmount, status: cur.status },
          },
        }
      }),
    })

  // 미납 체크박스: 체크=미납, 해제=납부
  const setUnpaid = (pid: string, unpaid: boolean) =>
    setPayment(pid, { status: unpaid ? 'unpaid' : 'paid' })

  // 참여 토글(선택 항목): 켜면 납부(기본), 끄면 불참
  const setJoin = (pid: string, join: boolean, cur: Payment) =>
    setPayment(pid, {
      status: join ? 'paid' : 'none',
      amount: join && cur.amount === 0 ? collection.defaultAmount : cur.amount,
    })

  const collected = collectionCollected(board.participants, cid)
  const expected = collectionExpected(board.participants, cid)
  const paid = paidFor(board.participants, cid)
  const unpaid = unpaidFor(board.participants, cid)
  const joined = participantsIn(board.participants, cid)

  const statusLabel = (s: PayStatus) =>
    s === 'unpaid' ? '미납' : s === 'paid' ? '납부' : '불참'

  return (
    <section className="panel">
      {readOnly ? (
        <h2>
          {collection.name}
          {optional && <span className="tag">선택</span>}
        </h2>
      ) : (
        <div className="panel-title-row">
          <input
            className="panel-title-input"
            value={collection.name}
            onChange={(e) => patchCollection({ name: e.target.value })}
            aria-label="항목 이름"
          />
          {optional && <span className="tag">선택</span>}
        </div>
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
            const joinedIn = pay.status !== 'none'

            // 선택 항목인데 불참이면 축약 표시
            if (optional && !joinedIn) {
              return (
                <li key={p.id} className="participant opt-out">
                  <span className="pname">{p.name}</span>
                  {readOnly ? (
                    <span className="muted">불참</span>
                  ) : (
                    <label className="join">
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => setJoin(p.id, true, pay)}
                      />
                      참여
                    </label>
                  )}
                </li>
              )
            }

            return (
              <li key={p.id} className="participant">
                <span className="pname">{p.name}</span>

                {optional && !readOnly && (
                  <label className="join on">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => setJoin(p.id, false, pay)}
                    />
                    참여
                  </label>
                )}

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

                {readOnly ? (
                  <span className={`status-badge ${pay.status}`}>
                    {statusLabel(pay.status)}
                  </span>
                ) : (
                  <label className={`unpaidbox ${pay.status === 'unpaid' ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={pay.status === 'unpaid'}
                      onChange={(e) => setUnpaid(p.id, e.target.checked)}
                    />
                    미납
                  </label>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="mini-summary">
        <div>
          걷힘 <b>{won(collected)}</b> / {won(expected)}
          {optional && <span className="muted"> · 참여 {joined.length}명</span>}
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
