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

describe('selectRows の省略 (TODO 904)', () => {
  it('10 件以下は省かない', () => {
    expect(selectRows(state(10))).toHaveLength(11)
    expect(selectRows(state(10)).some((row) => row.more !== undefined)).toBe(false)
  })

  it('11 件以上は先頭 10 件と「他 N 件」の行', () => {
    const rows = selectRows(state(25))
    expect(rows).toHaveLength(12)
    const more = rows[11]
    expect(more?.more).toMatchObject({ parentUri: root.uri, hidden: 15 })
    expect(more?.depth).toBe(1)
    expect(more?.more?.nextKey).toBe('0|file:///h/p/f10.txt')
  })

  it('showAll に入れると全部出て、「他」の行は消える', () => {
    const rows = selectRows(state(25, [root.uri]))
    expect(rows).toHaveLength(26)
    expect(rows.some((row) => row.more !== undefined)).toBe(false)
  })

  it('「他」の行はキーでは普通の行 (→ は何もしない、Enter は activate)', () => {
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

  it('reveal の道が 10 件の外にある親だけ返す', () => {
    const list = make(15)
    const chain = [root.uri, list[12]!.uri]
    expect(limitedAncestors(chain, { [root.uri]: list })).toEqual([root.uri])
    expect(limitedAncestors([root.uri, list[3]!.uri], { [root.uri]: list })).toEqual([])
  })
})
