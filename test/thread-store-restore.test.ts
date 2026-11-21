/**
 * @vitest-environment jsdom
 *
 * The list of deleted threads and restore (item 191, renderer `threadStore.ts`).
 * `window.aios` is stubbed only for the entry points used (the same approach as `test/thread-store-created.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeletedThreadSummary, Thread, ThreadRemoveResult } from '../src/shared/thread.js'

const DELETED: DeletedThreadSummary[] = [
  { id: 'd1', title: '消したスレッド', cwdName: 'work', rainbow: 3, deletedAt: 2000 },
  { id: 'd2', title: '', cwdName: '', rainbow: null, deletedAt: 1000 }
]

function stubAios(options: {
  listDeleted?: DeletedThreadSummary[]
  restore?: (id: string) => Promise<Thread | null>
  removeResult?: ThreadRemoveResult
} = {}): {
  listDeleted: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const listDeleted = vi.fn().mockResolvedValue(options.listDeleted ?? [])
  const restore = vi.fn(options.restore ?? (async () => null))
  const remove = vi.fn().mockResolvedValue(options.removeResult ?? { removed: true, scratchEntries: 0 })
  ;(globalThis as { window: typeof window }).window = globalThis.window ?? ({} as typeof window)
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        listDeleted,
        restore,
        remove
      }
    }
  })
  return { listDeleted, restore, remove }
}

describe('list and restore of deleted threads (item 191)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("loadDeletedThreads copies main's list into state as is", async () => {
    stubAios({ listDeleted: DELETED })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    expect(useThreads.getState().deletedThreads).toEqual([])
    await useThreads.getState().loadDeletedThreads()
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('restoreThread removes it from the deleted list on the spot on success and returns true', async () => {
    const restoredThread = { id: 'd1' } as Thread
    const { restore } = stubAios({ listDeleted: DELETED, restore: async () => restoredThread })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().loadDeletedThreads()
    const ok = await useThreads.getState().restoreThread('d1')

    expect(restore).toHaveBeenCalledWith('d1')
    expect(ok).toBe(true)
    expect(useThreads.getState().deletedThreads.map((t) => t.id)).toEqual(['d2'])
  })

  it('restoreThread stays false when main returns null (not deleted or nonexistent) and leaves the list unchanged', async () => {
    stubAios({ listDeleted: DELETED, restore: async () => null })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().loadDeletedThreads()
    const ok = await useThreads.getState().restoreThread('d1')

    expect(ok).toBe(false)
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('re-fetches the deleted list when removeThread succeeds (item 191: re-fetch right after deletion)', async () => {
    const { listDeleted } = stubAios({ listDeleted: DELETED, removeResult: { removed: true, scratchEntries: 0 } })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().removeThread('t1')

    expect(listDeleted).toHaveBeenCalledTimes(1)
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('does not re-fetch the deleted list when removeThread awaits confirmation (removed: false, scratch has content)', async () => {
    const { listDeleted } = stubAios({ removeResult: { removed: false, scratchEntries: 3 } })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().removeThread('t1')

    expect(listDeleted).not.toHaveBeenCalled()
  })
})
