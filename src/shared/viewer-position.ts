/**
 * Validation of a document's view position (TODO 1146, ARCHITECTURE 5.3 "viewer back / forward"). Both values reported by the viewer (a plugin, an untrusted iframe) and
 * values read back from the JSON kept in main are used only after passing through here. It depends on neither the DOM nor electron, so
 * the renderer, main and the plugins (bridge) import the same thing in three places.
 *
 * - The type is `ViewerScrollPosition` (`{ kind, value }`) of `shared/plugin.ts`.
 * - `line` / `page` are safe integers of 1 or more; `offset` is a finite number of 0 or more rounded to an integer. Anything else is null (discarded).
 * - The position table (`ViewerPositionTable`) maps URI to position. Keys are limited to URIs of history steps (`prunePositions`).
 */
import type { ViewerScrollPosition, ViewerScrollPositionKind } from './plugin.js'

export const VIEWER_POSITION_KINDS: readonly ViewerScrollPositionKind[] = ['line', 'page', 'offset']

/** URI -> view position. The keys are only URIs of history steps (others are dropped by `prunePositions`). */
export type ViewerPositionTable = Readonly<Record<string, ViewerScrollPosition>>

function isKind(value: unknown): value is ViewerScrollPositionKind {
  return typeof value === 'string' && (VIEWER_POSITION_KINDS as readonly string[]).includes(value)
}

/** Validate a view position. null if unreadable. */
export function acceptViewerPosition(raw: unknown): ViewerScrollPosition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { kind, value } = raw as { kind?: unknown; value?: unknown }
  if (!isKind(kind) || typeof value !== 'number' || !Number.isFinite(value)) return null
  if (kind === 'offset') {
    const rounded = Math.round(value)
    return rounded >= 0 && Number.isSafeInteger(rounded) ? { kind, value: rounded } : null
  }
  return Number.isSafeInteger(value) && value >= 1 ? { kind, value } : null
}

export function samePosition(a: ViewerScrollPosition | undefined, b: ViewerScrollPosition | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.value === b.value
}

/** Look up the URI's position in the table (own keys only; inherited keys such as `__proto__` are ignored). */
export function positionOf(table: ViewerPositionTable | undefined, uri: string): ViewerScrollPosition | undefined {
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, uri)) return undefined
  return table[uri]
}

/**
 * Narrow the table down to `uris` (URIs of history steps) and re-validate the values. undefined if no position remains
 * (an empty `positions` is not written into the saved form).
 */
export function prunePositions(
  table: unknown,
  uris: readonly string[]
): ViewerPositionTable | undefined {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return undefined
  // Keys are URIs (untrusted values can arrive). Write into a table with no prototype so that even `__proto__` becomes an own key.
  const out = Object.create(null) as Record<string, ViewerScrollPosition>
  let count = 0
  for (const uri of new Set(uris)) {
    if (!Object.prototype.hasOwnProperty.call(table, uri)) continue
    const position = acceptViewerPosition((table as Record<string, unknown>)[uri])
    if (position === null) continue
    out[uri] = position
    count += 1
  }
  return count === 0 ? undefined : out
}
