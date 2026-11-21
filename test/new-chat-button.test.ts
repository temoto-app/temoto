// @vitest-environment jsdom
/**
 * Items 280-2 / 280-3 (wave 15 bundle I): the position of the New Chat button in the heading (`NewChatButton`) and guarding against repeated presses.
 *
 * - Position: the button is a **sibling outside** `.thread-cwd` (overflow: hidden, max-width: 30%), and it does not shrink.
 *   jsdom does no layout, so this is checked through the nesting of the JSX and the existence of the CSS rules (the owner checks the real app).
 * - Repeated presses: the judgment is a pure function (`new-chat-guard.ts`); the button is actually rendered in jsdom and pressed twice, 15 ms and 80 ms apart.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  NEW_CHAT_COOLDOWN_MS,
  beginNewChat,
  canStartNewChat,
  endNewChat,
  newChatKey,
  type NewChatLedger
} from '../src/renderer/src/new-chat-guard.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('item 280-3: debounce decision (pure function)', () => {
  it('does not accept the same cwd while creating and accepts a different cwd', () => {
    const ledger: NewChatLedger = new Map()
    expect(beginNewChat(ledger, 'file:///a', 1000)).toBe(true)
    expect(beginNewChat(ledger, 'file:///a', 1005)).toBe(false)
    expect(beginNewChat(ledger, 'file:///b', 1005)).toBe(true)
    // While one is being created, it is not accepted however much time passes (it waits for the end).
    expect(canStartNewChat(ledger, 'file:///a', 1000 + NEW_CHAT_COOLDOWN_MS * 10)).toBe(false)
  })

  it('does not accept within NEW_CHAT_COOLDOWN_MS right after creation finishes and accepts after it passes', () => {
    const ledger: NewChatLedger = new Map()
    beginNewChat(ledger, 'file:///a', 1000)
    endNewChat(ledger, 'file:///a', 1015, true)
    expect(canStartNewChat(ledger, 'file:///a', 1095)).toBe(false) // A double press 80 ms later
    expect(canStartNewChat(ledger, 'file:///a', 1015 + NEW_CHAT_COOLDOWN_MS - 1)).toBe(false)
    expect(canStartNewChat(ledger, 'file:///a', 1015 + NEW_CHAT_COOLDOWN_MS)).toBe(true)
  })

  it('does not make the user wait on failure (can press again right away)', () => {
    const ledger: NewChatLedger = new Map()
    beginNewChat(ledger, 'file:///a', 1000)
    endNewChat(ledger, 'file:///a', 1010, false)
    expect(canStartNewChat(ledger, 'file:///a', 1011)).toBe(true)
  })

  it('no owner (uri = null) is also one key and does not collide with real URIs; cooled-down rows are swept', () => {
    const ledger: NewChatLedger = new Map()
    expect(newChatKey(null)).not.toBe(newChatKey('file:///a'))
    beginNewChat(ledger, newChatKey(null), 0)
    endNewChat(ledger, newChatKey(null), 5, true)
    beginNewChat(ledger, 'file:///a', 10)
    endNewChat(ledger, 'file:///a', 20 + NEW_CHAT_COOLDOWN_MS, true)
    expect(ledger.has(newChatKey(null))).toBe(false)
    expect(ledger.has('file:///a')).toBe(true)
  })
})

describe('item 280-3: double press of NewChatButton', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.resetModules()
  })

  async function mount(uri: string | null, create: (uri: string | null) => Promise<boolean>) {
    // The table that spans buttons is one per module, so it is re-read and emptied for each test.
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { NewChatButton } = await import('../src/renderer/src/components/NewChatButton.js')
    useThreads.setState({ createThreadInFolder: create })
    await act(async () => {
      root.render(createElement(NewChatButton, { uri, label: 'new', className: 'thread-new-chat' }))
    })
    return host.querySelector('button') as HTMLButtonElement
  }

  it('does not create on the second press at 15 ms / 80 ms intervals; a press after cooling down creates', async () => {
    const create = vi.fn(async () => true)
    const button = await mount('file:///work/a', create)
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(15)
    })
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(80)
    })
    await act(async () => {
      button.click()
    })
    expect(create).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEW_CHAT_COOLDOWN_MS)
      button.click()
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('also applies to another button (the second one with the same cwd shown in the new thread heading)', async () => {
    const create = vi.fn(async () => true)
    const first = await mount('file:///work/b', create)
    await act(async () => {
      first.click()
      await vi.advanceTimersByTimeAsync(20)
    })
    // The same button rendered again in the same place (remount).
    act(() => root.unmount())
    root = createRoot(host)
    const second = await mount('file:///work/b', create)
    await act(async () => {
      second.click()
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('can press again right away when creation fails', async () => {
    const create = vi.fn(async () => false)
    const button = await mount('file:///work/c', create)
    await act(async () => {
      button.click()
      await vi.advanceTimersByTimeAsync(5)
    })
    await act(async () => {
      button.click()
    })
    expect(create).toHaveBeenCalledTimes(2)
  })
})

describe('item 280-2: the heading bubble is a sibling outside .thread-cwd', () => {
  const pane = readFileSync(join(process.cwd(), 'src/renderer/src/components/ThreadPane.tsx'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  it('ThreadPane: NewChatButton is not inside <span className="thread-cwd">', () => {
    const open = pane.indexOf('<span className="thread-cwd">')
    expect(open).toBeGreaterThanOrEqual(0)
    const close = pane.indexOf('</span>', open)
    expect(pane.slice(open, close)).not.toContain('NewChatButton')
    // It appears as the sibling right after.
    expect(pane.slice(close, close + 900)).toContain('className="thread-new-chat"')
  })

  it('styles.css: the button directly under the heading does not shrink (flex: 0 0 auto); the truncation of .thread-cwd remains', () => {
    const rule = /\.thread-header > \.thread-new-chat \{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toContain('flex: 0 0 auto')
    const cwd = /\n\.thread-cwd \{([^}]*)\}/.exec(css)
    expect(cwd?.[1]).toContain('overflow: hidden')
    expect(cwd?.[1]).toContain('max-width: 30%')
  })
})
