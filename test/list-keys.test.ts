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
  it('up/down arrows move one row at a time; a list that stops returns the current position at the ends (the key was handled)', () => {
    expect(listKeyStep('ArrowDown', 0, 3, STOP)).toBe(1)
    expect(listKeyStep('ArrowDown', 2, 3, STOP)).toBe(2)
    expect(listKeyStep('ArrowUp', 1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', 0, 3, STOP)).toBe(0)
  })
  it('a cycling list wraps to the opposite end at the edge (VS Code Quick Open)', () => {
    expect(listKeyStep('ArrowDown', 2, 3, WRAP)).toBe(0)
    expect(listKeyStep('ArrowUp', 0, 3, WRAP)).toBe(2)
  })
  it('when nothing is pointed at yet (-1, out of range): down goes to the first, up goes to the last if cycling and to the first if stopping', () => {
    expect(listKeyStep('ArrowDown', -1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', -1, 3, STOP)).toBe(0)
    expect(listKeyStep('ArrowUp', -1, 3, WRAP)).toBe(2)
    expect(listKeyStep('ArrowDown', 9, 3, WRAP)).toBe(0)
  })
  it('skips unselectable rows (section headings) and continues across sections', () => {
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
  it('even a stopping list skips unselectable rows; if the end is a heading it stops at the last candidate', () => {
    const selectable = [true, true, false]
    expect(listKeyStep('ArrowDown', 1, 3, { wrap: false, selectable })).toBe(1)
  })
  it('Home / End go to the selectable rows at both ends; with homeEnd: false (an input field) they are not handled', () => {
    const selectable = [false, true, true, false]
    expect(listKeyStep('Home', 2, 4, { wrap: false, selectable })).toBe(1)
    expect(listKeyStep('End', 1, 4, { wrap: false, selectable })).toBe(2)
    expect(listKeyStep('Home', 2, 4, { wrap: true, homeEnd: false, selectable })).toBeNull()
    expect(listKeyStep('End', 2, 4, { wrap: true, homeEnd: false, selectable })).toBeNull()
  })
  it('PageUp / PageDown move by page rows and stop at the ends (no cycling); if page is omitted they are not handled', () => {
    expect(listKeyStep('PageDown', 0, 30, { wrap: true, page: 10 })).toBe(10)
    expect(listKeyStep('PageDown', 25, 30, { wrap: true, page: 10 })).toBe(29)
    expect(listKeyStep('PageUp', 5, 30, { wrap: true, page: 10 })).toBe(0)
    expect(listKeyStep('PageDown', 0, 30, STOP)).toBeNull()
    // If the destination row cannot be selected, the next candidate in the same direction.
    const selectable = [true, true, false, true]
    expect(listKeyStep('PageDown', 0, 4, { wrap: false, page: 2, selectable })).toBe(3)
  })
  it('unhandled keys, an empty list and a list with no selectable rows give null', () => {
    expect(listKeyStep('ArrowLeft', 0, 3, STOP)).toBeNull()
    expect(listKeyStep('a', 0, 3, STOP)).toBeNull()
    expect(listKeyStep('ArrowDown', 0, 0, STOP)).toBeNull()
    expect(listKeyStep('ArrowDown', 0, 2, { wrap: true, selectable: [false, false] })).toBeNull()
  })
})

describe('activeIndex (TODO 357)', () => {
  it('if the remembered position is a selectable row it is used, otherwise the first candidate, and -1 if there are no candidates', () => {
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
  it('a plain key passes through as is', () => {
    expect(navKey({ key: 'ArrowDown' })).toBe('ArrowDown')
    expect(navKey({ key: 'Enter', keyCode: 13, isComposing: false })).toBe('Enter')
  })
  it("is not picked up during IME composition (isComposing / keyCode 229 / the caller's composition marker)", () => {
    expect(navKey({ key: 'ArrowDown', isComposing: true })).toBeNull()
    expect(navKey({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(navKey({ key: 'Enter' }, true)).toBeNull()
    // React's synthetic events carry isComposing on the nativeEvent side.
    expect(navKey({ key: 'ArrowDown', nativeEvent: { isComposing: true } })).toBeNull()
  })
  it('thread rename field: the IME-confirming Enter and Escape during composition are not picked up (TODO 939)', () => {
    expect(navKey({ key: 'Enter', nativeEvent: { isComposing: true }, keyCode: 229 })).toBeNull()
    expect(navKey({ key: 'Escape', nativeEvent: { isComposing: true } })).toBeNull()
    expect(navKey({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 })).toBe('Enter')
  })
  it('keys with modifiers are not picked up (Cmd+Up is the start of line in the input field, Ctrl+Cmd+I is a shortcut)', () => {
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

  it('right arrow: opens a closed folder, moves an open folder to its first child, and does nothing for a file', () => {
    expect(treeKeyAction('ArrowRight', rows, 1)).toEqual({ kind: 'expand', index: 1 })
    expect(treeKeyAction('ArrowRight', rows, 2)).toEqual({ kind: 'move', index: 3 })
    expect(treeKeyAction('ArrowRight', rows, 3)).toBeNull()
  })
  it('right arrow: a folder that is open but has no children yet (empty or loading) does nothing', () => {
    const empty = [row(0, true, true), row(0, false)]
    expect(treeKeyAction('ArrowRight', empty, 0)).toBeNull()
  })
  it('left arrow: closes an open folder, otherwise goes to the parent, and does nothing at the top level', () => {
    expect(treeKeyAction('ArrowLeft', rows, 2)).toEqual({ kind: 'collapse', index: 2 })
    expect(treeKeyAction('ArrowLeft', rows, 3)).toEqual({ kind: 'move', index: 2 })
    expect(treeKeyAction('ArrowLeft', rows, 4)).toEqual({ kind: 'move', index: 0 })
    expect(treeKeyAction('ArrowLeft', rows, 1)).toEqual({ kind: 'move', index: 0 })
    expect(treeKeyAction('ArrowLeft', [row(0, false)], 0)).toBeNull()
  })
  it('Enter is the same as pressing the row; up/down are handled by listKeyStep so null; out of range is also null', () => {
    expect(treeKeyAction('Enter', rows, 3)).toEqual({ kind: 'activate', index: 3 })
    expect(treeKeyAction('ArrowDown', rows, 0)).toBeNull()
    expect(treeKeyAction('ArrowRight', rows, -1)).toBeNull()
  })
})

describe('`.app` in treeKeyAction (TODO 562)', () => {
  it('right arrow does not open a `.app` (a row that shows no disclosure arrow); ordinary folders and Enter are as before', () => {
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
