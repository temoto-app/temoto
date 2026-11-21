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

describe('resolveDroppedFolder (項目 98)', () => {
  it('フォルダはそのまま、ファイルは親のフォルダになる', async () => {
    expect(await resolveDroppedFolder(['file:///x/a'], fakeFs())).toBe('file:///x/a')
    expect(await resolveDroppedFolder(['file:///x/a/one.txt'], fakeFs())).toBe('file:///x/a')
  })

  it('数えるのは親に直した後: 同じフォルダのファイル何個でも、フォルダ自身と混ぜても 1 つ', async () => {
    const uris = ['file:///x/a/one.txt', 'file:///x/a/two.txt', 'file:///x/a']
    expect(await resolveDroppedFolder(uris, fakeFs())).toBe('file:///x/a')
  })

  it('末尾の / は同じフォルダとして数える', async () => {
    expect(await resolveDroppedFolder(['file:///x/a/', 'file:///x/a/one.txt'], fakeFs())).toBe(
      'file:///x/a'
    )
  })

  it('フォルダが 2 つ以上なら drop-multiple-folders (ファイルの親が違う場合も)', async () => {
    expect(await reasonOf(resolveDroppedFolder(['file:///x/a', 'file:///x/b'], fakeFs()))).toBe(
      'drop-multiple-folders'
    )
    expect(
      await reasonOf(resolveDroppedFolder(['file:///x/a/one.txt', 'file:///x/b/three.txt'], fakeFs()))
    ).toBe('drop-multiple-folders')
  })

  it('数は params に載る', async () => {
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

  it('大文字小文字だけ違うパスは同じフォルダ (APFS の畳み込み)', async () => {
    expect(await resolveDroppedFolder(['file:///x/a', 'file:///x/A'], fakeFs())).toBe('file:///x/a')
  })

  it('空・見つからない・数が多すぎるものは理由コードで拒否', async () => {
    expect(await reasonOf(resolveDroppedFolder([], fakeFs()))).toBe('drop-empty')
    expect(await reasonOf(resolveDroppedFolder(['file:///x/none'], fakeFs()))).toBe('drop-not-found')
    const many = Array.from({ length: 300 }, (_, i) => `file:///x/a/f${i}`)
    expect(await reasonOf(resolveDroppedFolder(many, fakeFs()))).toBe('invalid-value')
  })

  it('除外に当たるものは関門の例外のまま、`stat` もしない', async () => {
    const fs = fakeFs()
    expect(await reasonOf(resolveDroppedFolder(['file:///x/Library'], fs))).toBe('excluded')
    expect(await reasonOf(resolveDroppedFolder(['file:///x/Library/cfg'], fs))).toBe('excluded')
    expect(fs.stats).toEqual([])
  })

  it('ファイル自身は通っても親が除外なら落ちる (決まったフォルダにも関門を掛ける)', async () => {
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

  it('file: 以外は拒否', async () => {
    expect(await reasonOf(resolveDroppedFolder(['https://example.com/'], fakeFs()))).toBe(
      'unsupported scheme'
    )
  })

  it('実物の kindOfPath: ディレクトリ / ファイル / 無い', async () => {
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

describe('createThreadFromDrop (項目 98)', () => {
  it('決まったフォルダを cwdUri にして作る。cwd 以外の値はそのまま渡る', async () => {
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

  it('拒否したときは作らない', async () => {
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

describe('OpenFileBatcher (項目 98 (c))', () => {
  it('続けて届いた分を 100 ms まとめて 1 回で流す', () => {
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

  it('ready より前は溜めるだけで、markReady の後に同じ判定へ流す', () => {
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

  it('ready になっても溜まっていなければ何もしない', () => {
    const timers = fakeTimers()
    const flush = vi.fn()
    new OpenFileBatcher(flush, 100, timers).markReady()
    timers.advance(1000)
    expect(flush).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it('dispose の後は流さず、以後の push も捨てる (12.9)', () => {
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

describe('OpenRequests (項目 98 (c))', () => {
  it('窓ごとに 1 件、取ったら消える。後から来たほうが勝つ', () => {
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

describe('droppedUris / carriesFiles (renderer、項目 98)', () => {
  it('File を URI に直し、uri-list の file: だけを足す (重複は 1 つ)', () => {
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

  it('ファイルか URI の列を運ぶドラッグだけを受ける', () => {
    expect(carriesFiles(['Files'])).toBe(true)
    expect(carriesFiles(['text/uri-list'])).toBe(true)
    expect(carriesFiles(['text/plain'])).toBe(false)
  })
})
