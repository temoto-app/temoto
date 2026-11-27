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
import { pickChunk, pickNav } from '../plugins/aios.diff/viewer/nav.js'
import { mountDiffView, type DiffLayout, type DiffView } from '../plugins/aios.diff/viewer/diff-view.js'
import { setViewerLocale } from '../plugins/_shared/i18n.js'
import { diffJobFor } from '../plugins/aios.diff/viewer/diff-work.js'
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

      it('bases previous / next on the visible middle once the person scrolled, and on the last jump otherwise (TODO 1341)', () => {
        const view = mount(layout)
        // jsdom has no layout: the line of a position sits at (line number x 100) px, and the middle of the view is `clientHeight / 2`.
        vi.spyOn(EditorView.prototype, 'lineBlockAt').mockImplementation(function (this: EditorView, pos: number) {
          return { top: this.state.doc.lineAt(pos).number * 100 } as never
        })
        vi.spyOn(EditorView.prototype, 'documentTop', 'get').mockReturnValue(0)
        const body = root.querySelector<HTMLElement>('.diff-view')!
        const middle = (y: number): void => {
          Object.defineProperty(body, 'clientHeight', { configurable: true, value: y * 2 })
          // In the middle of a long scroller (neither end), so the base is the middle.
          Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 100000 })
          Object.defineProperty(body, 'scrollTop', { configurable: true, writable: true, value: 50 })
        }
        // The changes are at 500 / 2000 / 3500 px. A scroll that no input of the person preceded (what a jump itself causes, arriving later) is not the person's.
        middle(2200)
        body.dispatchEvent(new Event('scroll'))
        button('next').click()
        expect(view.chunk).toBe(1)
        // Now the person scrolls (wheel, then the scroll event arrives later) to a middle of 2200 px.
        body.dispatchEvent(new Event('wheel'))
        body.dispatchEvent(new Event('scroll'))
        button('next').click()
        expect(view.chunk).toBe(2)
        // The jump's own scroll event arrives after it: still on the last jump, so previous is the one before it.
        body.dispatchEvent(new Event('scroll'))
        button('prev').click()
        expect(view.chunk).toBe(1)
        // The person scrolls up to 1000 px: previous is the first change above it, next the first below.
        middle(1000)
        body.dispatchEvent(new Event('wheel'))
        body.dispatchEvent(new Event('scroll'))
        button('prev').click()
        expect(view.chunk).toBe(0)
        middle(1000)
        body.dispatchEvent(new Event('wheel'))
        body.dispatchEvent(new Event('scroll'))
        button('next').click()
        expect(view.chunk).toBe(1)
        // Past the last change, next wraps to the first; before the first, previous wraps to the last.
        middle(4000)
        body.dispatchEvent(new Event('pointerdown'))
        body.dispatchEvent(new Event('scroll'))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7' }))
        expect(view.chunk).toBe(0)
        middle(100)
        body.dispatchEvent(new Event('wheel'))
        body.dispatchEvent(new Event('scroll'))
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', shiftKey: true }))
        expect(view.chunk).toBe(2)
        expect(root.querySelector('.diff-nav-pos')?.textContent).toBe('3 / 3')
      })

      it('counts a key pressed outside the scroller (the iframe body) as the person moving the view (review X1)', () => {
        const view = mount(layout)
        vi.spyOn(EditorView.prototype, 'lineBlockAt').mockImplementation(function (this: EditorView, pos: number) {
          return { top: this.state.doc.lineAt(pos).number * 100 } as never
        })
        vi.spyOn(EditorView.prototype, 'documentTop', 'get').mockReturnValue(0)
        const body = root.querySelector<HTMLElement>('.diff-view')!
        Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 })
        Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 100000 })
        Object.defineProperty(body, 'scrollTop', { configurable: true, writable: true, value: 50 })
        button('next').click()
        expect(view.chunk).toBe(1)
        // PageDown lands on the document body, not inside the (read-only, unfocusable) editor; the scroll follows.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
        body.dispatchEvent(new Event('scroll'))
        // The middle is now at 100 px, so next is the first change below it (the one at 500 px), not the one after the last jump.
        button('next').click()
        expect(view.chunk).toBe(0)
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

  it('in the plain mode, a key on the document body (outside the columns) also ends the automatic jump (wave 107 review X1)', () => {
    const big = Array.from({ length: 60_000 }, (_, i) => `entry ${i} ................`).join('\n') + '\n'
    const view = mount('unified', big, big.replace('entry 10 ', 'edited 10 '))
    expect(view.mode).toBe('plain')
    const [left, right] = [...root.querySelectorAll<HTMLElement>('.diff-column')]
    // The jump on open is automatic: its scroll is not mirrored.
    left!.scrollTop = 500
    left!.dispatchEvent(new Event('scroll'))
    expect(right!.scrollTop).toBe(0)
    // PageDown lands on the iframe body (the read-only editors take no focus), never inside the columns; the scroll follows.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    left!.scrollTop = 800
    left!.dispatchEvent(new Event('scroll'))
    expect(right!.scrollTop).toBe(300)
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

  it('uses the worker result for CRLF and lone CR files too (wave 109 fix X1: the job is made from the text the editor holds)', () => {
    for (const eol of ['\r\n', '\r']) {
      const base = Array.from({ length: 3000 }, (_, i) => `const value_${i} = compute(${i}) // padding`).join(eol) + eol
      const edited = base.replace('value_100 =', 'renamed_100 =').replace('value_2900 =', 'renamed_2900 =')
      // The job main.ts sends to the worker: the editor joins lines with \n, and the library asks `override` about that text.
      const job = diffJobFor(base, edited)!
      expect(job.kind).toBe('chars')
      expect(job.a.includes('\r')).toBe(false)
      const at = job.a.indexOf('value_100 =')
      // Only the first change, in the coordinates of the joined text: if the view computed its own diff it would find two.
      const onlyFirst = { kind: 'chars', changes: [{ fromA: at, toA: at + 5, fromB: at, toB: at + 7 }] } as const
      const view = mountDiffView(root, {
        before: side(base),
        after: side(edited),
        theme: 'light',
        layout: 'unified',
        onLayoutChange: () => {},
        precomputed: onlyFirst
      })
      mounted.push(view)
      expect(view.chunkCount, JSON.stringify(eol)).toBe(1)
    }
  })

  it('draws from a result computed elsewhere (the worker, TODO 1341 item 4) instead of computing it again', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `const value_${i} = compute(${i}) // padding`).join('\n') + '\n'
    const edited = base.replace('value_100 =', 'renamed_100 =').replace('value_2900 =', 'renamed_2900 =')
    const at = base.indexOf('value_100 =')
    // Only the first change: if the view used its own diff it would find two.
    const onlyFirst = { kind: 'chars', changes: [{ fromA: at, toA: at + 5, fromB: at, toB: at + 7 }] } as const
    for (const layout of ['unified', 'split'] as const) {
      const view = mountDiffView(root, {
        before: side(base),
        after: side(edited),
        theme: 'light',
        layout,
        onLayoutChange: () => {},
        precomputed: onlyFirst
      })
      mounted.push(view)
      expect(view.chunkCount).toBe(1)
      // A result of the other kind is not used.
      const other = mountDiffView(root, {
        before: side(base),
        after: side(edited),
        theme: 'light',
        layout,
        onLayoutChange: () => {},
        precomputed: { kind: 'lines', chunks: [] }
      })
      mounted.push(other)
      expect(other.chunkCount).toBe(2)
    }
    const big = Array.from({ length: 60_000 }, (_, i) => `entry ${i} ................`).join('\n') + '\n'
    const plain = mountDiffView(root, {
      before: side(big),
      after: side(big.replace('entry 10 ', 'edited 10 ')),
      theme: 'light',
      layout: 'unified',
      onLayoutChange: () => {},
      precomputed: {
        kind: 'lines',
        chunks: [
          { fromA: 10, toA: 11, fromB: 10, toB: 11 },
          { fromA: 500, toA: 501, fromB: 500, toB: 501 }
        ]
      }
    })
    mounted.push(plain)
    expect(plain.mode).toBe('plain')
    expect(plain.chunkCount).toBe(2)
  })
})

describe('pickChunk (TODO 1341)', () => {
  const tops = [100, 200, 300, 400]
  const at = (i: number): number => tops[i]!
  it('picks the first change below / last change above the middle, wrapping at the ends', () => {
    expect(pickChunk(4, at, 250, 1)).toBe(2)
    expect(pickChunk(4, at, 250, -1)).toBe(1)
    expect(pickChunk(4, at, 50, 1)).toBe(0)
    expect(pickChunk(4, at, 50, -1)).toBe(3)
    expect(pickChunk(4, at, 450, 1)).toBe(0)
    expect(pickChunk(4, at, 450, -1)).toBe(3)
    expect(pickChunk(0, at, 0, 1)).toBe(-1)
  })
  it('does not count a change sitting at the middle (a centered one) as below or above', () => {
    expect(pickChunk(4, at, 200, 1)).toBe(2)
    expect(pickChunk(4, at, 200, -1)).toBe(0)
    expect(pickChunk(4, at, 200.5, 1)).toBe(2)
  })
})

describe('pickNav (review X2 / X3)', () => {
  // Visible range 0..400, middle 200. Change tops at 3, 10 and 800 (a document whose first changes sit above the middle).
  const tops = [3, 10, 800]
  const view = (over: Partial<Parameters<typeof pickNav>[1]>): Parameters<typeof pickNav>[1] => ({
    ref: 200,
    viewTop: 0,
    viewBottom: 400,
    top: (i) => tops[i]!,
    ...over
  })
  it('at the top end, next starts from the top edge instead of skipping visible changes', () => {
    expect(pickNav(3, view({ atStart: true }), 1, -1)).toBe(0)
    expect(pickNav(3, view({}), 1, -1)).toBe(2)
  })
  it('at the bottom end, previous starts from the bottom edge', () => {
    const t = [100, 390, 600]
    const v = view({ ref: 200, viewTop: 0, viewBottom: 400, top: (i) => t[i]!, atEnd: true })
    expect(pickNav(3, v, -1, -1)).toBe(1)
    expect(pickNav(3, { ...v, atEnd: false }, -1, -1)).toBe(0)
  })
  it('steps past the current change when the pick is that same change and it is still on screen', () => {
    const t = [100, 195, 600]
    // Just jumped to 1 (top half a row above the middle), scrolled a little: previous would pick 1 itself.
    expect(pickChunk(3, (i) => t[i]!, 200, -1)).toBe(1)
    expect(pickNav(3, view({ top: (i) => t[i]! }), -1, 1)).toBe(0)
    // Next side: scrolled up so the current one is a little below the middle.
    const u = [100, 205, 600]
    expect(pickNav(3, view({ top: (i) => u[i]! }), 1, 1)).toBe(2)
  })
  it('does not step when the current change is off screen', () => {
    const t = [100, 195, 600]
    expect(pickNav(3, view({ top: (i) => t[i]!, viewTop: 150, viewBottom: 190 }), -1, 1)).toBe(1)
  })
})
