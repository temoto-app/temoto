/**
 * One line marking a conversation boundary (item 117, ARCHITECTURE.md 4.5.3.1). Draws the timeline's `boundary` item.
 *
 * - Reset: what is above this no longer goes to the model (the backend starts over as a new conversation).
 * - Compaction: what is above this was replaced by a summary. Manual (a command) and automatic (the context is full) are distinguished,
 *   and the token counts before and after for the conversation part are attached (they exclude the system prompt etc., so they do not match the donut).
 *
 * The command name is not written (constraint 6). It only says what happened.
 */
import type { TimelineItem } from '../thread/timeline.js'
import { useT } from '../i18n/index.js'
import { formatTokens } from '../thread/subtasks.js'

type BoundaryItem = Extract<TimelineItem, { kind: 'boundary' }>

export function ConversationBoundary({ item }: { item: BoundaryItem }): React.JSX.Element {
  const t = useT()
  const label =
    item.boundary === 'reset'
      ? t('timeline.boundary.reset')
      : item.trigger === 'auto'
        ? t('timeline.boundary.compactedAuto')
        : t('timeline.boundary.compacted')
  const tokens =
    item.boundary === 'compacted' && item.preTokens !== null && item.postTokens !== null
      ? ` ${t('timeline.boundary.tokens', {
          pre: formatTokens(item.preTokens),
          post: formatTokens(item.postTokens)
        })}`
      : ''
  return (
    <div className={`timeline-boundary boundary-${item.boundary}`} role="separator">
      <span>
        {label}
        {tokens}
      </span>
    </div>
  )
}
