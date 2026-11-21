/**
 * Pure functions, display only, for filtering the Threads list by project name (TODO 1012).
 *
 * - The colored name at the top left of a row (`Thread.cwdName`) is matched, and so is the name of the row's Teammate (TODO 1288: a match on
 *   the Teammate's name keeps all of its conversations). Titles and bodies are not (that is Search's job).
 * - Substring match. Case and full-width / half-width (NFKC) are not distinguished. Prefix matches are listed first (the original order is kept within each).
 * - While filtering, the "old collapse" (TODO 659) is turned off (the caller `ThreadList` empties the collapse inputs).
 * - The text is per-window temporary state (`threadFilterStore.ts`, not persisted). No new IPC or DB.
 */
import type { ThreadSummary } from '@shared/thread.js'

/** Turns the typed text into the form to compare. Empty (including only surrounding whitespace) means no filtering. */
export function normalizeFilterQuery(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase()
}

/** 0 = prefix match, 1 = substring match, null = no match. `query` is already `normalizeFilterQuery`'d (empty prefix-matches everything). */
export function projectMatchRank(name: string, query: string): 0 | 1 | null {
  const target = name.normalize('NFKC').toLowerCase()
  if (target.startsWith(query)) return 0
  return target.includes(query) ? 1 : null
}

/** Indices of matching rows. Prefix matches first, original order within each. */
export function filterIndices(names: readonly string[], query: string): number[] {
  const prefix: number[] = []
  const inner: number[] = []
  names.forEach((name, index) => {
    const rank = projectMatchRank(name, query)
    if (rank === 0) prefix.push(index)
    else if (rank === 1) inner.push(index)
  })
  return [...prefix, ...inner]
}

/**
 * TODO 1288: like `filterIndices`, but a row also matches through the name of its Teammate (`roleNames[i]`, '' when it has none).
 * A row's rank is the better of the two. `roleNames` may be empty (no Teammates): then it is the same as `filterIndices`.
 */
export function filterIndicesWithRoles(names: readonly string[], roleNames: readonly string[], query: string): number[] {
  const prefix: number[] = []
  const inner: number[] = []
  names.forEach((name, index) => {
    const a = projectMatchRank(name, query)
    const roleName = roleNames[index] ?? ''
    const b = roleName === '' ? null : projectMatchRank(roleName, query)
    const rank = a === null ? b : b === null ? a : (Math.min(a, b) as 0 | 1)
    if (rank === 0) prefix.push(index)
    else if (rank === 1) inner.push(index)
  })
  return [...prefix, ...inner]
}

const NO_NAMES: readonly string[] = []

/**
 * The project name of each row in the order. A constant empty value when not filtering (so the selector cost is not paid).
 * It is an array of strings, so with `useShallow` it is not recomputed on updates where the names do not change.
 */
export function selectProjectNames(
  query: string,
  order: readonly string[],
  byId: Readonly<Record<string, ThreadSummary>>
): readonly string[] {
  if (query === '') return NO_NAMES
  return order.map((id) => byId[id]?.thread.cwdName ?? '')
}

/** Narrows a parallel array by indices. The empty constant (an input not used under that condition) is returned as is. */
export function pickByIndices<T>(items: readonly T[], keep: readonly number[]): readonly T[] {
  if (items.length === 0) return items
  return keep.map((index) => items[index] as T)
}

/**
 * A gate that waits for confirmation during IME composition. Input while composing goes only into the draft; it is applied on confirm (`compositionend`) or on input that is not composing.
 */
export function shouldApplyFilter(composing: boolean): boolean {
  return !composing
}
