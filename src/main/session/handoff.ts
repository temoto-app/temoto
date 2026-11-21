/**
 * The main-side pure functions of "lighten and continue in a new conversation" (TODO 961). The body of the assembly is `@shared/handoff.ts`.
 *
 * - The source events are the whole original thread (including the transcript's past part, the same path as exporting a conversation), but **only those after the last
 *   conversation reset (`conversation_reset`, `/clear`)**. Before that is a conversation that has already left the model, so it is not carried over.
 *   What is before a compaction (`context_compacted`) is kept: it is the original messages and the answer text that were summarized, and the model holds only the summary.
 * - `redactText` is applied to the body (saved rows have been through `toPersistable`, but the transcript's past part has not).
 */
import type { AiosEvent } from '@shared/agent.js'
import { buildExportTurns, type ExportTurn } from '@shared/conversation-export.js'
import { redactText } from '../../common/redact.js'

/** Events after the last reset of the parent conversation. All of them if there is no reset. */
export function eventsSinceReset(events: readonly AiosEvent[]): readonly AiosEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'conversation_reset' && event.actor !== 'subagent' && event.parentToolUseId === undefined) {
      return events.slice(i + 1)
    }
  }
  return events
}

/** The turns to carry over (already redacted). */
export function handoffTurns(events: readonly AiosEvent[]): ExportTurn[] {
  return buildExportTurns(eventsSinceReset(events), (text) => redactText(text).text)
}

/**
 * Of the whole original thread, the part that has already reached the destination of the branch / handoff (item 1 of TODO 992). null if `eventId` is not found.
 *
 * - `before` (a rewind branch, item 113): **up to just before** that message: a branch carries over the conversation up to the response before that message.
 * - `through` (handoff, TODO 961): **to the end of that message's turn** (just before the next parent message): `eventId` is the last message of the original
 *   thread at the time the handoff was made, and the text attached to the first send was built from the conversation up to there (anything the
 *   original thread advanced between creating it and the first send is unknown, so it is not included).
 */
export function inheritedEvents(
  events: readonly AiosEvent[],
  eventId: string,
  mode: 'before' | 'through'
): readonly AiosEvent[] | null {
  const at = events.findIndex((event) => event.id === eventId)
  if (at < 0) return null
  if (mode === 'before') return events.slice(0, at)
  for (let i = at + 1; i < events.length; i++) {
    const event = events[i]!
    if (event.kind === 'user_text' && event.actor !== 'subagent' && event.parentToolUseId === undefined) {
      return events.slice(0, i)
    }
  }
  return events
}

/** The id of the last user message that is in `ownIds` (the thread's own rows). It does not point at a message inherited from an ancestor (TODO 992). */
export function lastOwnQuestionId(turns: readonly ExportTurn[], ownIds: ReadonlySet<string>): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const question = turns[i]!.question
    if (question !== null && ownIds.has(question.id)) return question.id
  }
  return null
}
