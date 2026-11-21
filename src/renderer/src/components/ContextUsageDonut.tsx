/**
 * The context usage donut + `NN%` (item 60 / ARCHITECTURE.md 4.5.2).
 *
 * Arcs are drawn on an SVG `<circle>` with `stroke-dasharray` / `stroke-dashoffset` (no library).
 * The categories are the three billing categories (input / cache read / cache creation) + free space, and the colors are
 * `stroke: var(--usage-…)` (7.4.1: colors are variables only). The numeric computation is in `context-usage.ts` (pure functions).
 * When there is no denominator (a model not in the table / no response yet), nothing is drawn.
 * If the last call rewrote the cache (TODO 963, `cacheRewrite`), a dot is added at the donut's upper right.
 *
 * Pressing it opens the breakdown dialog (item 155, `ContextUsageDialog`). The thread is received as `threadId`, and
 * if omitted it is the thread being shown (the Composer is always for the thread being shown). The dialog is portaled
 * to `document.body` (`.composer-frame` is `overflow: hidden`).
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextUsage } from '@shared/thread.js'
import { contextUsageView } from '../context-usage.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { ContextUsageDialog } from './ContextUsageDialog.js'

/** 14px square. A height that fits on the same row as the `.composer-settings` text (11px). */
const SIZE = 14
const STROKE = 3
const R = (SIZE - STROKE) / 2
const C = 2 * Math.PI * R

export function ContextUsageDonut({
  usage,
  threadId
}: {
  readonly usage: ContextUsage | null
  readonly threadId?: string
}): React.JSX.Element | null {
  const t = useT()
  const activeThreadId = useThreads((state) => state.activeThreadId)
  const target = threadId ?? activeThreadId
  const [open, setOpen] = useState(false)
  const view = contextUsageView(usage, t)
  if (view === null) return null
  // Lay out the categories clockwise from 12 o'clock. dashoffset moves back by "the share so far".
  let offset = 0
  const arcs = view.segments.map((segment) => {
    const length = segment.fraction * C
    const arc = { key: segment.key, length, start: offset }
    offset += length
    return arc
  })
  return (
    <>
    <button
      type="button"
      className={`context-usage${view.overflow ? ' overflow' : ''}${view.cacheRewrite ? ' cache-rewrite' : ''}`}
      title={`${view.title}\n\n${t('contextDialog.open')}`}
      aria-label={t('context.ariaLabel', { percent: view.percent })}
      aria-haspopup="dialog"
      disabled={target === null}
      onClick={() => setOpen(true)}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="free" cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} />
        {arcs
          .filter((arc) => arc.length > 0)
          .map((arc) => (
            <circle
              key={arc.key}
              className={`seg ${arc.key}`}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              strokeWidth={STROKE}
              strokeDasharray={`${arc.length} ${C - arc.length}`}
              strokeDashoffset={-arc.start}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          ))}
      </svg>
      {/* TODO 963: a mark that the last call rewrote the cache. The sentence appears in title. */}
      {view.cacheRewrite ? <span className="cache-rewrite-mark" aria-hidden="true" /> : null}
      <span className="pct">{view.percent}%</span>
    </button>
    {open && target !== null
      ? createPortal(<ContextUsageDialog threadId={target} onClose={() => setOpen(false)} />, document.body)
      : null}
    </>
  )
}
