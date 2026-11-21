/**
 * Observation for item 333 (wave 18, owner decision 2026-10-03): the `aios:fs/list` handler does not throw even when the choke point (`FsAccess.assertAllowed`) refuses. If it threw, `ipcMain.handle`'s default mechanism would leave it uncaught and print the stack to stderr with `console.error` (`Error occurred in handler for 'aios:fs/list': PathDenied: excluded`). This happened every time a thread that showed a viewer for something under an exclusion (such as memory under `~/.claude`) was displayed.
 *
 * Calls `listDirectoryGuarded` (a pure function split out of `src/main/ipc/handlers.ts`) directly, without setting up `ipcMain`, and confirms (1) that when refused it returns the reason as a value, and (2) that when allowed it calls the index process's `listDirectory` as it is. Calls neither the model nor Electron.
 */
import { describe, expect, it, vi } from 'vitest'
import { listDirectoryGuarded } from '../src/main/ipc/handlers.js'
import { PathDenied } from '../src/common/fs-policy.js'
import type { DirectoryListing } from '../src/shared/types.js'

describe('listDirectoryGuarded (item 333)', () => {
  it('when the choke point refuses, returns the reason as a value instead of throwing (entries is empty)', async () => {
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

  it('other DenyReasons such as a symlink escape are also converted to reason codes', async () => {
    const fs = {
      assertAllowed: vi.fn(() => {
        throw new PathDenied('symlink-escape')
      })
    }
    const index = { listDirectory: vi.fn() }
    const result = await listDirectoryGuarded(fs, index, 'file:///x', {})
    expect(result.reason).toBe('path-symlink-escape')
  })

  it('even for exceptions other than PathDenied, does not rethrow and uses the message as the reason', async () => {
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

  it("when allowed, calls the index process's listDirectory as is and returns its result", async () => {
    const fs = { assertAllowed: vi.fn() }
    const listing: DirectoryListing = { uri: 'file:///ok', entries: [], live: false, reason: null }
    const index = { listDirectory: vi.fn().mockResolvedValue(listing) }
    const result = await listDirectoryGuarded(fs, index, 'file:///ok', { showHidden: false })
    expect(result).toBe(listing)
    expect(index.listDirectory).toHaveBeenCalledWith('file:///ok', { showHidden: false })
  })
})
