// @vitest-environment jsdom
/**
 * TODO 586 (wave 28 bundle B): pressing a folder path link in an answer switches to Files mode and opens that folder
 * (`openLinkHref` in `markdown-link.ts` → main's `fs.resolveLink` returns `directory: true` → `revealFolderInFiles`).
 * It does not go into the viewer (`select` is not called). Files still open in the viewer as before. Touches neither the model nor Electron.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkResolution } from '../src/shared/link.js'

const resolveLink = vi.fn<(input: unknown) => Promise<LinkResolution>>()

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  resolveLink.mockReset()
  ;(window as unknown as { aios: unknown }).aios = { fs: { resolveLink } }
})

describe('TODO 586: a folder link opens in Files', () => {
  it('for a folder, switches to Files mode and reveals that folder; the viewer is not changed', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    const { openLinkHref } = await import('../src/renderer/src/markdown-link.js')
    const reveal = vi.fn(async () => true)
    const select = vi.fn()
    useStore.setState({ reveal, select } as never)
    useThreads.setState({ mode: 'threads', sidebarCollapsed: false, activeThreadId: 't1', error: null })
    resolveLink.mockResolvedValueOnce({ ok: true, uri: 'file:///Users/me/proj/src', directory: true })

    openLinkHref('/Users/me/proj/src/', null)
    await settle()

    expect(resolveLink).toHaveBeenCalledWith({ href: '/Users/me/proj/src/', threadId: 't1', baseUri: null })
    expect(useThreads.getState().mode).toBe('files')
    expect(reveal).toHaveBeenCalledWith('file:///Users/me/proj/src')
    expect(select).not.toHaveBeenCalled()
    expect(useThreads.getState().error).toBeNull()
  })

  it('even from a collapsed sidebar (another mode), Files stays open (proxy verification 620-3 of run 33)', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    const { openLinkHref } = await import('../src/renderer/src/markdown-link.js')
    useStore.setState({ reveal: vi.fn(async () => true), select: vi.fn() } as never)
    for (const mode of ['threads', 'files'] as const) {
      useThreads.setState({ mode, sidebarCollapsed: true, activeThreadId: 't1', error: null })
      resolveLink.mockResolvedValueOnce({ ok: true, uri: 'file:///Users/me/proj/src', directory: true })
      openLinkHref('/Users/me/proj/src/', null)
      await settle()
      expect(useThreads.getState().mode, mode).toBe('files')
      expect(useThreads.getState().sidebarCollapsed, mode).toBe(false)
    }
  })

  it('for a file, opens in the viewer as before (the mode is not changed)', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    const { openLinkHref } = await import('../src/renderer/src/markdown-link.js')
    const reveal = vi.fn(async () => true)
    const select = vi.fn()
    useStore.setState({ reveal, select } as never)
    useThreads.setState({ mode: 'threads', sidebarCollapsed: false, activeThreadId: 't1' })
    resolveLink.mockResolvedValueOnce({ ok: true, uri: 'file:///Users/me/proj/a.ts', line: 3 })

    openLinkHref('/Users/me/proj/a.ts:3', null)
    await settle()

    expect(select).toHaveBeenCalledWith('file:///Users/me/proj/a.ts', { line: 3, column: null })
    expect(reveal).not.toHaveBeenCalled()
    expect(useThreads.getState().mode).toBe('threads')
  })
})
