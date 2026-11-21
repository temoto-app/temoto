// TODO 1238 (wave 92, review): on the manual path a harmless replacement between lstat and open (an editor's
// rename-save) must be retried once, and when it cannot settle it must NOT look like a symlink (ELOOP) or like a
// missing file: the caller would drop an index row.
import { closeSync, mkdtempSync, rmSync, writeFileSync, renameSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Runs at every openSync: lets a test swap the file just before the real open.
const hooks = vi.hoisted(() => ({ beforeOpen: null as null | (() => void) }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, openSync: (...args: Parameters<typeof real.openSync>) => (hooks.beforeOpen?.(), real.openSync(...args)) }
})

import { openNoFollowSync, UnsafeOpenError } from '../src/common/os/open-flags.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'open-flags-race-'))
})
afterEach(() => {
  hooks.beforeOpen = null
  rmSync(dir, { recursive: true, force: true })
})

function swapFile(path: string, n: number): () => void {
  let left = n
  return () => {
    if (left-- <= 0) return
    const tmp = `${path}.tmp${left}`
    writeFileSync(tmp, 'new')
    renameSync(tmp, path)
  }
}

describe('replacement between lstat and open (no flags)', () => {
  it('retries once and opens the replacement', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'old')
    hooks.beforeOpen = swapFile(file, 1)
    closeSync(openNoFollowSync(file, constants.O_RDONLY, { table: {} }))
  })
  it('throws ECHANGED (not ELOOP) when the path keeps changing', () => {
    const file = join(dir, 'b.txt')
    writeFileSync(file, 'old')
    hooks.beforeOpen = swapFile(file, 2)
    try {
      closeSync(openNoFollowSync(file, constants.O_RDONLY, { table: {} }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeOpenError)
      expect((err as UnsafeOpenError).code).toBe('ECHANGED')
    }
  })
})
