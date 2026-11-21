/**
 * How to render the snippet of a conversation search (⌘K) result row (TODO 621, continuing 519, an observation of wave-33 proxy verification 620).
 *
 * What 519 changed, to render the attachment mark of one's own message (the Japanese "attachment: name" mark in parentheses) in the display language, applied only to the timeline
 * (`foldTimeline`). The ⌘K result snippet (the body cut from the index) arrives from main
 * as is, so the Japanese mark remained even in EN display. The same `relabelAttachmentMarks` is now applied at the
 * rendering point too, limited to one's own messages (`contextCode === 'user'`) (applying it to other hits would also be safe, since
 * `relabelAttachmentMarks` returns the input as is when there is no mark, but pointless).
 *
 * Only pure functions independent of React and the DOM live here (a thin layer just called from `SearchMode.tsx`).
 */
import type { SearchHit } from '@shared/search.js'
import { relabelAttachmentMarks } from '@shared/attachment-mark.js'
import type { Translate } from './i18n/index.js'

export function conversationSnippet(t: Translate, hit: SearchHit): string {
  if (hit.contextCode !== 'user') return hit.snippet
  return relabelAttachmentMarks(hit.snippet, (name) => t('timeline.user.attachmentMark', { name }))
}
