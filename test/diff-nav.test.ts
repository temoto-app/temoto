/**
 * @vitest-environment jsdom
 *
 * Jumping between the changes of the diff viewer (TODO 1339, ARCHITECTURE 7.4.6).
 *
 * jsdom has no layout, so the scroll is checked by the position each jump dispatches (`EditorView.scrollIntoView(pos, { y: 'center' })`).
 * The re-centering while the pane settles is driven through a stubbed ResizeObserver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { mountDiffView, type DiffLayout, type DiffView } from '../plugins/aios.diff/viewer/diff-view.js'
import { setViewerLocale } from '../plugins/_shared/i18n.js'
import type { DiffSide } from '../src/shared/plugin.js'

const side = (text: string): DiffSide => ({ name: 'f.txt', text, language: null })

/** 40 lines; lines 5, 20 and 35 (1-based, so index 4 / 19 / 34) differ. */
const BEFORE = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
const AFTER = BEFORE.replace('row 5\n', 'row five\n').replace('row 20\n', 'row twenty\n').replace('row 35\n', 'row thirty-five\n')
const lineStart = (text: string, line1: number): number => text.split('\n').slice(0, line1 - 1).join('\n').length + (line1 > 1 ? 1 : 0)

let dispatches: number[]
let restore: () => void
let observers: (() => void)[]

function track(): void {
  dispatches = []
  const original = EditorView.prototype.dispatch
  const spy = vi.spyOn(EditorView.prototype, 'dispatch').mockImplementation(function (this: EditorView, ...args: unknown[]) {
    const first = args[0] as { effects?: unknown } | undefined
    const effects = ([] as unknown[]).concat(first?.effects ?? [])
    for (const effect of effects) {
      const value = (effect as { value?: { range?: { head: number }; y?: string } }).value
      if (value?.y === 'center' && value.range !== undefined) dispatches.push(value.range.head)
    }
    return (original as (...a: unknown[]) => void).apply(this, args)
  })
  restore = () => spy.mockRestore()
}

describe('diff change navigation', () => {
  let root: HTMLElement
  const mounted: DiffView[] = []
  const mount = (layout: DiffLayout, before = BEFORE, after = AFTER, startChunk?: number): DiffView => {
    const view = mountDiffView(root, {
      before: side(before),
      after: side(after),
      theme: 'light',
      layout,
      onLayoutChange: () => {},
      ...(startChunk === undefined ? {} : { startChunk })
    })
    mounted.push(view)
    return view
  }
  const button = (kind: 'prev' | 'next'): HTMLButtonElement => root.querySelector(`button[data-nav="${kind}"]`)!

  beforeEach(() => {
    setViewerLocale('en')
    root = document.createElement('div')
    document.body.append(root)
    observers = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb)
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    track()
  })
  afterEach(() => {
    for (const view of mounted.splice(0)) view.destroy()
    restore()
    vi.unstubAllGlobals()
    root.remove()
  })

  for (const layout of ['unified', 'split'] as const) {
    describe(layout, () => {
      it('shows the first change right after opening and counts the changes', () => {
        const view = mount(layout)
        expect(view.chunkCount).toBe(3)
        expect(view.chunk).toBe(0)
        expect(dispatches).toEqual([lineStart(AFTER, 5)])
        expect(root.querySelector('.diff-nav-pos')?.textContent).toBe('1 / 3')
      })

      it('moves with the buttons, centering each change, and wraps around at both ends', () => {
        const view = mount(layout)
        dispatches.length = 0
        button('next').click()
        button('next').click()
        expect(view.chunk).toBe(2)
        button('next').click()
        expect(view.chunk).toBe(0)
        button('prev').click()
        expect(view.chunk).toBe(2)
        expect(dispatches).toEqual([
          lineStart(AFTER, 20),
          lineStart(AFTER, 35),
          lineStart(AFTER, 5),
          lineStart(AFTER, 35)
        ])
      })

      it('moves with F7 / Shift+F7 and Alt+F5 / Shift+Alt+F5, and ignores F7 with Ctrl or Meta', () => {
        const view = mount(layout)
        const press = (init: KeyboardEventInit): boolean =>
          document.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init }))
        expect(press({ key: 'F7' })).toBe(false)
        expect(view.chunk).toBe(1)
        press({ key: 'F7', shiftKey: true })
        expect(view.chunk).toBe(0)
        press({ key: 'F5', altKey: true })
        expect(view.chunk).toBe(1)
        press({ key: 'F5', altKey: true, shiftKey: true })
        expect(view.chunk).toBe(0)
        expect(press({ key: 'F7', ctrlKey: true })).toBe(true)
        expect(press({ key: 'F5' })).toBe(true)
        expect(view.chunk).toBe(0)
      })

      it('removes the key handler on destroy', () => {
        const view = mount(layout)
        view.destroy()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', cancelable: true }))
        expect(view.chunk).toBe(0)
      })

      it('disables the buttons and ignores the keys when there is no change', () => {
        const view = mount(layout, BEFORE, BEFORE)
        expect(view.chunkCount).toBe(0)
        expect(view.chunk).toBe(-1)
        expect(button('prev').disabled).toBe(true)
        expect(button('next').disabled).toBe(true)
        dispatches.length = 0
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7' }))
        expect(dispatches).toEqual([])
      })

      it('starts at the change it is told to (a redraw keeps the person on the same change)', () => {
        const view = mount(layout, BEFORE, AFTER, 2)
        expect(view.chunk).toBe(2)
        expect(dispatches).toEqual([lineStart(AFTER, 35)])
        expect(mount(layout, BEFORE, AFTER, 99).chunk).toBe(2)
        expect(mount(layout, BEFORE, AFTER, -4).chunk).toBe(0)
      })

      it('re-centers on the current change while the size settles, and stops once the person scrolls', () => {
        const view = mount(layout)
        button('next').click()
        dispatches.length = 0
        for (const cb of observers) cb()
        expect(dispatches).toEqual([lineStart(AFTER, 20)])
        // A wheel on the scroller disarms the watcher: a late resize must not take the position back.
        root.querySelector('.diff-view')!.dispatchEvent(new Event('wheel'))
        dispatches.length = 0
        for (const cb of observers) cb()
        expect(dispatches).toEqual([])
        expect(view.chunk).toBe(1)
      })

      it('labels the buttons in the current language, with the key in the title', () => {
        mount(layout)
        expect(button('next').getAttribute('aria-label')).toBe('Next change')
        expect(button('next').title).toBe('Next change (F7)')
        expect(button('prev').title).toBe('Previous change (Shift+F7)')
        setViewerLocale('ja')
        root.textContent = ''
        mount(layout)
        expect(button('prev').getAttribute('aria-label')).toBe('前の変更')
      })
    })
  }

  it('jumps in the plain (too large) mode too, from a coarse line diff', () => {
    const big = Array.from({ length: 60_000 }, (_, i) => `entry ${i} ................`).join('\n') + '\n'
    const bigAfter = big.replace('entry 10 ', 'edited 10 ').replace('entry 30000 ', 'edited 30000 ')
    expect(big.length).toBeGreaterThan(1024 * 1024)
    const view = mount('unified', big, bigAfter)
    expect(view.mode).toBe('plain')
    expect(view.chunkCount).toBe(2)
    // Each column is centered on its own side (before, then after); the lines are the same length, so the offsets agree.
    expect(dispatches).toEqual([lineStart(big, 11), lineStart(bigAfter, 11)])
    // Coarse marks on the changed lines of both columns (only the lines in the viewport are rendered, so the first change).
    const texts = (selector: string): string[] => [...root.querySelectorAll(selector)].map((el) => el.textContent ?? '')
    expect(texts('.diff-coarse-del').length).toBeGreaterThan(0)
    expect(texts('.diff-coarse-del').every((t) => t.startsWith('entry '))).toBe(true)
    expect(texts('.diff-coarse-add').every((t) => t.startsWith('edited '))).toBe(true)
    button('next').click()
    expect(dispatches.slice(-2)).toEqual([lineStart(big, 30_001), lineStart(bigAfter, 30_001)])
    expect(root.querySelector('.banner')?.textContent).toContain('jump')
    expect(button('next').disabled).toBe(false)
  })

  it('in the plain mode, centers each column on its own side of a change when the columns are far out of line', () => {
    // 5,000 lines inserted near the top, 3 lines deleted near the bottom: the deletion is ~5,000 lines further down in the after column.
    const before = Array.from({ length: 40_000 }, (_, i) => `entry ${i} ................`)
    const after = [...before.slice(0, 100), ...Array.from({ length: 5000 }, (_, i) => `added ${i}`), ...before.slice(100, 39_000), ...before.slice(39_003)]
    const a = before.join('\n') + '\n'
    const b = after.join('\n') + '\n'
    expect(a.length).toBeGreaterThan(1024 * 1024)
    const view = mount('unified', a, b)
    expect(view.mode).toBe('plain')
    expect(view.chunkCount).toBe(2)
    button('next').click()
    const [beforePos, afterPos] = dispatches.slice(-2)
    // before: the first deleted line (39,000); after: the line just before the deletion point, which is line 39,000 - 1 + 5,000 (0-based).
    expect(beforePos).toBe(lineStart(a, 39_001))
    expect(afterPos).toBe(lineStart(b, 39_000 + 5000))
    // The two sides are about 5,000 lines apart, so they cannot both be centered by one scroller.
    expect(a.slice(0, beforePos).split('\n').length).toBeLessThan(b.slice(0, afterPos).split('\n').length - 4000)
  })

  it('in the plain mode, mirrors the person\'s own scrolling to the other column, but not the automatic jump', () => {
    const big = Array.from({ length: 60_000 }, (_, i) => `entry ${i} ................`).join('\n') + '\n'
    const view = mount('unified', big, big.replace('entry 10 ', 'edited 10 '))
    expect(view.mode).toBe('plain')
    const [left, right] = [...root.querySelectorAll<HTMLElement>('.diff-column')]
    expect(left).toBeDefined()
    left!.scrollTop = 500
    left!.dispatchEvent(new Event('scroll'))
    expect(right!.scrollTop).toBe(0)
    left!.dispatchEvent(new Event('wheel'))
    left!.scrollTop = 700
    left!.dispatchEvent(new Event('scroll'))
    expect(right!.scrollTop).toBe(200)
  })

  it('in the plain mode, disables the buttons when the coarse diff gives up', () => {
    const n = 60_000
    const make = (tag: string): string =>
      Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? `same ${i}` : `${tag} ${i}`)).join('\n')
    const a = make('a')
    const b = make('b')
    expect(a.length).toBeGreaterThan(1024 * 1024)
    const view = mount('unified', a, b)
    expect(view.mode).toBe('plain')
    expect(view.chunkCount).toBe(0)
    expect(button('next').disabled).toBe(true)
    expect(root.querySelector('.banner')?.textContent).not.toContain('jump')
  })

  it('uses a line diff for the merge views above the line-diff threshold, so far-apart changes stay separate chunks', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `const value_${i} = compute(${i}) // padding`).join('\n') + '\n'
    expect(base.length).toBeGreaterThan(32 * 1024)
    const edited = base.replace('value_100 =', 'renamed_100 =').replace('value_2900 =', 'renamed_2900 =')
    for (const layout of ['unified', 'split'] as const) {
      const view = mount(layout, base, edited)
      expect(view.mode).toBe(layout)
      expect(view.chunkCount).toBe(2)
    }
  })
})
