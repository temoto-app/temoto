/**
 * Judging an interrupted answer (TODO 521, wave 26 bundle B). A pure function that touches neither electron nor the DB, and
 * `test/interrupt.test.ts` checks it as is. SessionManager calls it on every event and writes
 * `threads.interrupted` (migration 21) according to the result.
 *
 * - **Hint** (`nextInterruptHint`): "why it might stop", which arrives mid-turn. `api_retry` is
 *   classified by status code (none = cannot connect, 429 = limit, other = the API side). A `rejected` `rate_limit` is a limit.
 *   Held until the turn ends (`result`) or the process ends, and used for the kind of failure.
 * - **Mark change** (`interruptChange`): set by a failed `result` (excluding one stopped by an interrupt).
 *   Cleared when the parent's body, thinking, a tool or usage arrives, or by a successful `result` that called the model (= the next turn started normally.
 *   Not cleared by the successful `result` of an empty turn, TODO 1184).
 *   The end of the process in the middle of a turn is set separately by SessionManager's `onAgentExit` (there may be no event).
 */
import type { AiosEvent, ResultPayload } from '@shared/agent.js'
import type { InterruptReason } from '@shared/thread.js'

/** The parent kinds that can be read as "the next turn started normally" (the same members as SessionManager's `TURN_CONTENT_KINDS`). */
const STARTED_KINDS: ReadonlySet<AiosEvent['kind']> = new Set<AiosEvent['kind']>([
  'assistant_delta',
  'assistant_text',
  'thinking_delta',
  'tool_use',
  'turn_usage'
])

/** Whether the model was actually called in this result's turn (both turns and usage are positive). */
function calledModel(payload: ResultPayload): boolean {
  const u = payload.usage
  return payload.turns > 0 && u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens > 0
}

/** The kind of interruption from an HTTP status code. null means the connection itself failed. */
export function reasonOfRetryStatus(status: number | null): InterruptReason {
  if (status === null) return 'interrupt-network'
  if (status === 429) return 'interrupt-limit'
  return 'interrupt-server'
}

/** The mid-turn hint. Returning `current` means unchanged. Back to null on `result`. */
export function nextInterruptHint(current: InterruptReason | null, event: AiosEvent): InterruptReason | null {
  if (event.kind === 'api_retry') return reasonOfRetryStatus(event.payload.errorStatus)
  if (event.kind === 'rate_limit' && event.payload.status === 'rejected') return 'interrupt-limit'
  if (event.kind === 'result') return null
  return current
}

/**
 * What to do with the mark. `set` sets it (the value is the kind), `clear` clears it, null leaves it alone.
 * `hint` is the hint **from before this event was received** (used for the kind of a failed `result`).
 */
export function interruptChange(
  hint: InterruptReason | null,
  event: AiosEvent
): { readonly kind: 'set'; readonly reason: InterruptReason } | { readonly kind: 'clear' } | null {
  if (event.actor !== 'main') return null
  if (event.kind === 'result') {
    // Authentication expiry (TODO 893). The mark the Adapter identified comes first: set regardless of the value of `ok` (the CLI's synthesized response).
    if (event.payload.authFailed === true) return { kind: 'set', reason: 'interrupt-auth' }
    // TODO 1184: even on success, a result that ended without calling the model (an empty turn the CLI started by itself on a subagent notice:
    // turns is 0 or usage is 0) is not evidence that "the next turn started normally". Do not clear (if body etc. arrives, STARTED_KINDS clears it).
    if (event.payload.ok) return calledModel(event.payload) ? { kind: 'clear' } : null
    // A turn the user stopped with an interrupt (item 94) is not marked as interrupted: they know the result.
    if (event.payload.interrupted === true) return null
    return { kind: 'set', reason: hint ?? 'interrupt-error' }
  }
  // A launch failure (the process never came up). An end in the middle of a turn (`exit`) is seen by onAgentExit.
  if (event.kind === 'error' && event.payload.origin === 'spawn') {
    return { kind: 'set', reason: hint ?? 'interrupt-error' }
  }
  if (STARTED_KINDS.has(event.kind)) return { kind: 'clear' }
  return null
}

/** The kind when the process ends in the middle of a turn. */
export function reasonOfExit(hint: InterruptReason | null): InterruptReason {
  return hint ?? 'interrupt-exit'
}
