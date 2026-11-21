/**
 * Item 292: the "this working folder" section of search results. Even when a search of the cwd gives 0 results, it shows the subheading and one line of notice.
 */
import { describe, expect, it } from 'vitest'
import { regionRows } from '../src/renderer/src/search-regions.js'

const labels = { cwd: 'This folder', all: 'Everywhere', cwdEmpty: (p: string) => `none in ${p}` }
const hit = (id: string): { kind: 'hit'; id: string } => ({ kind: 'hit', id })
const kinds = (rows: readonly { kind: string }[]): string[] => rows.map((r) => r.kind)

describe('項目 292: regionRows', () => {
  it('cwd を検索して 0 件 → 小見出し + note + 全域', () => {
    const rows = regionRows({
      prefix: 'n',
      cwd: { path: '~/git/papoo/', count: '0' },
      cwdRows: [],
      allCount: '1',
      allRows: [hit('a')],
      labels
    })
    expect(kinds(rows)).toEqual(['region', 'note', 'region', 'hit'])
    expect(rows[1]).toMatchObject({ kind: 'note', text: 'none in ~/git/papoo/' })
  })

  it('cwd が無い (検索しなかった) → note を出さず全域の小見出しだけ', () => {
    const rows = regionRows({ prefix: 'n', cwd: null, cwdRows: [], allCount: '1', allRows: [hit('a')], labels })
    expect(kinds(rows)).toEqual(['region', 'hit'])
  })

  it('cwd に当たりがある → 従来どおり note なし', () => {
    const rows = regionRows({
      prefix: 'n',
      cwd: { path: '~/x/', count: '1' },
      cwdRows: [hit('c')],
      allCount: '1',
      allRows: [hit('a')],
      labels
    })
    expect(kinds(rows)).toEqual(['region', 'hit', 'region', 'hit'])
  })

  it('両方 0 件 → 何も出さない (従来の扱い)', () => {
    const rows = regionRows({
      prefix: 'n',
      cwd: { path: '~/x/', count: '0' },
      cwdRows: [],
      allCount: '0',
      allRows: [],
      labels
    })
    expect(rows).toEqual([])
  })
})
