import { useCallback, useEffect, useRef, useState } from 'react'
import type { Board } from './types'
import { emptyBoard } from './types'
import RosterPanel from './components/RosterPanel'
import CollectionPanel from './components/CollectionPanel'
import ExpensePanel from './components/ExpensePanel'
import { summarize } from './lib/calc'
import { won } from './lib/format'
import { isCloudEnabled } from './lib/supabase'
import { createBoard, fetchBoard, saveBoard } from './lib/cloud'
import { editHash, editUrl, parseRoute, viewUrl, type Route } from './lib/route'

const STORAGE_KEY = 'mt-settle-board'

function loadLocalBoard(): Board {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...emptyBoard(), ...JSON.parse(raw) }
  } catch {
    /* 손상 시 빈 보드 */
  }
  return emptyBoard()
}

const ADMIN_KEY = 'mt-settle-admin'
type AdminRef = { id: string; token: string }

function loadAdmin(): AdminRef | null {
  try {
    const raw = localStorage.getItem(ADMIN_KEY)
    if (raw) return JSON.parse(raw) as AdminRef
  } catch {
    /* ignore */
  }
  return null
}
const saveAdmin = (ref: AdminRef) => {
  try {
    localStorage.setItem(ADMIN_KEY, JSON.stringify(ref))
  } catch {
    /* ignore */
  }
}
const clearAdmin = () => {
  try {
    localStorage.removeItem(ADMIN_KEY)
  } catch {
    /* ignore */
  }
}

type Status = 'idle' | 'loading' | 'saving' | 'saved' | 'error' | 'notfound'

const statusText = (s: Status) =>
  s === 'saving' ? '저장 중…' : s === 'saved' ? '저장됨' : s === 'error' ? '저장 실패 · 재시도됨' : ''

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute)
  const [board, setBoard] = useState<Board>(loadLocalBoard)
  const [status, setStatus] = useState<Status>('idle')
  const [publishing, setPublishing] = useState(false)
  const saveTimer = useRef<number | null>(null)

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 최초 로드: 저장된 관리자 정산판이 있으면 이어서 편집으로 이동
  useEffect(() => {
    if (parseRoute().mode !== 'local') return
    const saved = loadAdmin()
    if (saved) location.hash = editHash(saved.id, saved.token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    if (route.mode === 'local') {
      setBoard(loadLocalBoard())
      setStatus('idle')
      return
    }
    setStatus('loading')
    fetchBoard(route.id)
      .then((b) => {
        if (cancelled) return
        if (!b) return setStatus('notfound')
        setBoard({ ...emptyBoard(), ...b })
        setStatus('idle')
        if (route.mode === 'edit') saveAdmin({ id: route.id, token: route.token })
      })
      .catch(() => !cancelled && setStatus('error'))
    return () => {
      cancelled = true
    }
  }, [route])

  const readOnly = route.mode === 'view'

  const updateBoard = useCallback(
    (next: Board) => {
      setBoard(next)
      if (route.mode === 'local') {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        } catch {
          /* 용량 초과 등은 무시 */
        }
      } else if (route.mode === 'edit') {
        setStatus('saving')
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          saveBoard(route.id, route.token, next)
            .then(() => setStatus('saved'))
            .catch(() => setStatus('error'))
        }, 800)
      }
    },
    [route],
  )

  const publish = async () => {
    setPublishing(true)
    try {
      const { id, token } = await createBoard(board)
      saveAdmin({ id, token })
      location.hash = editHash(id, token)
    } catch {
      alert('업로드 실패. 잠시 후 다시 시도해주세요.')
    } finally {
      setPublishing(false)
    }
  }

  const startNew = () => {
    clearAdmin()
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    setBoard(emptyBoard())
    setStatus('idle')
    location.hash = ''
  }

  if (status === 'loading') {
    return (
      <div className="app">
        <p className="empty">불러오는 중…</p>
      </div>
    )
  }
  if (status === 'notfound') {
    return (
      <div className="app">
        <p className="empty">정산표를 찾을 수 없어요. 링크를 확인해주세요.</p>
        <button className="ghost" onClick={startNew}>
          새 정산 만들기
        </button>
      </div>
    )
  }

  const s = summarize(board)

  return (
    <div className="app">
      <header className="app-header">
        <input
          className="title-input"
          value={board.title}
          onChange={(e) => updateBoard({ ...board, title: e.target.value })}
          aria-label="정산 제목"
          readOnly={readOnly}
        />
        <p className="sub">
          {route.mode === 'view' && '참가자 조회 · 읽기전용'}
          {route.mode === 'edit' && '관리자 편집 · 클라우드 저장'}
          {route.mode === 'local' && '관리자 입력 · 이 기기에 임시 저장'}
        </p>
      </header>

      {!readOnly && (
        <ShareBar
          route={route}
          status={status}
          publishing={publishing}
          onPublish={publish}
          onNew={startNew}
          cloudEnabled={isCloudEnabled}
        />
      )}

      <RosterPanel board={board} onChange={updateBoard} readOnly={readOnly} />
      {board.collections.map((c) => (
        <CollectionPanel
          key={c.id}
          board={board}
          collection={c}
          onChange={updateBoard}
          readOnly={readOnly}
        />
      ))}
      <ExpensePanel board={board} onChange={updateBoard} readOnly={readOnly} />

      <section className="panel totals">
        <h2>정산 요약</h2>
        <div className="totals-grid">
          <div>
            <span>총 걷힘</span>
            <b>{won(s.collected)}</b>
          </div>
          <div>
            <span>총 지출</span>
            <b>{won(s.expenseTotal)}</b>
          </div>
          <div className="balance-tile">
            <span>남은 돈</span>
            <b className={s.balance < 0 ? 'neg' : 'pos'}>{won(s.balance)}</b>
          </div>
          <div>
            <span>1인당 지출 ({s.headcount}명)</span>
            <b>{won(s.perPerson)}</b>
          </div>
        </div>
      </section>

      <footer className="app-footer">MT 정산</footer>
    </div>
  )
}

function ShareBar({
  route,
  status,
  publishing,
  onPublish,
  onNew,
  cloudEnabled,
}: {
  route: Route
  status: Status
  publishing: boolean
  onPublish: () => void
  onNew: () => void
  cloudEnabled: boolean
}) {
  if (route.mode === 'local') {
    return (
      <div className="sharebar">
        {cloudEnabled ? (
          <button onClick={onPublish} disabled={publishing}>
            {publishing ? '올리는 중…' : '클라우드에 올려 공유하기'}
          </button>
        ) : null}
        <span className="hint">
          {cloudEnabled
            ? '올리면 참가자용 조회 링크가 생겨요'
            : '클라우드 미설정 — 이 기기에만 저장됩니다'}
        </span>
      </div>
    )
  }

  if (route.mode === 'edit') {
    const vLink = viewUrl(route.id)
    const eLink = editUrl(route.id, route.token)
    const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {})
    return (
      <div className="sharebar">
        <div className="share-block">
          <span className="share-label">✏️ 편집 링크 · 같이 정리할 사람</span>
          <div className="link-row">
            <input
              className="link"
              value={eLink}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button onClick={() => copy(eLink)}>복사</button>
          </div>
        </div>
        <div className="share-block">
          <span className="share-label">👀 조회 링크 · 참가자(읽기전용)</span>
          <div className="link-row">
            <input
              className="link"
              value={vLink}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button onClick={() => copy(vLink)}>복사</button>
          </div>
        </div>
        <div className="sharebar-foot">
          <span className="hint">{statusText(status)}</span>
          <button className="linklike" onClick={onNew}>
            새 정산 만들기
          </button>
        </div>
      </div>
    )
  }

  return null
}
