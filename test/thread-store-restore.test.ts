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

describe('削除済みスレッドの一覧と復元 (項目 191)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('loadDeletedThreads は main の一覧をそのまま state に写す', async () => {
    stubAios({ listDeleted: DELETED })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    expect(useThreads.getState().deletedThreads).toEqual([])
    await useThreads.getState().loadDeletedThreads()
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('restoreThread は成功すると削除済み一覧からその場で取り除き true を返す', async () => {
    const restoredThread = { id: 'd1' } as Thread
    const { restore } = stubAios({ listDeleted: DELETED, restore: async () => restoredThread })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().loadDeletedThreads()
    const ok = await useThreads.getState().restoreThread('d1')

    expect(restore).toHaveBeenCalledWith('d1')
    expect(ok).toBe(true)
    expect(useThreads.getState().deletedThreads.map((t) => t.id)).toEqual(['d2'])
  })

  it('restoreThread は main が null を返したら (削除済みでない・存在しない) false のまま一覧は変えない', async () => {
    stubAios({ listDeleted: DELETED, restore: async () => null })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().loadDeletedThreads()
    const ok = await useThreads.getState().restoreThread('d1')

    expect(ok).toBe(false)
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('removeThread が成功したら削除済み一覧を取り直す (項目 191: 削除の直後に取り直す)', async () => {
    const { listDeleted } = stubAios({ listDeleted: DELETED, removeResult: { removed: true, scratchEntries: 0 } })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().removeThread('t1')

    expect(listDeleted).toHaveBeenCalledTimes(1)
    expect(useThreads.getState().deletedThreads).toEqual(DELETED)
  })

  it('removeThread が確認待ち (removed: false、捨て場に中身あり) のときは削除済み一覧を取り直さない', async () => {
    const { listDeleted } = stubAios({ removeResult: { removed: false, scratchEntries: 3 } })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')

    await useThreads.getState().removeThread('t1')

    expect(listDeleted).not.toHaveBeenCalled()
  })
})
