/**
 * The order of the file tree (TODO 872, wave 43 bundle C). Two choices close to VS Code's `explorer.sortOrder`:
 * `modified` = directories first (by name), files by modified time, newest first (same time by name). `name` = directories first, by name.
 * The default is `modified` (owner decision 2026-10-18). The sorting itself is the SQL of the index process (`IndexStore.children`).
 */
export const FILE_SORT_ORDERS = ['modified', 'name'] as const

export type FileSortOrder = (typeof FILE_SORT_ORDERS)[number]

export const DEFAULT_FILE_SORT_ORDER: FileSortOrder = 'modified'

export function isFileSortOrder(value: unknown): value is FileSortOrder {
  return value === 'modified' || value === 'name'
}
