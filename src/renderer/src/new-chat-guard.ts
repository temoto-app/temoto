/**
 * Guard against rapid presses of "new chat right now in this cwd" (`NewChatButton`, items 255 / 263) (item 280-3).
 *
 * The create IPC finishes in under 15 ms, and when it does, **the new thread (same cwd) is selected and the same button appears in the same place**.
 * With only a per-button busy flag, the second press of a human double press (reproduced at 15 ms / 80 ms intervals) hits the new button and
 * 2 threads get created. So **while creating** and **for `NEW_CHAT_COOLDOWN_MS` right after creating**, creation for the same cwd is not accepted.
 * The heading, the cwd-order heading and the tree row are all `NewChatButton`, so this one table is enough.
 *
 * A collection of pure functions, independent of the DOM and React (`test/new-chat-guard.test.ts`). The caller passes the time.
 */

/** For this long (ms) right after creation, creation for the same cwd is not accepted. */
export const NEW_CHAT_COOLDOWN_MS = 500

/** State per cwd. `endedAt === null` means it is being created. */
export type NewChatLedger = Map<string, { startedAt: number; endedAt: number | null }>

/** The table shared across buttons. `NewChatButton` and the "New skill…" in settings Skills (TODO 824) share it. */
export const sharedNewChatLedger: NewChatLedger = new Map()

/** No-affiliation (the scratch area, `uri === null`) is also one key (pressing repeatedly would make 2 scratch areas). */
export function newChatKey(uri: string | null): string {
  return uri === null ? '\0scratch' : uri
}

/** Whether a request may be accepted now. */
export function canStartNewChat(ledger: NewChatLedger, key: string, now: number): boolean {
  const entry = ledger.get(key)
  if (entry === undefined) return true
  if (entry.endedAt === null) return false
  return now - entry.endedAt >= NEW_CHAT_COOLDOWN_MS
}

/** On accepting. If it cannot be accepted, return false and change nothing. */
export function beginNewChat(ledger: NewChatLedger, key: string, now: number): boolean {
  if (!canStartNewChat(ledger, key, now)) return false
  ledger.set(key, { startedAt: now, endedAt: null })
  return true
}

/** When creation ends (success or failure). On failure, remove it from the table so the user can press again immediately without waiting. */
export function endNewChat(ledger: NewChatLedger, key: string, now: number, ok: boolean): void {
  if (!ok) {
    ledger.delete(key)
    return
  }
  ledger.set(key, { startedAt: ledger.get(key)?.startedAt ?? now, endedAt: now })
  // Sweep out cooled rows so the table does not grow.
  for (const [k, v] of ledger) {
    if (v.endedAt !== null && now - v.endedAt >= NEW_CHAT_COOLDOWN_MS) ledger.delete(k)
  }
}
