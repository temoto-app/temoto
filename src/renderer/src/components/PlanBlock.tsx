/**
 * The plan in the timeline (item 167, ARCHITECTURE.md 4.2.3).
 *
 * Shows the body of the plan-presentation tool call (`tool_use.payload.plan`) collapsed inside the tool frame.
 * When the AI enters plan mode on its own while Plan is OFF, the plan passes automatically without an approval frame,
 * so this is the only place where the user can read it. A plan already seen in the approval frame while Plan was ON
 * can also be read here later in the same form.
 *
 * The Markdown body reuses ThreadPane's rendering (`renderMarkdown` + DOMPurify, copy button).
 * To avoid two parallel component sets (5.1 / 7.4), the caller passes the rendering function as `renderBody`.
 */
import { useState } from 'react'
import { useT } from '../i18n/index.js'
import { useFindPending } from '../threadFindStore.js'

export function PlanBlock({
  plan,
  renderBody,
  findKey
}: {
  plan: string
  renderBody: (text: string) => React.ReactNode
  /** Key for also searching the collapsed body during in-thread search (TODO 496). Without it, nothing is searched (e.g. inside an approval frame). */
  findKey?: string
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const lines = plan.split('\n').filter((line) => line.trim() !== '').length
  const pending = useFindPending(findKey ?? '', findKey === undefined ? '' : plan, open, () => setOpen(true))
  return (
    <div className="plan-block" {...pending}>
      <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="plan-label">{t('timeline.plan.label')}</span>
        <span className="plan-meta">
          {t(lines === 1 ? 'timeline.plan.lines.one' : 'timeline.plan.lines.other', { count: lines })}
        </span>
      </button>
      {open ? <div className="plan-body">{renderBody(plan)}</div> : null}
    </div>
  )
}
