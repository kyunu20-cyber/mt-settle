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

// URL 토큰이 잘렸을 때, 기기에 저장된 더 온전한 토큰을 우선 사용
function bestToken(id: string, urlToken: string): string {
  const saved = loadAdmin()
  if (saved && saved.id === id && saved.token && saved.token.length > urlToken.length) {
    return saved.token
  }
  return urlToken
}

const isTokenErr = (e: unknown) => {
  const m = String((e as { message?: string })?.message ?? e)
  return /invalid token|not found|P0001/i.test(m)
}

type Status = 'idle' | 'loading' | 'saving' | 'saved' | 'error' | 'notfound'

const statusText = (s: Status) =>
  s === 'saving' ? '저장 중…' : s === 'saved' ? '저장됨' : s === 'error' ? '저장 실패 · 재시도됨' : ''

const editSaveText = (s: Status) =>
  s === 'saving' ? '저장 중…' : s === 'error' ? '⚠ 저장 안 됨 · 재시도' : '✓ 저장됨'

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute)
  const [board, setBoard] = useState<Board>(loadLocalBoard)
  const [status, setStatus] = useState<Status>('idle')
  const [tokenError, setTokenError] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const boardRef = useRef(board)
  boardRef.current = board
  const routeRef = useRef(route)
  routeRef.current = route

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 탭을 벗어나거나 앱을 닫을 때, 대기 중인 저장을 즉시 반영
  useEffect(() => {
    const flush = () => {
      const r = routeRef.current
      if (r.mode === 'edit' && saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        saveBoard(r.id, bestToken(r.id, r.token), boardRef.current).catch(() => {})
      }
    }
    const onVis = () => document.hidden && flush()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
    }
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
        if (route.mode === 'edit') {
          // 이미 같은 보드의 더 온전한 토큰이 있으면 덮어쓰지 않음
          const saved = loadAdmin()
          if (
            !(saved && saved.id === route.id && saved.token.length >= route.token.length)
          ) {
            saveAdmin({ id: route.id, token: route.token })
          }
        }
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
          saveBoard(route.id, bestToken(route.id, route.token), next)
            .then(() => {
              setStatus('saved')
              setTokenError(false)
            })
            .catch((e) => {
              setStatus('error')
              setTokenError(isTokenErr(e))
            })
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

  const commitSave = useCallback(() => {
    const r = routeRef.current
    if (r.mode !== 'edit') return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    setStatus('saving')
    saveBoard(r.id, bestToken(r.id, r.token), boardRef.current)
      .then(() => {
        setStatus('saved')
        setTokenError(false)
      })
      .catch((e) => {
        setStatus('error')
        setTokenError(isTokenErr(e))
      })
  }, [])

  // Cmd+S / Ctrl+S 로 즉시 저장 (브라우저 기본 저장창 방지)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        commitSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commitSave])

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

      <div className="sticky-summary">
        <div className="sticky-stats">
          <div className="stat">
            <span>현재 있는 돈</span>
            <b className={s.balance < 0 ? 'neg' : 'pos'}>{won(s.balance)}</b>
          </div>
          <div className="stat">
            <span>쓴 돈</span>
            <b>{won(s.expenseTotal)}</b>
          </div>
        </div>
        {route.mode === 'edit' && (
          <>
            <div className="save-line-row">
              <span className={`save-line ${status}`}>{editSaveText(status)}</span>
              <button
                className="save-btn"
                onClick={commitSave}
                disabled={status === 'saving'}
              >
                저장
              </button>
            </div>
            {status === 'error' && tokenError && (
              <div className="save-err">
                편집 링크가 잘린 것 같아요 · 처음 만든 편집 링크로 다시 열어주세요
              </div>
            )}
          </>
        )}
      </div>

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
