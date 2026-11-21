// @vitest-environment jsdom
/**
 * TODO 496 (wave 24 bundle A): the floating search box of in-thread search (`ThreadFind.tsx`), rendered for real in jsdom.
 *
 * It does not render all of ThreadPane. Instead, in place of `.thread-body`, it puts 'rows' and a small component that folds in a block (the small component that uses `useFindPending`). The index (`window.aios.search.thread`) and the previous page (`loadOlder`) are fakes. Neither a model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSearchResponse } from '../src/shared/search.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let answer: ThreadSearchResponse
const asked: { query: string; threadId: string; seq: number }[] = []

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  answer = { eventIds: [], truncated: false }
  asked.length = 0
  ;(globalThis as unknown as { window: { aios: unknown } }).window.aios = {
    search: {
      thread: async (query: string, threadId: string, seq: number) => {
        asked.push({ query, threadId, seq })
        return answer
      }
    }
  }
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  const { useThreadFind } = await import('../src/renderer/src/threadFindStore.js')
  act(() => useThreadFind.setState({ open: false, query: '', terms: [], reveal: null }))
  vi.useRealTimers()
})

/** A stand-in for a folded block: while closed it does not render its contents, and it sets the `useFindPending` mark. */
async function makeFolded() {
  const { useFindPending } = await import('../src/renderer/src/threadFindStore.js')
  return function Folded({ id, hidden }: { id: string; hidden: string }) {
    const [open, setOpen] = useState(false)
    const pending = useFindPending(`tool:${id}`, hidden, open, () => setOpen(true))
    return createElement(
      'div',
      { id: `ev-${id}`, className: 'tool-block', ...pending },
      createElement('button', { className: 'tool-head', onClick: () => setOpen(!open) }, createElement('span', { className: 'tool-summary' }, 'head')),
      open ? createElement('pre', { className: 'tool-input' }, hidden) : null
    )
  }
}

async function renderPane(extraTop: string[] = [], topText: (id: string) => string = (id) => `old deploy ${id}`, loading = false) {
  const { ThreadFind } = await import('../src/renderer/src/components/ThreadFind.js')
  const Folded = await makeFolded()
  function Pane({ top, busy }: { top: string[]; busy: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null)
    return createElement(
      'div',
      { className: 'thread-pane' },
      createElement(ThreadFind, { threadId: 't1', bodyRef: ref }),
      createElement(
        'div',
        { className: 'thread-body', ref },
        // The 'read more' button (the label changes while loading = a DOM change).
        createElement('div', { key: 'more', className: 'timeline-older' }, createElement('button', null, busy ? 'Loading…' : 'Load older')),
        ...top.map((id) => createElement('div', { key: id, id: `ev-${id}` }, createElement('p', null, topText(id)))),
        createElement('div', { key: 'u1', id: 'ev-u1' }, createElement('p', null, 'please deploy it')),
        createElement(Folded, { key: 't2', id: 't2', hidden: 'npm run deploy --prod' }),
        createElement('div', { key: 'a3', id: 'ev-a3' }, createElement('p', null, 'Deploy done. deploy again?'))
      )
    )
  }
  const render = (top: string[], busy = loading): void => act(() => root.render(createElement(Pane, { top, busy })))
  render(extraTop)
  return render
}

async function stores() {
  const find = await import('../src/renderer/src/threadFindStore.js')
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  return { ...find, useThreads }
}

const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>('.thread-find-input')!
/** 'n / N' (in EN, `n of N`). */
const count = (): string => (host.querySelector('.thread-find-count')?.textContent ?? '').replace(' of ', ' / ')

function type(value: string): void {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string, shiftKey = false): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  })
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('ThreadFind (TODO 496)', () => {
  it('opens with ⌘F / 🔍 and focuses the field, typing counts matches on screen immediately, Enter / ⇧Enter moves between them, and Esc closes and returns focus', async () => {
    const { openThreadFind, useThreadFind, useThreads } = await stores()
    act(() => useThreads.setState({ events: { t1: [] }, childEvents: {}, older: {} }))
    await renderPane()
    const before = document.createElement('textarea')
    document.body.append(before)
    before.focus()
    act(() => openThreadFind())
    expect(document.activeElement).toBe(input())
    type('deploy')
    // Visible matches: 1 in u1, 2 in a3 (case-insensitive). One place inside the folded block t2.
    expect(count()).toBe('1 / 4')
    // The block (t2) is between u1 and a3. Moving forward opens it, and makes the match inside (the typed characters) the current position.
    expect(host.querySelector('[data-find-pending]')).not.toBeNull()
    press('Enter')
    expect(count()).toBe('2 / 4')
    await flush(20)
    expect(host.querySelector('.tool-input')).not.toBeNull()
    expect(host.querySelector('[data-find-pending]')).toBeNull()
    expect(count()).toBe('2 / 4')
    press('Enter')
    expect(count()).toBe('3 / 4')
    press('Enter')
    expect(count()).toBe('4 / 4')
    // At the end it wraps around to the other end.
    press('Enter')
    expect(count()).toBe('1 / 4')
    press('Enter', true)
    expect(count()).toBe('4 / 4')
    press('Escape')
    expect(useThreadFind.getState().open).toBe(false)
    expect(host.querySelector('.thread-find')).toBeNull()
    expect(document.activeElement).toBe(before)
    before.remove()
  })

  it('a term containing uppercase is case-sensitive (the Aa tag), matches only on a previous page are added from the index, and advancing reads that page', async () => {
    const { openThreadFind, useThreads } = await stores()
    const loadOlder = vi.fn(async () => {
      useThreads.setState({
        events: { t1: [{ id: 'o1' } as never, { id: 'u1' } as never, { id: 'a3' } as never] },
        older: { t1: { before: null, remaining: 0, loading: false } }
      })
      render(['o1'])
    })
    act(() =>
      useThreads.setState({
        events: { t1: [{ id: 'u1' } as never, { id: 'a3' } as never] },
        childEvents: {},
        older: { t1: { before: 10, remaining: 5, loading: false } },
        loadOlder
      })
    )
    const render = await renderPane()
    act(() => openThreadFind())
    // Index: o1 from the previous page, and a3 which is already loaded (not added, since it is counted in the DOM).
    answer = { eventIds: ['o1', 'a3'], truncated: false, caseSensitive: true }
    type('Deploy')
    expect(host.querySelector('.search-case-badge')).not.toBeNull()
    expect(count()).toBe('1 / 1')
    await flush(200)
    expect(asked.at(-1)).toMatchObject({ query: 'Deploy', threadId: 't1' })
    expect(count()).toBe('2 / 2')
    // The earlier page's hit is on the oldest side (the head). Shift+Enter wraps around, and moving on reads the previous page and goes to the match in that message.
    press('Enter', true)
    await flush(20)
    expect(loadOlder).toHaveBeenCalledWith('t1')
    expect(host.querySelector('#ev-o1')).not.toBeNull()
    // `old deploy o1` is lowercase, so it does not match Deploy: if there is no match in that message, go to the first match on screen.
    expect(count()).toBe('1 / 1')
  })

  it('DOM changes while reading the previous page (a loading button) do not consume the wait, and once it arrives goes to the match in that message (review 2026-10-06)', async () => {
    const { openThreadFind, useThreads } = await stores()
    let finish: () => void = () => {}
    const loadOlder = vi.fn(async () => {
      // Same order as the real one: first it re-renders as 'loading' (the DOM changes), and after a while the page arrives.
      useThreads.setState({ older: { t1: { before: 10, remaining: 5, loading: true } } })
      render([], true)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      useThreads.setState({
        events: { t1: [{ id: 'o1' } as never, { id: 'u1' } as never, { id: 'a3' } as never] },
        older: { t1: { before: null, remaining: 0, loading: false } }
      })
      render(['o1'], false)
    })
    act(() =>
      useThreads.setState({
        events: { t1: [{ id: 'u1' } as never, { id: 'a3' } as never] },
        childEvents: {},
        older: { t1: { before: 10, remaining: 5, loading: false } },
        loadOlder
      })
    )
    const render = await renderPane([], (id) => `old Deploy ${id}`)
    act(() => openThreadFind())
    answer = { eventIds: ['o1'], truncated: false, caseSensitive: true }
    type('Deploy')
    await flush(200)
    // o1 from the previous page (index) + one a3 on screen.
    expect(count()).toBe('2 / 2')
    press('Enter', true)
    expect(count()).toBe('1 / 2')
    // While loading: only the button label changed. The wait remains, and it does not jump to the top of the screen.
    await flush(200)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(host.querySelector('#ev-o1')).toBeNull()
    expect(count()).toBe('1 / 2')
    // Arrived: the current position is the match in o1 (o1 is counted in the DOM, so it falls outside the index's count).
    act(() => finish())
    await flush(200)
    expect(host.querySelector('#ev-o1')).not.toBeNull()
    expect(count()).toBe('1 / 2')
    expect(host.querySelector('.thread-find-count')).not.toBeNull()
  })

  it('when advancing to a message on a previous page with no match on screen, does not redo "re-select at the start of typing" on the redraw after arriving (TODO 501-1)', async () => {
    const { openThreadFind, useThreads } = await stores()
    const loadOlder = vi.fn(async () => {
      useThreads.setState({
        events: { t1: [{ id: 'o1' } as never, { id: 'o2' } as never, { id: 'u1' } as never, { id: 'a3' } as never] },
        older: { t1: { before: null, remaining: 0, loading: false } }
      })
      render(['o1', 'o2'])
    })
    act(() =>
      useThreads.setState({
        events: { t1: [{ id: 'u1' } as never, { id: 'a3' } as never] },
        childEvents: {},
        older: { t1: { before: 10, remaining: 5, loading: false } },
        loadOlder
      })
    )
    const render = await renderPane([], (id) => `zebrafish ${id}`)
    act(() => openThreadFind())
    // A word that is not on screen (u1 / a3 / block) but only in o1 / o2 of the previous page.
    answer = { eventIds: ['o1', 'o2'], truncated: false }
    type('zebrafish')
    await flush(200)
    expect(count()).toBe('? / 2')
    // Shift+Enter is the far end = o2. Load it and go to the match in o2.
    press('Enter', true)
    await flush(50)
    expect(host.querySelector('#ev-o2')).not.toBeNull()
    expect(count()).toBe('2 / 2')
    // On re-render after arriving (streaming text, pasted questions, etc.), do not reselect the match on screen above (o1).
    render(['o1', 'o2'], true)
    await flush(200)
    expect(count()).toBe('2 / 2')
    press('Enter', true)
    expect(count()).toBe('1 / 2')
  })

  it('does not lose the current place when receiving ends while on the in-flight body (reattaches to the confirmed row, TODO 501-2)', async () => {
    const { openThreadFind, useThreads } = await stores()
    const { ThreadFind } = await import('../src/renderer/src/components/ThreadFind.js')
    act(() => useThreads.setState({ events: { t1: [] }, childEvents: {}, older: {} }))
    function Pane({ done }: { done: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null)
      const text = 'word1 word2 word3'
      return createElement(
        'div',
        { className: 'thread-pane' },
        createElement(ThreadFind, { threadId: 't1', bodyRef: ref }),
        createElement(
          'div',
          { className: 'thread-body', ref },
          createElement('div', { key: 'u1', id: 'ev-u1' }, createElement('p', null, 'slow word')),
          // As in the real one: while streaming there is a `.streaming` with no id, and when it ends it becomes the row `ev-<id>`.
          done
            ? createElement('div', { key: 'a9', id: 'ev-a9' }, createElement('p', null, text))
            : createElement('div', { key: 's', className: 'message assistant streaming' }, text)
        )
      )
    }
    act(() => root.render(createElement(Pane, { done: false })))
    act(() => openThreadFind())
    type('word')
    expect(count()).toBe('1 / 4')
    press('Enter')
    press('Enter')
    expect(count()).toBe('3 / 4')
    act(() => root.render(createElement(Pane, { done: true })))
    await flush(200)
    expect(count()).toBe('3 / 4')
    press('Enter')
    expect(count()).toBe('4 / 4')
  })

  it('useFindPending: does not reopen the chunk because of an open request left at mount (it persists until closed) (review 2026-10-06)', async () => {
    const { useFindPending, useThreadFind } = await stores()
    const revealed = vi.fn()
    function Folded() {
      const attrs = useFindPending('tool:x', 'npm run deploy', false, revealed)
      return createElement('div', { className: 'tool-block', ...attrs })
    }
    act(() => useThreadFind.setState({ open: true, reveal: { key: 'tool:x', seq: 3 } }))
    act(() => useThreadFind.getState().setQuery('deploy'))
    act(() => root.render(createElement(Folded)))
    expect(revealed).not.toHaveBeenCalled()
    // It opens only when the window has advanced to this block (when its number changes).
    act(() => useThreadFind.getState().requestReveal('tool:x'))
    expect(revealed).toHaveBeenCalledTimes(1)
    act(() => useThreadFind.getState().requestReveal('tool:y'))
    expect(revealed).toHaveBeenCalledTimes(1)
  })

  it('discards a stale index answer, and the on-screen part still lights up even when the term is too short', async () => {
    const { openThreadFind, useThreads } = await stores()
    act(() => useThreads.setState({ events: { t1: [] }, childEvents: {}, older: {} }))
    await renderPane()
    act(() => openThreadFind())
    answer = { eventIds: ['zz'], truncated: false, stale: true }
    type('deploy')
    await flush(200)
    expect(count()).toBe('1 / 4')
    answer = { eventIds: [], truncated: false, tooShort: true }
    type('de')
    await flush(200)
    expect(count()).toMatch(/ \/ 4$/)
  })
})
