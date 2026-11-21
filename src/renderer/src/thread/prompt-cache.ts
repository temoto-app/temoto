/**
 * The decision for notifying, in a band above the Composer, that the prompt cache has expired (TODO 963 (3)). Pure functions, with regression tests in `test/prompt-cache-bar.test.ts`.
 * It is drawn by `components/PromptCacheBar.tsx`.
 *
 * - **The lifetime is only the value the Adapter put in `result.cacheTtlMs`** (`lastTurnCache` of TODO 466, constraint 6). The renderer does not know the CLI's
 *   lifetime. If it is nowhere, the band is not shown (old rows, backends that do not report it).
 * - **The starting point is the end of the last turn** (the time of the `result` row). The cache is extended on every call, so the last extension was
 *   the turn's last API call = just before the end of the turn. In the estimate of TODO 962 the difference between the start and the end of a call is under 1 minute, and
 *   which one is the starting point could not be told from the transcript (the end of `docs/notes/cli-features.md`).
 * - **N is the total input of the last call** (input + cache_read + cache_creation, same as the numerator of the usage donut).
 *   The next send will roughly rewrite this. Token counts only, no amounts (constraint 4 / item 165).
 * - Not shown while responding or awaiting approval (that turn is reading and rewriting the cache). **No automatic keep-alive** (decision of TODO 963).
 */
import type { ContextUsage } from '@shared/thread.js'

/** The time the cache expires. null if the lifetime or the starting point is unknown. */
export function cacheExpiresAt(endedAt: number | null, ttlMs: number | null): number | null {
  if (endedAt === null || ttlMs === null || !Number.isFinite(endedAt) || !(ttlMs > 0)) return null
  return endedAt + ttlMs
}

/** The size of the conversation that the next send re-reads (the total input of the last call). null if unknown. */
export function conversationTokens(usage: ContextUsage | null): number | null {
  if (usage === null) return null
  const total = Math.max(0, usage.inputTokens) + Math.max(0, usage.cacheReadTokens) + Math.max(0, usage.cacheCreationTokens)
  return total > 0 ? total : null
}

export interface CacheBarState {
  /** The size of the conversation that the next send re-reads (tokens). */
  readonly tokens: number
}

/**
 * Whether to show the band. Shown if not responding, the lifetime, starting point, and conversation size are known, and now (`now`) is past the expiry time.
 * null when not shown.
 */
export function cacheBarState(input: {
  readonly endedAt: number | null
  readonly ttlMs: number | null
  readonly usage: ContextUsage | null
  readonly active: boolean
  readonly now: number
}): CacheBarState | null {
  if (input.active) return null
  const expiresAt = cacheExpiresAt(input.endedAt, input.ttlMs)
  if (expiresAt === null || input.now < expiresAt) return null
  const tokens = conversationTokens(input.usage)
  return tokens === null ? null : { tokens }
}
