/**
 * Intermediate reports and the spinner (ARCHITECTURE.md 5.1.3 / TODO 14 + 15).
 *
 * Split out of ThreadPane (others touch that file too, so the changes are gathered here).
 *
 * - **It is shown while "the turn is in progress" (`active`), not while "body text has arrived"**.
 *   It matters most while tools are running.
 * - **There is only one spinner element.** It is drawn once, last inside `.progress-lines`,
 *   and placed by absolute positioning at **the start of the last line**. When lines are added, React reuses the same DOM element,
 *   so a rebuild does not reset the rotation.
 * - **The waiting display disappears entirely at the end.** When `active` becomes false,
 *   it turns into a collapsed section together with the spinner, so **no code is needed to stop the spinner**.
 * - The shape is `aria-hidden`; `role="status"` / `aria-live="polite"` is on **the line (parent)**.
 * - It does not rotate under `prefers-reduced-motion: reduce` (styles.css).
 */
import { useState } from 'react'
import { openExternalLink } from '../markdown-link.js'
import { useStore } from '../store.js'
import { apiRetryText, progressLineText, type ProgressLine, type ProgressTurn } from '../thread/progress.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
// The spinner shape is `Spinner.tsx` (shared with the sidebar thread rows, TODO 45).
import { Spinner } from './Spinner.js'

function Line({ line }: { line: ProgressLine }): React.JSX.Element {
  const select = useStore((state) => state.select)
  const t = useT()
  const text = progressLineText(t, line)
  const href = line.href
  if (href === null) return <div className="progress-line">{text}</div>
  return (
    <div className="progress-line">
      <a
        href={href}
        title={href}
        onClick={(event) => {
          // Letting it pass through would just get it swallowed by main's will-navigate (5.1.1).
          event.preventDefault()
          if (href.startsWith('file:')) select(href)
          // Links in fetch results follow the same rule as the body (TODO 400): http(s) goes to the ViewerPane, shift / Cmd to the OS browser.
          else
            openExternalLink(href, { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey })
        }}
      >
        {text}
      </a>
    </div>
  )
}

function Lines({ turn, active }: { turn: ProgressTurn; active: boolean }): React.JSX.Element {
  const t = useT()
  // Item 277: only while an API retry is in progress, one line under the last line (not persisted; from main's record).
  const retry = useThreads((state) =>
    !active || state.activeThreadId === null ? undefined : state.threadsById[state.activeThreadId]?.runtime.apiRetry
  )
  return (
    <div className="progress-lines" role="status" aria-live="polite">
      {turn.omitted > 0 ? (
        <div className="progress-omitted">{t('progress.omitted', { n: turn.omitted })}</div>
      ) : null}
      {turn.lines.map((line) => (
        <Line key={line.id} line={line} />
      ))}
      {retry === undefined ? null : <div className="progress-line">{apiRetryText(t, retry)}</div>}
      {active && retry === undefined && turn.lines.length === 0 ? (
        <div className="progress-line">{t('progress.working')}</div>
      ) : null}
      {/* Only one spinner. CSS places it at the start of the last line. */}
      {active ? <Spinner /> : null}
    </div>
  )
}

/**
 * One turn. While responding the lines are listed as they are, and once the turn is final the same list is folded into a collapsed section
 * (so there is no mismatch where links suddenly appear at the moment of finalization).
 */
export function ProgressBlock({
  turn,
  active
}: {
  turn: ProgressTurn
  active: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const t = useT()
  if (!active && turn.lines.length === 0) return null
  if (active) {
    return (
      <div className="progress-block active">
        <Lines turn={turn} active />
      </div>
    )
  }
  const label =
    turn.referenced > 0
      ? t('progress.referenced', { count: turn.referenced })
      : t('progress.summary', { count: turn.lines.length })
  return (
    <div className="progress-block">
      <button type="button" className="progress-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open ? <Lines turn={turn} active={false} /> : null}
    </div>
  )
}
