/**
 * @vitest-environment jsdom
 *
 * Showing a search hit in the center, and the hit box (ARCHITECTURE.md 7.4.3, TODO 431).
 *
 *  - (a) the 'first' of multiple words is the first in the document (the cap of `findHighlightRanges` is not a cut per word)
 *  - box state (n / N, disabled at the ends, not shown for 0 or 1 matches) and where it goes
 *  - `createEditor` emits an effect that shows the first match in the center; pressing the box changes the current match and shows it in the center
 *  - (b) when the size changes (ResizeObserver), it re-aligns to the current match, and stops when a person touches it
 *  - when the body is edited, the match position is followed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createEditor } from '../plugins/_shared/editor.js'
import { findHighlightRanges } from '../plugins/_shared/highlight.js'
import { hitNavState, stepTarget, watchRecenter, HIDDEN_HIT_NAV } from '../plugins/_shared/hit-nav.js'

/** Stands in for ResizeObserver, which jsdom does not have. It remembers the callback for each observed element and fires it by hand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly targets: Element[] = []
  disconnected = false
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.targets.push(target)
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  static fire(target: Element): void {
    for (const o of FakeResizeObserver.instances) if (!o.disconnected && o.targets.includes(target)) o.callback()
  }
}

describe('(a) 複数語の最初は文書の最初', () => {
  const doc = Text.of(['beta first', 'alpha later', 'beta again'])

  it('上限 1 でも、2 つ目の語の方が前にあればそれを返す', () => {
    expect(findHighlightRanges(doc, ['alpha', 'beta'], 1)).toEqual([{ from: 0, to: 4 }])
  })
  it('上限は from 順の先頭から数える', () => {
    expect(findHighlightRanges(doc, ['alpha', 'beta'], 2)).toEqual([
      { from: 0, to: 4 },
      { from: 11, to: 16 }
    ])
  })
  it('大文字小文字だけ違う語の同じ範囲は 1 つに数える', () => {
    expect(findHighlightRanges(doc, ['alpha', 'ALPHA'])).toEqual([{ from: 11, to: 16 }])
  })
})

describe('箱の状態', () => {
  it('0 / 1 件は出さない', () => {
    expect(hitNavState(0, 0)).toEqual(HIDDEN_HIT_NAV)
    expect(hitNavState(1, 1)).toEqual(HIDDEN_HIT_NAV)
  })
  it('最初では ⤒ ∧ が、最後では ∨ ⤓ が無効', () => {
    expect(hitNavState(1, 3)).toMatchObject({ visible: true, index: 1, count: 3, canFirst: false, canPrev: false, canNext: true, canLast: true })
    expect(hitNavState(2, 3)).toMatchObject({ canFirst: true, canPrev: true, canNext: true, canLast: true })
    expect(hitNavState(3, 3)).toMatchObject({ canFirst: true, canPrev: true, canNext: false, canLast: false })
  })
  it('行き先', () => {
    expect(stepTarget('next', 1, 3)).toBe(2)
    expect(stepTarget('prev', 2, 3)).toBe(1)
    expect(stepTarget('last', 1, 3)).toBe(3)
    expect(stepTarget('first', 3, 3)).toBe(1)
    expect(stepTarget('next', 3, 3)).toBeNull()
    expect(stepTarget('prev', 1, 3)).toBeNull()
    expect(stepTarget('next', 1, 1)).toBeNull()
  })
})

describe('watchRecenter (b)', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('arm の後の大きさの変化で寄せ直し、触ったら・時間が過ぎたら止める', () => {
    const el = document.createElement('div')
    let t = 0
    const recenter = vi.fn()
    const watch = watchRecenter(el, recenter, { windowMs: 1000, now: () => t })
    FakeResizeObserver.fire(el)
    expect(recenter).not.toHaveBeenCalled()
    watch.arm()
    FakeResizeObserver.fire(el)
    FakeResizeObserver.fire(el)
    expect(recenter).toHaveBeenCalledTimes(2)
    el.dispatchEvent(new Event('wheel'))
    FakeResizeObserver.fire(el)
    expect(recenter).toHaveBeenCalledTimes(2)
    watch.arm()
    t = 1500
    FakeResizeObserver.fire(el)
    expect(recenter).toHaveBeenCalledTimes(2)
    watch.destroy()
  })
})

describe('createEditor のヒットの箱', () => {
  // beta on line 1, alpha from line 2 on. Opening with 'alpha beta' first goes to beta (from 0)
  const VALUE = 'beta one\nalpha two\nalpha three\nbeta four'

  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function build(value = VALUE): { host: HTMLElement; editor: ReturnType<typeof createEditor> } {
    const host = document.createElement('div')
    document.body.append(host)
    const editor = createEditor(host, { value, filename: 'x.txt', readOnly: false, theme: 'light', onChange: () => {} })
    return { host, editor }
  }
  const box = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.hit-nav')!
  const pos = (host: HTMLElement): string => host.querySelector('.hit-nav-pos')!.textContent ?? ''
  const button = (host: HTMLElement, step: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`.hit-nav-btn[data-step="${step}"]`)!
  const current = (host: HTMLElement): string[] =>
    [...host.querySelectorAll('.cm-searchHit-current')].map((el) => el.textContent ?? '')
  const centered = (spy: { mock: { calls: unknown[][] } }): number[] =>
    spy.mock.calls.filter((call) => (call[1] as { y?: string } | undefined)?.y === 'center').map((call) => call[0] as number)

  it('開くと文書の最初の一致 (2 つ目の語) を中央に出す', () => {
    const spy = vi.spyOn(EditorView, 'scrollIntoView')
    const { editor } = build()
    editor.setHighlight('alpha beta')
    expect(centered(spy)).toEqual([0])
    editor.destroy()
  })

  it('2 件以上で n / N の箱を出し、端では無効。押すと今いる一致が替わり中央に出る', () => {
    const { host, editor } = build()
    expect(box(host).hidden).toBe(true)
    editor.setHighlight('alpha beta')
    expect(box(host).hidden).toBe(false)
    expect(pos(host)).toBe('1 / 4')
    expect(button(host, 'first').disabled).toBe(true)
    expect(button(host, 'prev').disabled).toBe(true)
    expect(button(host, 'next').disabled).toBe(false)
    expect(current(host)).toEqual(['beta'])

    const spy = vi.spyOn(EditorView, 'scrollIntoView')
    button(host, 'next').click()
    expect(pos(host)).toBe('2 / 4')
    expect(current(host)).toEqual(['alpha'])
    expect(centered(spy)).toEqual([9])

    button(host, 'last').click()
    expect(pos(host)).toBe('4 / 4')
    expect(button(host, 'next').disabled).toBe(true)
    expect(button(host, 'last').disabled).toBe(true)
    expect(centered(spy)).toEqual([9, VALUE.lastIndexOf('beta')])

    button(host, 'first').click()
    expect(pos(host)).toBe('1 / 4')
    // The selection (the attachment candidate of item 97) is not changed
    expect(button(host, 'first').disabled).toBe(true)
    editor.destroy()
  })

  it('1 件・0 件・null では箱を出さない', () => {
    const { host, editor } = build()
    editor.setHighlight('one')
    expect(box(host).hidden).toBe(true)
    expect(current(host)).toEqual([])
    editor.setHighlight('zzz')
    expect(box(host).hidden).toBe(true)
    editor.setHighlight('alpha')
    expect(box(host).hidden).toBe(false)
    editor.setHighlight(null)
    expect(box(host).hidden).toBe(true)
    editor.destroy()
  })

  it('大きさが変わったら今いる一致へ寄せ直す (b)、触ったら止める', () => {
    const { host, editor } = build()
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!
    editor.setHighlight('alpha beta')
    const spy = vi.spyOn(EditorView, 'scrollIntoView')
    FakeResizeObserver.fire(scroller)
    expect(centered(spy)).toEqual([0])
    button(host, 'next').click()
    expect(centered(spy)).toEqual([0, 9])
    // After pressing the box, it is not re-aligned (it stops at the pressed position)
    FakeResizeObserver.fire(scroller)
    expect(centered(spy)).toEqual([0, 9])
    editor.setHighlight('beta')
    expect(centered(spy)).toEqual([0, 9, 0])
    scroller.dispatchEvent(new Event('pointerdown'))
    FakeResizeObserver.fire(scroller)
    expect(centered(spy)).toEqual([0, 9, 0])
    editor.destroy()
  })

  it('本文を編集したら一致の位置を追い、今いる一致を消したら次の一致へ移る', () => {
    const { host, editor } = build()
    editor.setHighlight('alpha beta')
    button(host, 'next').click()
    expect(current(host)).toEqual(['alpha'])
    editor.setValue(`XX${VALUE}`)
    // Replacing the whole thing is done by the caller calling setHighlight again (as before)
    editor.setHighlight('alpha beta')
    expect(pos(host)).toBe('1 / 4')
    editor.insertText('>>')
    expect(pos(host)).toBe('1 / 4')
    expect(current(host)).toEqual(['beta'])
    // Erasing the content of the current match (the second alpha) makes the first match after that position the current match
    button(host, 'next').click()
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    const text = view.state.doc.toString()
    const at = text.indexOf('alpha')
    view.dispatch({ changes: { from: at, to: at + 'alpha'.length } })
    expect(pos(host)).toBe('2 / 3')
    expect(current(host)).toEqual(['alpha'])
    expect(view.state.doc.toString().indexOf('alpha')).toBe(text.indexOf('alpha', at + 1) - 'alpha'.length)
    editor.destroy()
  })
})
