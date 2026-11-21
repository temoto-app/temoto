/**
 * TODO 356 / 357 (wave 19 bundle C): pure functions for keyboard operation on lists. No DOM.
 * - `listKeyStep`: shared by the tree (stops at the ends) and search results (wraps at the ends and skips headings)
 * - `navKey`: does not pick up keys during IME composition or with modifier keys
 * - `treeKeyAction`: ← / → / Enter in the tree (as in VS Code's Explorer)
 */
import { describe, expect, it } from 'vitest'
import { activeIndex, listKeyStep, navKey } from '../src/renderer/src/list-keys.js'
import { treeKeyAction, type TreeKeyRow } from '../src/renderer/src/file-tree.js'

const STOP = { wrap: false } as const
const WRAP = { wrap: true } as const

describe('listKeyStep (TODO 356 / 357)', () => {
  it('↑↓ で 1 行ずつ。止まる一覧は端で今の位置を返す (キーは扱った)', () => {
    expect(listKeyStep('ArrowDown', 0, 3, STOP)).toBe(1)
    expect(listKeyStep('ArrowDown', 2, 3, STOP)).toBe(2)
    expect(listKeyStep('ArrowUp', 1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', 0, 3, STOP)).toBe(0)
  })
  it('巡回する一覧は端で反対の端へ (VS Code の Quick Open)', () => {
    expect(listKeyStep('ArrowDown', 2, 3, WRAP)).toBe(0)
    expect(listKeyStep('ArrowUp', 0, 3, WRAP)).toBe(2)
  })
  it('まだ何も指していない (-1・範囲外): ↓ は先頭、↑ は巡回なら末尾・止まるなら先頭', () => {
    expect(listKeyStep('ArrowDown', -1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', -1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', -1, 3, WRAP)).toBe(2)
    expect(listKeyStep('ArrowDown', 9, 3, WRAP)).toBe(0)
  })
  it('選べない行 (区分の見出し) を飛ばし、区分をまたいで続けて動く', () => {
    // Heading / hit / hit / subheading / hit / heading / hit
    const selectable = [false, true, true, false, true, false, true]
    const opts = { wrap: true, selectable }
    expect(listKeyStep('ArrowDown', 2, 7, opts)).toBe(4)
    expect(listKeyStep('ArrowDown', 4, 7, opts)).toBe(6)
    expect(listKeyStep('ArrowDown', 6, 7, opts)).toBe(1)
    expect(listKeyStep('ArrowUp', 1, 7, opts)).toBe(6)
    expect(listKeyStep('ArrowUp', 4, 7, opts)).toBe(2)
    // If on a row that cannot be selected (right after the list changes), ↓ goes to the first candidate.
    expect(listKeyStep('ArrowDown', 0, 7, opts)).toBe(1)
  })
  it('止まる一覧でも選べない行は飛ばす。末尾が見出しなら最後の候補で止まる', () => {
    const selectable = [true, true, false]
    expect(listKeyStep('ArrowDown', 1, 3, { wrap: false, selectable })).toBe(1)
  })
  it('Home / End は両端の選べる行。homeEnd: false (入力欄) なら扱わない', () => {
    const selectable = [false, true, true, false]
    expect(listKeyStep('Home', 2, 4, { wrap: false, selectable })).toBe(1)
    expect(listKeyStep('End', 1, 4, { wrap: false, selectable })).toBe(2)
    expect(listKeyStep('Home', 2, 4, { wrap: true, homeEnd: false, selectable })).toBeNull()
    expect(listKeyStep('End', 2, 4, { wrap: true, homeEnd: false, selectable })).toBeNull()
  })
  it('PageUp / PageDown は page 行ずつ、端で止まる (巡回しない)。page を省けば扱わない', () => {
    expect(listKeyStep('PageDown', 0, 30, { wrap: true, page: 10 })).toBe(10)
    expect(listKeyStep('PageDown', 25, 30, { wrap: true, page: 10 })).toBe(29)
    expect(listKeyStep('PageUp', 5, 30, { wrap: true, page: 10 })).toBe(0)
    expect(listKeyStep('PageDown', 0, 30, STOP)).toBeNull()
    // If the destination row cannot be selected, the next candidate in the same direction.
    const selectable = [true, true, false, true]
    expect(listKeyStep('PageDown', 0, 4, { wrap: false, page: 2, selectable })).toBe(3)
  })
  it('扱わないキー・空の一覧・選べる行が無い一覧は null', () => {
    expect(listKeyStep('ArrowLeft', 0, 3, STOP)).toBeNull()
    expect(listKeyStep('a', 0, 3, STOP)).toBeNull()
    expect(listKeyStep('ArrowDown', 0, 0, STOP)).toBeNull()
    expect(listKeyStep('ArrowDown', 0, 2, { wrap: true, selectable: [false, false] })).toBeNull()
  })
})

describe('activeIndex (TODO 357)', () => {
  it('覚えた位置が選べる行ならそれ、そうでなければ最初の候補、候補が無ければ -1', () => {
    const selectable = [false, true, true]
    expect(activeIndex(2, selectable)).toBe(2)
    expect(activeIndex(-1, selectable)).toBe(1)
    expect(activeIndex(0, selectable)).toBe(1)
    expect(activeIndex(7, selectable)).toBe(1)
    expect(activeIndex(-1, [false, false])).toBe(-1)
    expect(activeIndex(-1, [])).toBe(-1)
  })
})

describe('navKey (TODO 356 / 357)', () => {
  it('素のキーはそのまま', () => {
    expect(navKey({ key: 'ArrowDown' })).toBe('ArrowDown')
    expect(navKey({ key: 'Enter', keyCode: 13, isComposing: false })).toBe('Enter')
  })
  it('IME の変換中は拾わない (isComposing / keyCode 229 / 呼び出し元の composition の印)', () => {
    expect(navKey({ key: 'ArrowDown', isComposing: true })).toBeNull()
    expect(navKey({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(navKey({ key: 'Enter' }, true)).toBeNull()
    // React's synthetic events carry isComposing on the nativeEvent side.
    expect(navKey({ key: 'ArrowDown', nativeEvent: { isComposing: true } })).toBeNull()
  })
  it('スレッドの改名欄: IME の確定の Enter と変換中の Escape は拾わない (TODO 939)', () => {
    expect(navKey({ key: 'Enter', nativeEvent: { isComposing: true }, keyCode: 229 })).toBeNull()
    expect(navKey({ key: 'Escape', nativeEvent: { isComposing: true } })).toBeNull()
    expect(navKey({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 })).toBe('Enter')
  })
  it('修飾キー付きは拾わない (⌘↑ は入力欄の行頭、⌃⌘I はショートカット)', () => {
    expect(navKey({ key: 'ArrowUp', metaKey: true })).toBeNull()
    expect(navKey({ key: 'ArrowUp', altKey: true })).toBeNull()
    expect(navKey({ key: 'i', ctrlKey: true, metaKey: true })).toBeNull()
    expect(navKey({ key: 'ArrowDown', shiftKey: true })).toBeNull()
  })
})

function row(depth: number, isDirectory: boolean, expanded = false): TreeKeyRow {
  return { depth, expanded, entry: { isDirectory } }
}

describe('treeKeyAction (TODO 356)', () => {
  // root (open) / a (closed folder) / b (open folder) / b/c.ts / d.ts
  const rows = [row(0, true, true), row(1, true), row(1, true, true), row(2, false), row(1, false)]

  it('→: 閉じたフォルダは開く、開いたフォルダは最初の子へ、ファイルは何もしない', () => {
    expect(treeKeyAction('ArrowRight', rows, 1)).toEqual({ kind: 'expand', index: 1 })
    expect(treeKeyAction('ArrowRight', rows, 2)).toEqual({ kind: 'move', index: 3 })
    expect(treeKeyAction('ArrowRight', rows, 3)).toBeNull()
  })
  it('→: 開いているが子がまだ無い (空・読み込み中) フォルダは何もしない', () => {
    const empty = [row(0, true, true), row(0, false)]
    expect(treeKeyAction('ArrowRight', empty, 0)).toBeNull()
  })
  it('←: 開いたフォルダは閉じる、それ以外は親へ、最上位は何もしない', () => {
    expect(treeKeyAction('ArrowLeft', rows, 2)).toEqual({ kind: 'collapse', index: 2 })
    expect(treeKeyAction('ArrowLeft', rows, 3)).toEqual({ kind: 'move', index: 2 })
    expect(treeKeyAction('ArrowLeft', rows, 4)).toEqual({ kind: 'move', index: 0 })
    expect(treeKeyAction('ArrowLeft', rows, 1)).toEqual({ kind: 'move', index: 0 })
    expect(treeKeyAction('ArrowLeft', [row(0, false)], 0)).toBeNull()
  })
  it('Enter は行を押したのと同じ。↑↓ は listKeyStep の受け持ちなので null。範囲外も null', () => {
    expect(treeKeyAction('Enter', rows, 3)).toEqual({ kind: 'activate', index: 3 })
    expect(treeKeyAction('ArrowDown', rows, 0)).toBeNull()
    expect(treeKeyAction('ArrowRight', rows, -1)).toBeNull()
  })
})

describe('treeKeyAction の `.app` (TODO 562)', () => {
  it('→ は `.app` を開かない (▸ を出さない行)。普通のフォルダと Enter は今までどおり', () => {
    const rows: TreeKeyRow[] = [
      { depth: 0, expanded: true, entry: { isDirectory: true, name: 'Applications' } },
      { depth: 1, expanded: false, entry: { isDirectory: true, name: 'Keynote.app' } },
      { depth: 1, expanded: false, entry: { isDirectory: true, name: 'Utilities' } }
    ]
    expect(treeKeyAction('ArrowRight', rows, 1)).toBeNull()
    expect(treeKeyAction('ArrowRight', rows, 2)).toEqual({ kind: 'expand', index: 2 })
    expect(treeKeyAction('Enter', rows, 1)).toEqual({ kind: 'activate', index: 1 })
    expect(treeKeyAction('ArrowLeft', rows, 1)).toEqual({ kind: 'move', index: 0 })
  })
})
