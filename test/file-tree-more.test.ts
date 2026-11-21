// @vitest-environment jsdom
/**
 * "… N more" in the Files tree (TODO 904): a folder with more than 10 items shows the first 10 and one more row; pressing it shows all of them.
 */
import { describe, expect, it } from 'vitest'
import { selectRows, type TreeState } from '../src/renderer/src/store.js'
import { limitedAncestors, limitChildren, treeKeyAction } from '../src/renderer/src/file-tree.js'
import type { FileEntry } from '../src/shared/types.js'

function entry(dir: string, name: string, isDirectory = false): FileEntry {
  return { uri: `${dir}/${name}`, parentUri: dir, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}
const root = entry('file:///h', 'p', true)
const make = (n: number): FileEntry[] =>
  Array.from({ length: n }, (_, i) => entry(root.uri, `f${String(i).padStart(2, '0')}.txt`))
const state = (n: number, showAll: string[] = []): TreeState => ({
  roots: [root],
  children: { [root.uri]: make(n) },
  expanded: new Set([root.uri]),
  showAll: new Set(showAll),
  loading: new Set()
})

describe('omission of selectRows (TODO 904)', () => {
  it('does not omit for 10 or fewer', () => {
    expect(selectRows(state(10))).toHaveLength(11)
    expect(selectRows(state(10)).some((row) => row.more !== undefined)).toBe(false)
  })

  it('for 11 or more, the first 10 and an "N more" row', () => {
    const rows = selectRows(state(25))
    expect(rows).toHaveLength(12)
    const more = rows[11]
    expect(more?.more).toMatchObject({ parentUri: root.uri, hidden: 15 })
    expect(more?.depth).toBe(1)
    expect(more?.more?.nextKey).toBe('0|file:///h/p/f10.txt')
  })

  it('putting it in showAll shows everything and the "more" row disappears', () => {
    const rows = selectRows(state(25, [root.uri]))
    expect(rows).toHaveLength(26)
    expect(rows.some((row) => row.more !== undefined)).toBe(false)
  })

  it('the "more" row is a normal row for keys (→ does nothing, Enter activates)', () => {
    const rows = selectRows(state(25))
    expect(treeKeyAction('Enter', rows, 11)).toEqual({ kind: 'activate', index: 11 })
    expect(treeKeyAction('ArrowRight', rows, 11)).toBeNull()
    expect(treeKeyAction('ArrowLeft', rows, 11)).toEqual({ kind: 'move', index: 0 })
  })
})

describe('limitChildren / limitedAncestors', () => {
  it('limitChildren', () => {
    expect(limitChildren([1, 2, 3], false)).toHaveLength(3)
    expect(limitChildren(Array.from({ length: 12 }, (_, i) => i), false)).toHaveLength(10)
    expect(limitChildren(Array.from({ length: 12 }, (_, i) => i), true)).toHaveLength(12)
  })

  it('returns only parents whose reveal path is outside the 10 items', () => {
    const list = make(15)
    const chain = [root.uri, list[12]!.uri]
    expect(limitedAncestors(chain, { [root.uri]: list })).toEqual([root.uri])
    expect(limitedAncestors([root.uri, list[3]!.uri], { [root.uri]: list })).toEqual([])
  })
})
