// @vitest-environment jsdom
/**
 * TODO 741: right-click a thread in the Sidebar to 'Mark as unread' / 'Mark as read'.
 *
 * It renders `ThreadRow` (`src/renderer/src/components/ThreadList.tsx`) directly in jsdom, and checks that the `ContextMenu` opened by `onContextMenu` (the shared part of TODO 299) shows exactly one of 'Mark as read' (if unread) or 'Mark as unread' (if read), and that pressing it calls main's entry point (`window.aios.threads.setUnread`).
 * The behavior on the main side, 'does not disappear while it is still being shown', is handled by `test/session-manager.test.ts` (TODO 741).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const setUnread = vi.fn()

beforeEach(() => {
  setUnread.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { setUnread }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const summaryOf = (unread: boolean): ThreadSummary =>
  ({
    thread: {
      id: 't1',
      title: 'タイトル',
      cwdName: '',
      cwdUri: '',
      forkedFrom: null,
      rainbow: null,
      unread,
      createdAt: 0,
      updatedAt: 0,
      lastEventAt: null
    },
    runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
    preview: null
  }) as unknown as ThreadSummary

async function renderRow(unread: boolean): Promise<void> {
  const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
  act(() =>
    root.render(createElement(ThreadRow, { summary: summaryOf(unread), active: false, sortKey: 'recent' }))
  )
}

function rightClick(target: Element): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
  act(() => target.dispatchEvent(event))
}

describe('ThreadRow right-click (TODO 741)', () => {
  it('a read row shows only 「未読にする」, and pressing it calls setUnread(id, true)', async () => {
    await renderRow(false)
    const row = host.querySelector('.thread-row')!
    rightClick(row)
    const menu = document.querySelector('.context-menu')
    expect(menu).not.toBeNull()
    const labels = Array.from(menu!.querySelectorAll('button')).map((el) => el.textContent)
    // TODO 818: 'Save conversation as PDF' is also listed. TODO 866: HTML is next to it.
    expect(labels).toEqual(['Rename', 'Mark as unread', 'Save conversation as PDF…', 'Save conversation as HTML…', 'Save conversation as Markdown…'])
    act(() => (menu!.querySelectorAll('button')[1] as HTMLButtonElement).click())
    expect(setUnread).toHaveBeenCalledWith('t1', true)
  })

  it('an unread row shows only 「既読にする」, and pressing it calls setUnread(id, false)', async () => {
    await renderRow(true)
    const row = host.querySelector('.thread-row')!
    rightClick(row)
    const menu = document.querySelector('.context-menu')
    const labels = Array.from(menu!.querySelectorAll('button')).map((el) => el.textContent)
    expect(labels).toEqual(['Rename', 'Mark as read', 'Save conversation as PDF…', 'Save conversation as HTML…', 'Save conversation as Markdown…'])
    act(() => (menu!.querySelectorAll('button')[1] as HTMLButtonElement).click())
    expect(setUnread).toHaveBeenCalledWith('t1', false)
  })
})
