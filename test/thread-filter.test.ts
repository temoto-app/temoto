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

describe('プロジェクト名の一致 (TODO 1012)', () => {
  it('部分一致で、大文字小文字・全角半角を区別しない', () => {
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('dra'))).toBe(0)
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('DOT'))).toBe(1)
    expect(projectMatchRank('DragonDot', normalizeFilterQuery('aios'))).toBeNull()
    expect(projectMatchRank('ＡＩＯＳ', normalizeFilterQuery('aios'))).toBe(0)
    expect(projectMatchRank('設計メモ', normalizeFilterQuery('メモ'))).toBe(1)
  })

  it('前後の空白は無視し、空 (空白だけ) は絞り込まない', () => {
    expect(normalizeFilterQuery('  Dra ')).toBe('dra')
    expect(normalizeFilterQuery('   ')).toBe('')
  })

  it('前方一致が上、それぞれの中は元の並び', () => {
    const names = ['my-aios', 'aios', 'other', 'aios-tools', 'x-aios']
    expect(filterIndices(names, 'aios')).toEqual([1, 3, 0, 4])
  })

  it('selectProjectNames は絞り込まないときは空の定数 (selector の費用を払わない)', () => {
    const byId = { a: { thread: { cwdName: 'A' } }, b: { thread: { cwdName: 'B' } } } as unknown as Record<string, ThreadSummary>
    expect(selectProjectNames('', ['a', 'b'], byId)).toHaveLength(0)
    expect(selectProjectNames('x', ['a', 'b'], byId)).toEqual(['A', 'B'])
    expect(selectProjectNames('x', ['a', 'zz'], byId)).toEqual(['A', ''])
  })

  it('pickByIndices は並列の配列を絞る (空の定数はそのまま)', () => {
    expect(pickByIndices(['a', 'b', 'c'], [2, 0])).toEqual(['c', 'a'])
    const empty: readonly boolean[] = []
    expect(pickByIndices(empty, [1])).toBe(empty)
  })
})

describe('3 つの表示で効く・古い折りたたみを外す (TODO 1012)', () => {
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

  it('畳まれた行は絞り込まなければ「さらに表示」の裏に隠れる', () => {
    expect(ids(arrangeThreads('recent', rows))).toEqual(['1'])
  })

  for (const key of ['recent', 'unread', 'cwd'] as const) {
    it(`${key}: 絞り込み中は畳みを外して一致を全部出す`, () => {
      const keep = filterIndices(rows.map((r) => r.folderName), 'dra')
      const picked = keep.map((i) => ({ ...rows[i]!, collapsible: false }))
      const items = arrangeThreads(key, picked, null, true)
      expect(ids(items).sort()).toEqual(['2', '4'])
      expect(items.some((item) => item.kind === 'more')).toBe(false)
    })
  }

  it('toSortRows に畳みの材料を渡さなければ、どの行も畳まれない', () => {
    const rowsOut = toSortRows(['a', 'b'], [], [], [])
    expect(rowsOut.every((r) => !r.collapsible)).toBe(true)
  })
})

describe('欄の状態 (TODO 1012)', () => {
  it('閉じると文字も空に戻る。開くだけでは文字は変わらない', () => {
    const s = useThreadFilter.getState()
    s.setOpen(true)
    s.setQuery('dra')
    expect(useThreadFilter.getState().query).toBe('dra')
    s.setOpen(false)
    expect(useThreadFilter.getState()).toMatchObject({ open: false, query: '' })
  })

  it('IME の変換中は反映せず、確定で反映する', () => {
    expect(shouldApplyFilter(true)).toBe(false)
    expect(shouldApplyFilter(false)).toBe(true)
  })

  it('永続化しない・⌘F を奪わない・色は変数だけ (ソース)', () => {
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
