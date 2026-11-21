import type { JsonValue } from '../shared/agent.js'

/** Storage limit for one argument string. Write's content etc. are cut here (ARCHITECTURE 4.3.1). */
export const MAX_ARG_CHARS = 1000
/** Storage limit for one array (item count). */
export const MAX_ARG_ITEMS = 50

/** Whether it is a non-array object (shared with parse.ts). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reduces a value to something passable as JSON. Long strings and arrays are truncated (a mark is left in `truncated.hit`),
 * and cycles are not carried over. The `tool_use` arguments (parse.ts) and the `permission_request` input
 * (ThreadStore.toPersistable, migration 29) use the same rule (TODO 838).
 */
export function toJsonValue(value: unknown, truncated: { hit: boolean }): JsonValue {
  if (typeof value === 'string') {
    if (value.length > MAX_ARG_CHARS) {
      truncated.hit = true
      return `${value.slice(0, MAX_ARG_CHARS)}… (${value.length} chars)`
    }
    return value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length > MAX_ARG_ITEMS) truncated.hit = true
    return value.slice(0, MAX_ARG_ITEMS).map((item) => toJsonValue(item, truncated))
  }
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) out[key] = toJsonValue(child, truncated)
    return out
  }
  return String(value)
}

/** Clips an approval request's input for storage. The `truncated` mark is not used on approval rows, so it is discarded. */
export function clipPermissionInput(input: JsonValue): JsonValue {
  return toJsonValue(input, { hit: false })
}
