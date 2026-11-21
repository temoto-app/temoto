/**
 * TODO 1012: narrowing by project name in the Threads list. A match (partial, case-insensitive, full-width / half-width), prefix matches first; it works in all three display modes; while narrowing, the old folds are removed; Esc; and the IME gate.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  filterIndices,
  normalizeFilterQuery,
  pickByIndices,
  projectMatchRank,
  selectProjectNames,
  shouldApplyFilter
} from '../src/renderer/src/thread-filter.js'
import { arrangeThreads, toSortRows, type SortRow } from '../src/renderer/src/thread-sort.js'
import { useThreadFilter } from '../src/renderer/src/threadFilterStore.js'
import type { ThreadSummary } from '../src/shared/thread.js'

describe('project name match (TODO 1012)', () => {
  it('partial match, ignoring case and full-width / half-width', () => {
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('dra'))).toBe(0)
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('DOT'))).toBe(1)
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('aios'))).toBeNull()
    expect(projectMatchRank('ＡＩＯＳ', normalizeFilterQuery('aios'))).toBe(0)
    expect(projectMatchRank('設計メモ', normalizeFilterQuery('メモ'))).toBe(1)
  })

  it('ignores surrounding whitespace, and empty (whitespace only) does not filter', () => {
    expect(normalizeFilterQuery('  Dra ')).toBe('dra')
    expect(normalizeFilterQuery('   ')).toBe('')
  })

  it('prefix matches come first, and the original order is kept within each group', () => {
    const names = ['my-aios', 'aios', 'other', 'aios-tools', 'x-aios']
    expect(filterIndices(names, 'aios')).toEqual([1, 3, 0, 4])
  })

  it('selectProjectNames returns an empty constant when not filtering (does not pay the selector cost)', () => {
    const byId = { a: { thread: { cwdName: 'A' } }, b: { thread: { cwdName: 'B' } } } as unknown as Record<string, ThreadSummary>
    expect(selectProjectNames('', ['a', 'b'], byId)).toHaveLength(0)
    expect(selectProjectNames('x', ['a', 'b'], byId)).toEqual(['A', 'B'])
    expect(selectProjectNames('x', ['a', 'zz'], byId)).toEqual(['A', ''])
  })

  it('pickByIndices narrows parallel arrays (the empty constant stays as is)', () => {
    expect(pickByIndices(['a', 'b', 'c'], [2, 0])).toEqual(['c', 'a'])
    const empty: readonly boolean[] = []
    expect(pickByIndices(empty, [1])).toBe(empty)
  })
})

describe('works in the 3 views and removes the old collapse (TODO 1012)', () => {
  const row = (id: string, name: string, collapsible = false): SortRow => ({
    id,
    attention: 0,
    folderKey: name === '' ? '' : `file:///${name}`,
    folderName: name,
    folderUri: name === '' ? null : `file:///${name}`,
    rainbow: null,
    collapsible
  })
  const rows = [row('1', 'aios'), row('2', 'DragonDot', true), row('3', 'aios', true), row('4', 'Dra-x', true)]
  const ids = (items: ReturnType<typeof arrangeThreads>): string[] =>
    items.flatMap((item) => (item.kind === 'thread' ? [item.id] : []))

  it('a collapsed row is hidden behind 「さらに表示」 unless filtering', () => {
    expect(ids(arrangeThreads('recent', rows))).toEqual(['1'])
  })

  for (const key of ['recent', 'unread', 'cwd'] as const) {
    it(`${key}: while filtering, removes the collapse and shows all matches`, () => {
      const keep = filterIndices(rows.map((r) => r.folderName), 'dra')
      const picked = keep.map((i) => ({ ...rows[i]!, collapsible: false }))
      const items = arrangeThreads(key, picked, null, true)
      expect(ids(items).sort()).toEqual(['2', '4'])
      expect(items.some((item) => item.kind === 'more')).toBe(false)
    })
  }

  it('when toSortRows is not given the collapse material, no row is collapsed', () => {
    const rowsOut = toSortRows(['a', 'b'], [], [], [])
    expect(rowsOut.every((r) => !r.collapsible)).toBe(true)
  })
})

describe('field state (TODO 1012)', () => {
  it('closing also resets the text to empty, and merely opening does not change the text', () => {
    const s = useThreadFilter.getState()
    s.setOpen(true)
    s.setQuery('dra')
    expect(useThreadFilter.getState().query).toBe('dra')
    s.setOpen(false)
    expect(useThreadFilter.getState()).toMatchObject({ open: false, query: '' })
  })

  it('does not reflect during IME composition and reflects on commit', () => {
    expect(shouldApplyFilter(true)).toBe(false)
    expect(shouldApplyFilter(false)).toBe(true)
  })

  it('not persisted, does not steal ⌘F, and colors only through variables (source)', () => {
    const store = readFileSync('src/renderer/src/threadFilterStore.ts', 'utf8')
    expect(store).not.toMatch(/localStorage|persist/)
    const list = readFileSync('src/renderer/src/components/ThreadList.tsx', 'utf8')
    expect(list).toContain('onCompositionEnd')
    expect(list).toContain("event.key !== 'Escape'")
    expect(list).not.toMatch(/metaKey[^\n]*'f'/i)
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const block = css.slice(css.indexOf('TODO 1012: the project name filter'), css.indexOf('.thread-filter-clear svg'))
    expect(block.length).toBeGreaterThan(0)
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
