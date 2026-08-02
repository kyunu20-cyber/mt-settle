import { useState, type ReactNode } from 'react'

type Props = {
  header: ReactNode
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

export default function CollapsePanel({
  header,
  summary,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-main">{header}</div>
        <button
          type="button"
          className="collapse-btn"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? '접기' : '펼치기'}
        >
          {!open && summary ? (
            <span className="collapse-summary">{summary}</span>
          ) : null}
          <span className="chevron">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && <div className="panel-body">{children}</div>}
    </section>
  )
}
