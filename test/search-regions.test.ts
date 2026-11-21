/**
 * Item 292: the "this working folder" section of search results. Even when a search of the cwd gives 0 results, it shows the subheading and one line of notice.
 */
import { describe, expect, it } from 'vitest'
import { regionRows } from '../src/renderer/src/search-regions.js'

const labels = { cwd: 'This folder', all: 'Everywhere', cwdEmpty: (p: string) => `none in ${p}` }
const hit = (id: string): { kind: 'hit'; id: string } => ({ kind: 'hit', id })
const kinds = (rows: readonly { kind: string }[]): string[] => rows.map((r) => r.kind)

describe('item 292: regionRows', () => {
  it('searching cwd gives 0 hits -> subheading + note + whole region', () => {
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

  it('no cwd (not searched) -> no note, only the whole-region subheading', () => {
    const rows = regionRows({ prefix: 'n', cwd: null, cwdRows: [], allCount: '1', allRows: [hit('a')], labels })
    expect(kinds(rows)).toEqual(['region', 'hit'])
  })

  it('cwd has a hit -> no note, as before', () => {
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

  it('both 0 hits -> shows nothing (as before)', () => {
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
