/**
 * Record of API call retries (item 277, ARCHITECTURE.md 4.6 / 5.1.3). A pure function that touches neither
 * electron nor the DB; `test/api-retry.test.ts` checks it as is.
 *
 * - Keeps the last `api_retry` (not persisted) as the source of `ThreadRuntime.apiRetry`.
 * - Clears it once the retry has paid off (any of body, tool, usage, result or error arrives).
 * - The body of `error` is not carried in the first place (parse drops it).
 */
import type { AiosEvent } from '@shared/agent.js'
import type { ApiRetry } from '@shared/thread.js'

/** Kinds that mean the retry is over (succeeded or given up). */
const SETTLED_KINDS: ReadonlySet<AiosEvent['kind']> = new Set([
  'assistant_delta',
  'assistant_text',
  'thinking_delta',
  'tool_use',
  'tool_result',
  'turn_usage',
  'result',
  'error'
])

/** The new record. Returning `current` means nothing changed. */
export function nextApiRetry(current: ApiRetry | null, event: AiosEvent): ApiRetry | null {
  if (event.kind === 'api_retry') {
    const p = event.payload
    return {
      attempt: p.attempt,
      maxRetries: p.maxRetries,
      retryDelayMs: p.retryDelayMs,
      errorStatus: p.errorStatus,
      at: event.ts
    }
  }
  if (current !== null && SETTLED_KINDS.has(event.kind)) return null
  return current
}
