// @vitest-environment jsdom
/**
 * TODO 674 (wave 31 bundle A, owner request 2026-10-11): arrange thread list rows in the order cwd -> question -> answer.
 *
 * - A row with a cwd (`showsRowCwd` is true) has 3 lines: line 1 `.thread-row-meta` (cwd name + pencil + time), line 2 `.thread-row-top` (question, state mark, unread dot, ×), line 3 `.thread-row-preview` (answer).
 * - In the cwd-order groups, in dump rows, and in old rows without a cwd (`showsRowCwd` is false), line 1 is absent entirely, and the row is 2 lines (question -> answer).
 * - The leading `↳` of the answer is added by CSS `::before`, so it does not appear in the DOM text (`textContent`).
 *
 * Renders `ThreadRow` (`src/renderer/src/components/ThreadList.tsx`) directly in jsdom.
 * Neither a model nor Electron is used (the same design as `test/thread-row-new-chat.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadSummary } from '../src/shared/thread.js'
import type { ThreadSortKey } from '../src/renderer/src/thread-sort.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const summaryOf = (patch: { cwdName: string; cwdUri: string; preview: string | null }): ThreadSummary =>
  ({
    thread: {
      id: 't1',
      title: 'タイトル',
      forkedFrom: null,
      rainbow: null,
      unread: false,
      createdAt: 0,
      updatedAt: 0,
      lastEventAt: null,
      ...patch
    },
    runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
    preview: patch.preview
  }) as unknown as ThreadSummary

async function renderRow(summary: ThreadSummary, sortKey: ThreadSortKey = 'recent'): Promise<void> {
  const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
  act(() => root.render(createElement(ThreadRow, { summary, active: false, sortKey })))
}

describe('ThreadRow: row layout cwd → question → answer (TODO 674)', () => {
  it('a row with a cwd has 3 lines in this order', async () => {
    await renderRow(
      summaryOf({ cwdName: 'aios', cwdUri: 'file:///Users/me/git/aios', preview: '回答の本文' })
    )
    const row = host.querySelector('.thread-row')!
    const rows = Array.from(row.children).filter((el) =>
      el.classList.contains('thread-row-meta') ||
      el.classList.contains('thread-row-top') ||
      el.classList.contains('thread-row-preview')
    )
    expect(rows.map((el) => el.className)).toEqual([
      'thread-row-meta',
      'thread-row-top',
      'thread-row-preview'
    ])
    // Line 1 = cwd name
    expect(rows[0]?.querySelector('.thread-row-cwd')?.textContent).toBe('aios')
    // Line 2 = question (as the current title)
    expect(rows[1]?.querySelector('.thread-row-title')?.textContent).toBe('タイトル')
    // Line 3 = answer. The ↳ is only added by ::before, so it does not appear in the DOM text.
    expect(rows[2]?.textContent).toBe('回答の本文')
  })

  it('a row inside a cwd group has no first line and has 2 lines (question → answer)', async () => {
    await renderRow(
      summaryOf({ cwdName: 'aios', cwdUri: 'file:///Users/me/git/aios', preview: '回答の本文' }),
      'cwd'
    )
    expect(host.querySelector('.thread-row-meta')).toBeNull()
    const row = host.querySelector('.thread-row')!
    const rows = Array.from(row.children).filter((el) =>
      el.classList.contains('thread-row-top') || el.classList.contains('thread-row-preview')
    )
    expect(rows.map((el) => el.className)).toEqual(['thread-row-top', 'thread-row-preview'])
  })

  it('scratch and rows without a cwd have no first line and have 2 lines', async () => {
    await renderRow(summaryOf({ cwdName: '', cwdUri: '', preview: '回答の本文' }))
    expect(host.querySelector('.thread-row-meta')).toBeNull()
    expect(host.querySelector('.thread-row-top')).not.toBeNull()
    expect(host.querySelector('.thread-row-preview')).not.toBeNull()
  })

  it('a row with no answer has no third line', async () => {
    await renderRow(summaryOf({ cwdName: 'aios', cwdUri: 'file:///Users/me/git/aios', preview: null }))
    expect(host.querySelector('.thread-row-preview')).toBeNull()
  })

  it('↳ is added with CSS ::before (styles.css)', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.thread-row-preview::before\s*\{\s*content:\s*'↳ ';\s*\}/)
  })
})
