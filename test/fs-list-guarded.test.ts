/**
 * Observation for item 333 (wave 18, owner decision 2026-10-03): the `aios:fs/list` handler does not throw even when the choke point (`FsAccess.assertAllowed`) refuses. If it threw, `ipcMain.handle`'s default mechanism would leave it uncaught and print the stack to stderr with `console.error` (`Error occurred in handler for 'aios:fs/list': PathDenied: excluded`). This happened every time a thread that showed a viewer for something under an exclusion (such as memory under `~/.claude`) was displayed.
 *
 * Calls `listDirectoryGuarded` (a pure function split out of `src/main/ipc/handlers.ts`) directly, without setting up `ipcMain`, and confirms (1) that when refused it returns the reason as a value, and (2) that when allowed it calls the index process's `listDirectory` as it is. Calls neither the model nor Electron.
 */
import { describe, expect, it, vi } from 'vitest'
import { listDirectoryGuarded } from '../src/main/ipc/handlers.js'
import { PathDenied } from '../src/common/fs-policy.js'
import type { DirectoryListing } from '../src/shared/types.js'

describe('listDirectoryGuarded (項目 333)', () => {
  it('関門に断られたら、例外を投げず理由を値として返す (entries は空)', async () => {
    const fs = {
      assertAllowed: vi.fn(() => {
        throw new PathDenied('excluded')
      })
    }
    const index = { listDirectory: vi.fn() }
    const result = await listDirectoryGuarded(fs, index, 'file:///Users/x/.claude/memory', {})
    expect(result).toEqual({
      uri: 'file:///Users/x/.claude/memory',
      entries: [],
      live: true,
      reason: 'path-excluded'
    } satisfies DirectoryListing)
    expect(index.listDirectory).not.toHaveBeenCalled()
  })

  it('symlink の逃げ道など、他の DenyReason も理由コードに変換される', async () => {
    const fs = {
      assertAllowed: vi.fn(() => {
        throw new PathDenied('symlink-escape')
      })
    }
    const index = { listDirectory: vi.fn() }
    const result = await listDirectoryGuarded(fs, index, 'file:///x', {})
    expect(result.reason).toBe('path-symlink-escape')
  })

  it('PathDenied 以外の例外でも投げ直さず、メッセージをそのまま理由にする', async () => {
    const fs = {
      assertAllowed: vi.fn(() => {
        throw new Error('boom')
      })
    }
    const index = { listDirectory: vi.fn() }
    const result = await listDirectoryGuarded(fs, index, 'file:///x', {})
    expect(result.reason).toBe('boom')
    expect(result.entries).toEqual([])
  })

  it('許されれば索引プロセスの listDirectory をそのまま呼び、その戻り値を返す', async () => {
    const fs = { assertAllowed: vi.fn() }
    const listing: DirectoryListing = { uri: 'file:///ok', entries: [], live: false, reason: null }
    const index = { listDirectory: vi.fn().mockResolvedValue(listing) }
    const result = await listDirectoryGuarded(fs, index, 'file:///ok', { showHidden: false })
    expect(result).toBe(listing)
    expect(index.listDirectory).toHaveBeenCalledWith('file:///ok', { showHidden: false })
  })
})
