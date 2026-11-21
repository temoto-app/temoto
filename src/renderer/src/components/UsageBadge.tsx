/**
 * The usage badge of the BottomBar (item 317, wave 17 bundle B). A short one-word label like `5h 11% · 7d 1%`; pressing it opens upward a floating panel with the same
 * details (`UsageDetails`) as the VS Code extension's "ACCOUNT & USAGE".
 *
 * - There is one value for the whole app per account (`usageStore`). If none has ever been received, the badge is not shown at all.
 * - When the status is `allowed_warning` / `rejected`, or metered, it uses the warning color.
 * - BottomBar is `overflow: hidden`, so the panel is placed above the badge with `position: fixed`.
 *   It closes on pressing outside or on Esc.
 * - TODO 377: next to each window's text, a small horizontal bar of the same color as the bars in the settings "Account and usage"
 *   is added (`usageBadgeParts`). It is decoration, so `aria-hidden` - the numbers can be read as text. In a narrow window
 *   `@container bottom-bar` (styles.css) drops the bar first.
 */
import { useEffect, useRef, useState } from 'react'
import { usageNeedsAttention } from '@shared/usage.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { ensureUsage, useNow, useUsage } from '../usageStore.js'
import { usageBadgeParts } from '../usage-format.js'
import { UsageDetails } from './UsageDetails.js'
import { Tooltip } from './Tooltip.js'

interface Anchor {
  readonly right: number
  readonly bottom: number
}

export function UsageBadge(): React.JSX.Element | null {
  const t = useT()
  const snapshot = useUsage((state) => state.snapshot)
  const email = useThreads((state) => state.agent?.email ?? null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const root = useRef<HTMLSpanElement | null>(null)
  const now = useNow(anchor === null ? 60_000 : 15_000)

  useEffect(() => ensureUsage(), [])

  useEffect(() => {
    if (anchor === null) return
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setAnchor(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAnchor(null)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor])

  if (snapshot === null) return null
  const parts = usageBadgeParts(snapshot, now, t)
  if (parts.length === 0) return null
  const warn = usageNeedsAttention(snapshot)

  const toggle = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (anchor !== null) {
      setAnchor(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setAnchor({
      right: Math.max(4, window.innerWidth - rect.right),
      bottom: Math.max(4, window.innerHeight - rect.top + 4)
    })
  }

  return (
    <span className={`usage-badge${warn ? ' warn' : ''}`} ref={root}>
      <Tooltip content={t('usage.badge.title')}>
        <button type="button" aria-expanded={anchor !== null} aria-haspopup="dialog" onClick={toggle}>
          {parts.map((part, index) => (
            <span className="usage-badge-part" key={part.key}>
              {index === 0 ? null : <span className="usage-badge-sep"> · </span>}
              {part.label}
              {part.barWidth === null ? null : (
                <span className="usage-badge-bar" aria-hidden="true">
                  <span className="usage-badge-bar-fill" style={{ width: `${part.barWidth}%` }} />
                </span>
              )}
            </span>
          ))}
        </button>
      </Tooltip>
      {anchor === null ? null : (
        <div
          className="usage-popover"
          role="dialog"
          aria-label={t('usage.popover.title')}
          style={{ right: anchor.right, bottom: anchor.bottom }}
        >
          <UsageDetails snapshot={snapshot} email={email} now={now} />
        </div>
      )}
    </span>
  )
}
