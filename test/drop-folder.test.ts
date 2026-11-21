/**
 * Item 98: the decision of whether a folder Drop creates a thread (`src/main/drop.ts`).
 *
 * - Files are turned into their parent folder; counting happens after that; two or more are rejected; exclusions stay an exception at the choke point
 * - The Dock's `open-file` is batched over 100 ms and held until `ready` (the clock is injected)
 * - The "thread to open" handed over to the window
 * - How the renderer collects URIs (`drop-uris.ts`)
 *
 * Does not use electron. fs is also an injected fake (the real `kindOfPath` is checked only in a temp directory).
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OpenFileBatcher,
  OpenRequests,
  createThreadFromDrop,
  kindOfPath,
  resolveDroppedFolder,
  type DropFolderDeps,
  type DropTimers
} from '../src/main/drop.js'
import { parseReason } from '../src/shared/reason.js'
import type { CreateThreadInput, Thread } from '../src/shared/thread.js'
import { carriesFiles, droppedUris } from '../src/renderer/src/drop-uris.js'

/** `/x/dirs/...` is a directory, `/x/files/...` is a file, anything under `/Library` is excluded, and nothing else exists. */
function fakeFs(): DropFolderDeps & { stats: string[] } {
  const stats: string[] = []
  const dirs = new Set(['/x/a', '/x/b', '/x/A', '/x/Library'])
  const files = new Set(['/x/a/one.txt', '/x/a/two.txt', '/x/b/three.txt', '/x/Library/cfg'])
  return {
    stats,
    assertAllowed(uri: string): string {
      if (!uri.startsWith('file://')) throw new Error('unsupported scheme')
      const path = decodeURIComponent(uri.slice('file://'.length))
      if (path === '/x/Library' || path.startsWith('/x/Library/')) throw new Error('excluded')
      return path
    },
    async kindOf(path: string) {
      stats.push(path)
      if (dirs.has(path)) return 'directory'
      if (files.has(path)) return 'other'
      return null
    }
  }
}

const reasonOf = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise
    return null
  } catch (err) {
    return parseReason((err as Error).message)?.code ?? (err as Error).message
  }
}

describe('resolveDroppedFolder (item 98)', () => {
  it('a folder stays as is, and a file becomes its parent folder', async () => {
    expect(await resolveDroppedFolder(['file:///x/a'], fakeFs())).toBe('file:///x/a')
    expect(await resolveDroppedFolder(['file:///x/a/one.txt'], fakeFs())).toBe('file:///x/a')
  })

  it('counts after converting to the parent: any number of files in the same folder, or mixed with the folder itself, is 1', async () => {
    const uris = ['file:///x/a/one.txt', 'file:///x/a/two.txt', 'file:///x/a']
    expect(await resolveDroppedFolder(uris, fakeFs())).toBe('file:///x/a')
  })

  it('a trailing / counts as the same folder', async () => {
    expect(await resolveDroppedFolder(['file:///x/a/', 'file:///x/a/one.txt'], fakeFs())).toBe(
      'file:///x/a'
    )
  })

  it('with two or more folders, drop-multiple-folders (also when files have different parents)', async () => {
    expect(await reasonOf(resolveDroppedFolder(['file:///x/a', 'file:///x/b'], fakeFs()))).toBe(
      'drop-multiple-folders'
    )
    expect(
      await reasonOf(resolveDroppedFolder(['file:///x/a/one.txt', 'file:///x/b/three.txt'], fakeFs()))
    ).toBe('drop-multiple-folders')
  })

  it('the count is carried in params', async () => {
    try {
      await resolveDroppedFolder(['file:///x/a', 'file:///x/b', 'file:///x/b/three.txt'], fakeFs())
      expect.unreachable()
    } catch (err) {
      expect(parseReason((err as Error).message)).toEqual({
        code: 'drop-multiple-folders',
        params: { count: 2 }
      })
    }
  })

  it('paths that differ only in case are the same folder (APFS folding)', async () => {
    expect(await resolveDroppedFolder(['file:///x/a', 'file:///x/A'], fakeFs())).toBe('file:///x/a')
  })

  it('empty, not found and too many are refused with a reason code', async () => {
    expect(await reasonOf(resolveDroppedFolder([], fakeFs()))).toBe('drop-empty')
    expect(await reasonOf(resolveDroppedFolder(['file:///x/none'], fakeFs()))).toBe('drop-not-found')
    const many = Array.from({ length: 300 }, (_, i) => `file:///x/a/f${i}`)
    expect(await reasonOf(resolveDroppedFolder(many, fakeFs()))).toBe('invalid-value')
  })

  it("those that hit an exclusion stay as the choke point's exception and `stat` is not called", async () => {
    const fs = fakeFs()
    expect(await reasonOf(resolveDroppedFolder(['file:///x/Library'], fs))).toBe('excluded')
    expect(await reasonOf(resolveDroppedFolder(['file:///x/Library/cfg'], fs))).toBe('excluded')
    expect(fs.stats).toEqual([])
  })

  it('even if the file itself passes, it falls if the parent is excluded (the choke point is applied to the decided folder too)', async () => {
    const fs = fakeFs()
    const deps: DropFolderDeps = {
      assertAllowed: (uri, asDirectory) => {
        // The choke point that excludes only the parent (/x/a, asked as a directory).
        if (asDirectory && uri === 'file:///x/a') throw new Error('excluded')
        return fs.assertAllowed(uri, asDirectory)
      },
      kindOf: fs.kindOf
    }
    expect(await reasonOf(resolveDroppedFolder(['file:///x/a/one.txt'], deps))).toBe('excluded')
  })

  it('refuses anything other than file:', async () => {
    expect(await reasonOf(resolveDroppedFolder(['https://example.com/'], fakeFs()))).toBe(
      'unsupported scheme'
    )
  })

  it('the real kindOfPath: directory / file / missing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-drop-')))
    try {
      writeFileSync(join(dir, 'f.txt'), 'x')
      expect(await kindOfPath(dir)).toBe('directory')
      expect(await kindOfPath(join(dir, 'f.txt'))).toBe('other')
      expect(await kindOfPath(join(dir, 'none'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createThreadFromDrop (item 98)', () => {
  it('creates with the decided folder as cwdUri; values other than cwd pass through as is', async () => {
    const created: CreateThreadInput[] = []
    const thread = await createThreadFromDrop(
      ['file:///x/a/one.txt'],
      { modelId: 'm', approvalStrict: true },
      {
        ...fakeFs(),
        create: async (input) => {
          created.push(input)
          return { id: 't1' } as Thread
        }
      }
    )
    expect(thread.id).toBe('t1')
    expect(created).toEqual([
      { modelId: 'm', approvalStrict: true, cwdUri: 'file:///x/a' }
    ])
  })

  it('does not create when refused', async () => {
    const create = vi.fn(async () => ({ id: 't' }) as Thread)
    await expect(
      createThreadFromDrop(['file:///x/a', 'file:///x/b'], {}, { ...fakeFs(), create })
    ).rejects.toThrow('drop-multiple-folders')
    expect(create).not.toHaveBeenCalled()
  })
})

/** The injected clock. `advance(ms)` calls, in order, the timers whose time has come. */
function fakeTimers(): DropTimers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    set(callback, ms) {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clear(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    pending: () => timers.size
  }
}

describe('OpenFileBatcher (item 98 (c))', () => {
  it('flushes items that arrive in succession together in one go after 100 ms', () => {
    const timers = fakeTimers()
    const flushed: (readonly string[])[] = []
    const batcher = new OpenFileBatcher((paths) => flushed.push(paths), 100, timers)
    batcher.markReady()
    batcher.push('/x/a')
    timers.advance(60)
    batcher.push('/x/b')
    timers.advance(60)
    expect(flushed).toEqual([])
    timers.advance(40)
    expect(flushed).toEqual([['/x/a', '/x/b']])
    // The next Drop is a separate batch.
    batcher.push('/x/c')
    timers.advance(100)
    expect(flushed).toEqual([['/x/a', '/x/b'], ['/x/c']])
  })

  it('before ready only accumulates, and after markReady flows into the same decision', () => {
    const timers = fakeTimers()
    const flushed: (readonly string[])[] = []
    const batcher = new OpenFileBatcher((paths) => flushed.push(paths), 100, timers)
    batcher.push('/x/a')
    batcher.push('/x/a/one.txt')
    timers.advance(1000)
    expect(flushed).toEqual([])
    expect(timers.pending()).toBe(0)
    batcher.markReady()
    timers.advance(100)
    expect(flushed).toEqual([['/x/a', '/x/a/one.txt']])
  })

  it('does nothing when ready but nothing has accumulated', () => {
    const timers = fakeTimers()
    const flush = vi.fn()
    new OpenFileBatcher(flush, 100, timers).markReady()
    timers.advance(1000)
    expect(flush).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it('after dispose does not flush, and drops later pushes too (12.9)', () => {
    const timers = fakeTimers()
    const flush = vi.fn()
    const batcher = new OpenFileBatcher(flush, 100, timers)
    batcher.markReady()
    batcher.push('/x/a')
    batcher.dispose()
    batcher.push('/x/b')
    timers.advance(1000)
    expect(flush).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })
})

describe('OpenRequests (item 98 (c))', () => {
  it('one per window, removed once taken; the later one wins', () => {
    const requests = new OpenRequests()
    requests.put(1, { threadId: 'a' })
    requests.put(1, { threadId: 'b' })
    requests.put(2, { reason: 'aios-reason:drop-multiple-folders' })
    expect(requests.take(1)).toEqual({ threadId: 'b' })
    expect(requests.take(1)).toBeNull()
    requests.forget(2)
    expect(requests.take(2)).toBeNull()
  })
})

describe('droppedUris / carriesFiles (renderer, item 98)', () => {
  it('turns a File into a URI and adds only the file: entries of uri-list (duplicates are one)', () => {
    const files = ['F1', 'F2', 'bad']
    const uriFor = (file: unknown): string =>
      file === 'F1' ? 'file:///x/a' : file === 'F2' ? 'file:///x/a/one.txt' : ''
    const data = {
      files,
      getData: (format: string) =>
        format === 'text/uri-list' ? 'file:///x/a\r\nhttps://example.com\nfile:///x/b\n' : ''
    }
    expect(droppedUris(data, uriFor)).toEqual(['file:///x/a', 'file:///x/a/one.txt', 'file:///x/b'])
  })

  it('accepts only drags that carry files or a list of URIs', () => {
    expect(carriesFiles(['Files'])).toBe(true)
    expect(carriesFiles(['text/uri-list'])).toBe(true)
    expect(carriesFiles(['text/plain'])).toBe(false)
  })
})
