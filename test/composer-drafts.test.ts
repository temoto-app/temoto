// @vitest-environment jsdom
/**
 * TODO 526 (wave 26 bundle C): the provisional title made from a Composer draft, and the report of the set of drafts (renderer side).
 *
 * - `provisionalTitle` / `provisionalTitleOf`: the first non-empty line, cut at 40 characters, only for lines that are provisional and not yet sent.
 * - `draftThreadIds` / `installComposerDraftReport`: reports only when the set changes (not on every keystroke).
 * - Draws `ThreadRow` in jsdom and checks that this window's draft appears as the list title.
 *
 * Neither the model nor Electron is used (built the same way as `test/thread-row-new-chat.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createStore } from 'zustand/vanilla'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, ThreadSummary } from '../src/shared/thread.js'
import {
  PROVISIONAL_TITLE_MAX,
  draftThreadIds,
  installComposerDraftReport,
  provisionalTitle,
  provisionalTitleOf
} from '../src/renderer/src/composer-drafts.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('provisionalTitle', () => {
  it('returns the first non-empty line with whitespace collapsed', () => {
    expect(provisionalTitle('\n  \n  README を  直して\n2 行目')).toBe('README を 直して')
    expect(provisionalTitle('a\r\nb')).toBe('a')
  })
  it('null for empty, whitespace-only and undefined', () => {
    expect(provisionalTitle(undefined)).toBeNull()
    expect(provisionalTitle('')).toBeNull()
    expect(provisionalTitle(' \n\t ')).toBeNull()
  })
  it('cuts at 40 characters and adds … (a surrogate pair counts as 1)', () => {
    const long = 'あ'.repeat(PROVISIONAL_TITLE_MAX + 5)
    expect(provisionalTitle(long)).toBe(`${'あ'.repeat(PROVISIONAL_TITLE_MAX)}…`)
    expect(provisionalTitle('😀'.repeat(PROVISIONAL_TITLE_MAX))).toBe('😀'.repeat(PROVISIONAL_TITLE_MAX))
  })
})

describe('provisionalTitleOf', () => {
  it('only for a thread with a provisional title and nothing yet', () => {
    expect(provisionalTitleOf({ title: '', lastEventAt: null }, '質問')).toBe('質問')
    expect(provisionalTitleOf({ title: '名前', lastEventAt: null }, '質問')).toBeNull()
    expect(provisionalTitleOf({ title: '', lastEventAt: 1 }, '質問')).toBeNull()
    expect(provisionalTitleOf({ title: '', lastEventAt: null }, undefined)).toBeNull()
  })
})

describe('draftThreadIds / installComposerDraftReport', () => {
  const file = { uri: 'file:///a', name: 'a' } as unknown as Attachment

  it('a whitespace-only draft is not counted, and an attachment alone is counted', () => {
    expect(draftThreadIds({ b: 'x', a: ' ', c: '' }, { d: [file], e: [] })).toEqual(['b', 'd'])
  })

  it('reports only when the set changes', () => {
    const store = createStore<{ drafts: Record<string, string>; attachments: Record<string, readonly Attachment[]> }>(
      () => ({ drafts: {}, attachments: {} })
    )
    const reports: (readonly string[])[] = []
    const off = installComposerDraftReport(store, (ids) => {
      reports.push(ids)
    })
    // The first time it is empty, so nothing is reported.
    expect(reports).toEqual([])
    store.setState({ drafts: { t1: 'a' } })
    store.setState({ drafts: { t1: 'ab' } })
    store.setState({ drafts: { t1: 'abc' } })
    expect(reports).toEqual([['t1']])
    store.setState({ attachments: { t2: [file] } })
    expect(reports).toEqual([['t1'], ['t1', 't2']])
    store.setState({ drafts: { t1: '' }, attachments: {} })
    expect(reports).toEqual([['t1'], ['t1', 't2'], []])
    off()
    store.setState({ drafts: { t9: 'x' } })
    expect(reports).toHaveLength(3)
  })

  it('swallows a report failure (reject)', async () => {
    const store = createStore<{ drafts: Record<string, string>; attachments: Record<string, readonly Attachment[]> }>(
      () => ({ drafts: { t1: 'x' }, attachments: {} })
    )
    const off = installComposerDraftReport(store, () => Promise.reject(new Error('gone')))
    await Promise.resolve()
    off()
  })
})

describe('ThreadRow: provisional title (TODO 526)', () => {
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

  function summary(title: string, lastEventAt: number | null): ThreadSummary {
    return {
      thread: {
        id: 't1',
        title,
        cwdName: '',
        cwdUri: 'file:///Users/me/aios/scratch/t1',
        forkedFrom: null,
        rainbow: null,
        unread: false,
        createdAt: 0,
        updatedAt: 0,
        lastEventAt
      },
      runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
      preview: null
    } as unknown as ThreadSummary
  }

  async function render(s: ThreadSummary): Promise<void> {
    const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => root.render(createElement(ThreadRow, { summary: s, active: true, sortKey: 'recent' })))
  }

  it('with a draft, shows its first line as an italic title, otherwise New thread', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const saved = useThreads.getState()
    try {
      await render(summary('', null))
      expect(host.querySelector('.thread-row-title')?.textContent).toBe('New thread')
      expect(host.querySelector('.thread-row-title.provisional')).toBeNull()
      act(() => useThreads.setState({ drafts: { t1: 'ログを調べて\n詳細' } }))
      const title = host.querySelector('.thread-row-title.provisional')
      expect(title?.textContent).toBe('ログを調べて')
      expect(title?.getAttribute('title')).toBe('Draft in the prompt box (not sent yet)')
      // After sending (lastEventAt is set), the usual title applies even if a draft remains.
      await render(summary('ログを調べて', 5))
      expect(host.querySelector('.thread-row-title.provisional')).toBeNull()
      expect(host.querySelector('.thread-row-title')?.textContent).toBe('ログを調べて')
    } finally {
      act(() => useThreads.setState(saved, true))
    }
  })

  it('the italic is .provisional in styles.css', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.thread-row-title\.provisional\s*\{\s*font-style:\s*italic;/)
  })
})
