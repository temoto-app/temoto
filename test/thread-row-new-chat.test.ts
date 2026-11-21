// @vitest-environment jsdom
/**
 * TODO 488 (wave 25 bundle C): when the thread list is in update order or unread order (unread order was added in 867), place 'New chat in this folder' (`NewChatButton`, class `thread-row-new-chat`) immediately to the right of the row's cwd name.
 *
 * - The judgment is the pure function `showsRowNewChat` (`thread-list-heading.ts`). It is not placed in unread order, cwd order, or the dump rows.
 * - Rendering `ThreadRow` in jsdom, it checks that the button comes right after the cwd name, that pressing it creates a conversation in that cwd, and that pressing it does not reach the row's selection (opening the thread). Showing it only on hover / selected rows is CSS (`.thread-row:hover` / `.thread-row.active`); jsdom does not apply CSS, so this is checked against the string in styles.css.
 *
 * Neither a model nor Electron is used (the same design as `test/thread-list-subtasks.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadSummary } from '../src/shared/thread.js'
import { showsRowNewChat } from '../src/renderer/src/thread-list-heading.js'
import type { ThreadSortKey } from '../src/renderer/src/thread-sort.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('showsRowNewChat (TODO 488)', () => {
  const thread = { cwdName: 'aios', cwdUri: 'file:///Users/me/git/aios' }
  it('only rows with a cwd in recent and unread order (867)', () => {
    expect(showsRowNewChat('recent', thread)).toBe(true)
    expect(showsRowNewChat('unread', thread)).toBe(true)
    expect(showsRowNewChat('cwd', thread)).toBe(false)
  })
  it('not placed on scratch or rows without a cwd (rows that show no cwd name)', () => {
    expect(showsRowNewChat('recent', { cwdName: '', cwdUri: 'file:///Users/me/aios/scratch/x' })).toBe(false)
    expect(showsRowNewChat('recent', { cwdName: 'x', cwdUri: '' })).toBe(false)
  })
})

describe("ThreadRow: the row's 「このフォルダで新しいチャット」 (TODO 488)", () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

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

  async function renderRow(sortKey: ThreadSortKey): Promise<void> {
    const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadRow, { summary, active: false, sortKey })))
  }

  it('recent order: appears right next to the cwd name', async () => {
    await renderRow('recent')
    const cwd = host.querySelector('.thread-row-cwd')
    const button = host.querySelector('button.thread-row-new-chat')
    expect(button).not.toBeNull()
    expect(cwd?.nextElementSibling).toBe(button)
    expect(button?.getAttribute('aria-label')).toBe('New thread in aios')
    // The tooltip is the shared component (354). No OS title is attached.
    expect(button?.hasAttribute('title')).toBe(false)
  })

  it('unread order shows it at the same position as recent order (867)', async () => {
    await renderRow('unread')
    const button = host.querySelector('button.thread-row-new-chat')
    expect(button).not.toBeNull()
    expect(host.querySelector('.thread-row-cwd')?.nextElementSibling).toBe(button)
  })

  it('not shown in cwd order', async () => {
    await renderRow('cwd')
    expect(host.querySelector('.thread-row-new-chat')).toBeNull()
  })

  it('pressing it creates in that cwd and does not reach the row selection', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const selectThread = vi.fn(async () => undefined)
    const createThreadInFolder = vi.fn(async () => true)
    const saved = useThreads.getState()
    useThreads.setState({ selectThread, createThreadInFolder } as never)
    try {
      await renderRow('recent')
      const button = host.querySelector<HTMLButtonElement>('button.thread-row-new-chat')!
      await act(async () => {
        button.click()
        // Waits inside act until creation finishes and busy is lowered (NewChatButton's setBusy).
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(createThreadInFolder).toHaveBeenCalledWith('file:///Users/me/git/aios')
      expect(selectThread).not.toHaveBeenCalled()
      // Pressing the row itself selects it (a control for the comparison).
      act(() => {
        host.querySelector<HTMLElement>('.thread-row')!.click()
      })
      expect(selectThread).toHaveBeenCalledWith('t1')
    } finally {
      act(() => useThreads.setState(saved, true))
    }
  })

  it('shown only on hover and for the selected row (styles.css)', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.thread-row-new-chat \{ display: none;/)
    expect(css).toMatch(/\.thread-row:hover \.thread-row-new-chat,\s*\.thread-row\.active \.thread-row-new-chat \{ display: flex; \}/)
  })

  it('the hiding rule does not lose to the later .icon-button { display: flex } (TODO 518-1)', () => {
    // Run 30 of the proxy verification: the button also has `icon-button`, and the later `.icon-button { display: flex }` in styles.css won at the same specificity (one class), so a pencil appeared on every row. Rules that hide it are written with two or more classes.
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const hide = [...css.matchAll(/\n([^{}\n]*\.thread-row-new-chat) \{ display: none;/g)].map((m) => m[1] ?? '')
    expect(hide.length).toBe(1)
    const classes = (hide[0]?.match(/\.[\w-]+/g) ?? []).length
    expect(classes).toBeGreaterThan(1)
    const iconButton = css.indexOf('\n.icon-button {')
    expect(iconButton).toBeGreaterThan(0)
    expect(css.slice(iconButton, css.indexOf('}', iconButton))).toContain('display: flex')
  })
})
