// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('copyThreadWorkspace reports failures (TODO 1337 (11))', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('a failed kind is reported to main by name with the new conversation id (no values), and the others still run', async () => {
    const copyViewerMemoryTo = vi.fn()
    const copyViewerHistoryTo = vi.fn(async () => {
      throw new Error('secret value /private/path')
    })
    vi.doMock('../src/renderer/src/viewerMemory.js', () => ({ copyViewerMemoryTo }))
    vi.doMock('../src/renderer/src/viewerHistory.js', () => ({ copyViewerHistoryTo }))
    vi.doMock('../src/renderer/src/filerHistory.js', () => ({ copyFilerHistoryTo: vi.fn() }))
    vi.doMock('../src/renderer/src/threadStore.js', () => ({ useThreads: { setState: vi.fn() } }))
    const workspaceCopyFailed = vi.fn()
    ;(window as unknown as { aios: unknown }).aios = { threads: { workspaceCopyFailed } }
    const workspace = await import('../src/renderer/src/thread-workspace.js')
    expect(await workspace.copyThreadWorkspace('src', 'dst')).toEqual(['viewerHistory'])
    expect(copyViewerMemoryTo).toHaveBeenCalled()
    expect(workspaceCopyFailed).toHaveBeenCalledWith('dst', ['viewerHistory'])
    expect(JSON.stringify(workspaceCopyFailed.mock.calls)).not.toContain('secret')
    vi.doUnmock('../src/renderer/src/viewerMemory.js')
    vi.doUnmock('../src/renderer/src/viewerHistory.js')
    vi.doUnmock('../src/renderer/src/filerHistory.js')
    vi.doUnmock('../src/renderer/src/threadStore.js')
  })

  it('nothing is reported when nothing failed', async () => {
    const workspaceCopyFailed = vi.fn()
    ;(window as unknown as { aios: unknown }).aios = { threads: { workspaceCopyFailed } }
    const workspace = await import('../src/renderer/src/thread-workspace.js')
    expect(await workspace.copyThreadWorkspace('same', 'same')).toEqual([])
    expect(workspaceCopyFailed).not.toHaveBeenCalled()
  })
})
