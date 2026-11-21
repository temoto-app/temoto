/**
 * A selection across backends in the Composer's Model picker (TODO 1018, the decision of 874, ARCHITECTURE 4.6.1).
 * A pure function that the renderer (the wording of the picker rows) and main (the actual switch) use for the same decision.
 *
 * - `same`: switching models within the same backend. The thread stays as it is (`switchSettings`, takes effect on the next send).
 * - `in-place`: a thread that has not sent a single message yet. The row's `backend` is changed on the spot (it is fixed when sending).
 * - `fork`: a thread with a conversation. It branches into a new thread, and a transcript of the conversation is attached to the first send (the same route as the handoff of 961).
 *
 * "Not sent yet" is judged by the absence of the list-order key (`lastEventAt`, set by sending). A thread continued from a transcript
 * (111) and a rewind branch (113) start by taking over the session of the original conversation, so they cannot be switched even before sending;
 * however the handoff of 961 (`handoff`) starts from empty, so switching is allowed. In addition to this decision, main re-checks with an SQL condition that there is
 * no process and no session row (if that fails, it falls back to a fork).
 */
import type { Thread } from './thread.js'

export type BackendSwitchKind = 'same' | 'in-place' | 'fork'

export function backendSwitchKind(
  thread: Pick<Thread, 'backend' | 'lastEventAt' | 'transcriptOrigin' | 'forkedFrom'>,
  targetBackend: string
): BackendSwitchKind {
  if (thread.backend === targetBackend) return 'same'
  return canSwitchBackendInPlace(thread) ? 'in-place' : 'fork'
}

/** Whether the thread has not sent a single message yet and does not take over the original conversation's session. */
export function canSwitchBackendInPlace(
  thread: Pick<Thread, 'lastEventAt' | 'transcriptOrigin' | 'forkedFrom'>
): boolean {
  if (thread.lastEventAt !== null) return false
  if (thread.transcriptOrigin !== null) return false
  return thread.forkedFrom === null || thread.forkedFrom.handoff === true
}
