/**
 * How to lay out the search results' "this working folder" -> "everywhere" sections (items 100 / 292).
 * Pure functions. `SearchMode.tsx` passes its row (`Row`) type and uses them.
 *
 * The cwd section is shown when `cwd !== null` (= that section was **searched**; if there is no cwd or it is not in the index, main does not
 * return it and the store is also null). Even with 0 hits the subheading is shown, and below it a single `note` line
 * says "not found here" (item 292). If everywhere also has 0 hits, nothing is shown (the caller's
 * existing behavior).
 */

export interface RegionHeadRow {
  readonly kind: 'region'
  readonly id: string
  readonly label: string
  /** Only for the cwd section. The path for display, folded to `~`. */
  readonly path: string | null
  readonly count: string
}

/** The single line "0 hits in the cwd section" (item 292). */
export interface RegionNoteRow {
  readonly kind: 'note'
  readonly id: string
  readonly text: string
}

export interface RegionInput<R> {
  readonly prefix: string
  readonly cwd: { readonly path: string; readonly count: string } | null
  readonly cwdRows: readonly R[]
  readonly allCount: string
  readonly allRows: readonly R[]
  readonly labels: {
    readonly cwd: string
    readonly all: string
    /** The sentence "not found" with `path` filled in. */
    readonly cwdEmpty: (path: string) => string
  }
}

export function regionRows<R>(input: RegionInput<R>): (RegionHeadRow | RegionNoteRow | R)[] {
  const { prefix, cwd, cwdRows, allCount, allRows, labels } = input
  const out: (RegionHeadRow | RegionNoteRow | R)[] = []
  if (cwd !== null && (cwdRows.length > 0 || allRows.length > 0)) {
    out.push({
      kind: 'region',
      id: `${prefix}-r-cwd`,
      label: labels.cwd,
      path: cwd.path,
      count: cwd.count
    })
    if (cwdRows.length > 0) out.push(...cwdRows)
    else out.push({ kind: 'note', id: `${prefix}-r-cwd-empty`, text: labels.cwdEmpty(cwd.path) })
  }
  if (allRows.length > 0) {
    out.push({ kind: 'region', id: `${prefix}-r-all`, label: labels.all, path: null, count: allCount })
    out.push(...allRows)
  }
  return out
}
