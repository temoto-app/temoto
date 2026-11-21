// @vitest-environment jsdom
/**
 * TODO 999 (review of wave 53): the candidates when only `@` is typed (recent files) are shown without choosing one. `@` + Enter still sends as before,
 * and Enter inserts a candidate only when one was picked with ↑↓. A `@` with a word still picks the first one as before (checked with a pure function).
 * Neither the model nor a real index is called. `window.aios` is a minimal fake with only the entry points touched at render time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'
import { atActiveIndex, atCursorStep, atInitialCursor } from '../src/renderer/src/composer-at.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('atInitialCursor / atCursorStep / atActiveIndex', () => {
  it('does not select only `@`; with a word, selects the first', () => {
    expect(atInitialCursor('')).toBe(-1)
    expect(atInitialCursor('src')).toBe(0)
    expect(atInitialCursor(null)).toBe(0)
  })

  it('when nothing is selected, ArrowDown goes to the first and ArrowUp to the last; when selected, cycles', () => {
    expect(atCursorStep(-1, 1, 3)).toBe(0)
    expect(atCursorStep(-1, -1, 3)).toBe(2)
    expect(atCursorStep(2, 1, 3)).toBe(0)
    expect(atCursorStep(0, -1, 3)).toBe(2)
    expect(atCursorStep(0, 1, 0)).toBe(-1)
    expect(atActiveIndex(-1, 3)).toBe(-1)
    expect(atActiveIndex(5, 3)).toBe(2)
  })
})

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode: vi.fn() },
    recent: {
      list: vi.fn(async () => [
        { uri: 'file:///Users/a/w/recent.txt', parentUri: 'file:///Users/a/w', name: 'recent.txt', ext: 'txt', size: 1, mtimeMs: 1, kind: 'document', ai: false }
      ]),
      thumbnail: vi.fn(async () => null),
      offers: vi.fn(async () => [])
    },
    fs: {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(): Promise<{
  textarea: HTMLTextAreaElement
  send: ReturnType<typeof vi.fn>
  useThreads: (typeof import('../src/renderer/src/threadStore.js'))['useThreads']
}> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const runtime = { state: 'idle', live: false } as unknown as ThreadSummary['runtime']
  const send = vi.fn(async () => undefined)
  useThreads.setState({
    drafts: { t1: '' },
    attachments: {},
    sending: new Set(),
    error: null,
    threadsById: { t1: { thread: { cwdUri: 'file:///Users/a/w' }, runtime, preview: null } as unknown as ThreadSummary },
    threadCommands: { t1: [] },
    threadSkills: { t1: [] },
    send
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  await act(async () => {})
  const textarea = host.querySelector('textarea')!
  // Types `@` (onChange also picks up the input position).
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@')
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {})
  return { textarea, send, useThreads }
}

const key = (textarea: HTMLTextAreaElement, name: string): void =>
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })

describe('the recent candidates for `@` alone in the Composer', () => {
  it('candidates appear but are not selected; Enter goes on to send without inserting a candidate', async () => {
    const { textarea, useThreads } = await render()
    const rows = [...host.querySelectorAll('.composer-at-menu li')]
    expect(rows.map((li) => li.querySelector('.at-name')?.textContent)).toEqual(['recent.txt'])
    expect(rows[0]?.classList.contains('active')).toBe(false)
    key(textarea, 'Enter')
    // No candidate is inserted (it went on to send with `@` still there).
    expect(useThreads.getState().drafts['t1'] ?? '').not.toContain('recent.txt')
  })

  it('selecting with ArrowDown makes Enter insert the candidate', async () => {
    const { textarea, useThreads } = await render()
    key(textarea, 'ArrowDown')
    expect(host.querySelector('.composer-at-menu li')?.classList.contains('active')).toBe(true)
    key(textarea, 'Enter')
    expect(useThreads.getState().drafts['t1']).toBe('@recent.txt ')
  })
})
