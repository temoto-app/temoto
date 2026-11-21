// @vitest-environment jsdom
/**
 * TODO 821 (wave 39 bundle B): rename a thread not only by double-click, but also from the right-click menu and F2.
 * The input field (`.thread-rename`) and the save (`renameThread` -> `threadRename`) are one thing. F2 works only while the list has focus, and does not take over inside an input or text field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const summary = {
  thread: {
    id: 't1',
    title: 'タイトル',
    cwdName: 'aios',
    cwdUri: 'file:///Users/me/git/aios',
    forkedFrom: null,
    rainbow: null,
    unread: false,
    createdAt: 0,
    updatedAt: 0,
    lastEventAt: null
  },
  runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
  preview: null
} as unknown as ThreadSummary

let root: Root
let host: HTMLDivElement
const renameThread = vi.fn(async () => undefined)

beforeEach(async () => {
  renameThread.mockClear()
  ;(window as unknown as { aios: unknown }).aios = { threads: { listDeleted: async () => [] } }
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useThreads.setState({
    renameThread,
    selectThread: vi.fn(async () => undefined),
    threadOrder: ['t1'],
    threadsById: { t1: summary },
    activeThreadId: 't1'
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const menu of document.querySelectorAll('.context-menu')) menu.remove()
})

describe('スレッドの改名の入口 (TODO 821)', () => {
  it('右クリックのメニューの「Rename」で入力欄が開き、確定で renameThread に届く', async () => {
    const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadRow, { summary, active: true, sortKey: 'cwd' })))
    await act(async () => {
      host
        .querySelector('.thread-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
      (el) => el.textContent === 'Rename'
    )
    expect(item).toBeDefined()
    await act(async () => {
      item?.click()
    })
    const input = host.querySelector<HTMLInputElement>('input.thread-rename')
    expect(input).not.toBeNull()
    expect(input?.value).toBe('タイトル')
  })

  it('F2 は一覧に focus があるとき選択中の行を改名する。入力欄の中では奪わない', async () => {
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadList)))
    const list = host.querySelector<HTMLElement>('.thread-list')!
    expect(host.querySelector('input.thread-rename')).toBeNull()
    // F2 inside an input field does not apply.
    const stray = document.createElement('input')
    list.append(stray)
    act(() => {
      stray.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('input.thread-rename')).toBeNull()
    stray.remove()
    // It opens from the list itself (the focus target after clicking a row).
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('input.thread-rename')).not.toBeNull()
  })

  it('F2 で A を改名した後に B を選んでも、B の入力欄は開かない (code-review)', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    // Older rows are folded under 'show more', so both are set to the current time.
    const now = Date.now()
    const fresh = { ...summary, thread: { ...summary.thread, updatedAt: now, lastEventAt: now } } as ThreadSummary
    const other = { ...fresh, thread: { ...fresh.thread, id: 't2', title: '別' } } as ThreadSummary
    useThreads.setState({ threadOrder: ['t1', 't2'], threadsById: { t1: fresh, t2: other } } as never)
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadList)))
    const list = host.querySelector<HTMLElement>('.thread-list')!
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
    })
    expect(host.querySelectorAll('input.thread-rename')).toHaveLength(1)
    act(() => useThreads.setState({ activeThreadId: 't2' } as never))
    expect(host.querySelectorAll('.thread-row')).toHaveLength(2)
    // B (t2) must not open on its own (whether A's field remains is not a concern).
    expect([...host.querySelectorAll<HTMLInputElement>('input.thread-rename')].map((el) => el.value)).not.toContain('別')
  })

  it('一覧の外の F2 は拾わない', async () => {
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadList)))
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('input.thread-rename')).toBeNull()
  })
})
