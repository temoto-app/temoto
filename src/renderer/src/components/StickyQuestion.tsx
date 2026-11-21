/**
 * Pins "my own question" that the answer belongs to at the top edge of ThreadPane (TODO 355, wave 19 bundle A, ARCHITECTURE.md 5.1.4).
 *
 * While scrolling through a long answer, so that what was asked does not disappear from the screen, **only one question, that of the
 * section the top row belongs to,** is overlaid at the top (an "overlay" form like VS Code's Sticky Scroll; it takes no space).
 *
 * - The decision is `stickyId` of `useJumpNav` (riding on the same `sync`, `stickyQuestionIndex` in `thread/jump.ts`).
 *   While that question itself is visible, or while above the first question, it is null and nothing is drawn.
 * - **It is not placed inside `.thread-body`** (the same reason as JumpNav: children are looked up by `ev-<id>`, and the "load more" scroll
 *   correction (item 88) and `pinned` are involved). A zero-height sibling is put right before `.thread-body`, and
 *   the frame inside is overlaid absolutely on the top edge of the body.
 * - What counts as a question is the same as the jump box (`kind: 'user'` of `folded.items`; subagent messages are not included).
 * - The text is folded to one line (`stickyQuestionText`, newlines become spaces), and the visual truncation is CSS line-clamp (2 lines + "...").
 * - Pressing it jumps to that question (`jumpToQuestion`: place it at the top with a margin, and apply `highlighted`). Since it is a
 *   button with text, the description is the OS `title` (the line drawn by item 320).
 */
import { useMemo } from 'react'
import type { TimelineItem } from '../thread/timeline.js'
import { stickyQuestionText } from '../thread/jump.js'
import type { JumpNavHandle } from './JumpNav.js'
import { useT } from '../i18n/index.js'

export function StickyQuestion({
  handle,
  items
}: {
  handle: JumpNavHandle
  items: readonly TimelineItem[]
}): React.JSX.Element | null {
  const t = useT()
  const { stickyId, jumpToQuestion } = handle
  const text = useMemo(() => {
    if (stickyId === null) return null
    const item = items.find((it) => it.id === stickyId)
    return item === undefined || item.kind !== 'user' ? null : stickyQuestionText(item.text)
  }, [stickyId, items])
  if (stickyId === null || text === null || text === '') return null
  return (
    <div className="sticky-question-host">
      <button
        type="button"
        className="sticky-question"
        title={t('jumpNav.sticky')}
        onClick={() => jumpToQuestion(stickyId)}
      >
        <span className="sticky-question-text">{text}</span>
      </button>
    </div>
  )
}
