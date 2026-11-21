/**
 * TODO 1158 (wave 71 bundle A, ARCHITECTURE 7.6.1): the gateway's `searchFiles` (puts filename search into the conversation's CLI).
 *
 *  - main (`GatewayRequests`) passes the conversation's working folder as cwd (if it has moved to a worktree, that one), and returns the index rows after applying the current exclusion rules again. Each row has a `path` that can be given to `openFile` / Read, and an `id` that can be given to `getDocument`
 *  - The index process (the 'link' path of `FsIndexer.searchFiles`) attaches document ids, and does not cut off the user's ⌘P search
 *
 * Uses neither the model nor Electron.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import { respondOrError } from '../src/gateway/respond.js'
import type { FileEntry, FileSearchResult } from '../src/shared/types.js'
import type { Thread } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

function entry(path: string, documentId: number, isDirectory = false): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    uri: `file://${path}`,
    parentUri: `file://${path.slice(0, path.lastIndexOf('/'))}`,
    name,
    isDirectory,
    size: isDirectory ? 0 : 12,
    mtimeMs: 1000,
    ext: isDirectory ? '' : name.slice(name.lastIndexOf('.') + 1),
    documentId
  }
}

interface Call {
  readonly query: string
  readonly limit: number
  readonly cwdUri: string | undefined
}

function gateway(options: { worktreeUri?: string | null; denyCwd?: boolean; result?: Partial<FileSearchResult> } = {}): {
  requests: GatewayRequests
  calls: Call[]
} {
  const calls: Call[] = []
  const thread = {
    id: 't1',
    title: 'T',
    backend: 'x',
    cwdUri: 'file:///work/app',
    worktreeUri: options.worktreeUri ?? null,
    approvalStrict: false
  } as unknown as Thread
  const result: FileSearchResult = {
    entries: [entry('/other/report.md', 11), entry('/secret/.ssh/report.md', 12), entry('/other/reports', 13, true)],
    total: 3,
    truncated: false,
    scanTruncated: true,
    cwd: { uri: 'file:///work/app', entries: [entry('/work/app/report.ts', 21)], total: 1, truncated: false, scanTruncated: false },
    caseSensitive: true,
    cancelled: false,
    tookMs: 3,
    ...options.result
  }
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
    getThread: () => thread,
    fs: {
      assertAllowed: (uri: string) => {
        if (uri.includes('/.ssh/') || (options.denyCwd === true && uri.startsWith('file:///work'))) throw new Error('excluded')
        return uri.replace('file://', '')
      }
    },
    index: {
      searchFilesForAgent: async (query: string, limit: number, cwdUri?: string) => {
        calls.push({ query, limit, cwdUri })
        return result
      }
    } as unknown as GatewayRequestHost['index']
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), calls }
}

describe('gateway searchFiles (GatewayRequests)', () => {
  it('passes the working folder as cwd, returns the cwd section first with path and id attached; rows hitting an exclusion are dropped', async () => {
    const { requests, calls } = gateway()
    const reply = await requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'report', limit: 20 } })
    expect(calls).toEqual([{ query: 'report', limit: 20, cwdUri: 'file:///work/app' }])
    expect(reply).toEqual({
      in_working_folder: {
        path: '/work/app',
        hits: [
          { id: '21', uri: 'file:///work/app/report.ts', path: '/work/app/report.ts', name: 'report.ts', kind: 'file', size: 12, modified_at: 1000 }
        ],
        total: 1,
        truncated: false
      },
      hits: [
        { id: '11', uri: 'file:///other/report.md', path: '/other/report.md', name: 'report.md', kind: 'file', size: 12, modified_at: 1000 },
        // Folders get no id (they have no body).
        { uri: 'file:///other/reports', path: '/other/reports', name: 'reports', kind: 'directory', size: 0, modified_at: 1000 }
      ],
      // A row dropped by an exclusion is not counted (`total` is on the same scale as the rows returned).
      total: 2,
      // A cut in the scan (`scanTruncated`) is also reported as "not everything".
      truncated: true,
      case_sensitive: true
    })
  })

  it('a conversation that moved to a worktree passes that as cwd; if the working folder is refused by the choke point, the search continues without cwd', async () => {
    const moved = gateway({ worktreeUri: 'file:///work/app-wt' })
    await moved.requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'x' } })
    expect(moved.calls[0]?.cwdUri).toBe('file:///work/app-wt')

    const denied = gateway({ denyCwd: true })
    await denied.requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'x' } })
    expect(denied.calls[0]?.cwdUri).toBeUndefined()
  })

  it('if the index is stopped / cut off by a restart (cancelled), a tool error rather than an empty list (wave 71 review X)', async () => {
    const { requests } = gateway({ result: { entries: [], total: 0, cwd: null, cancelled: true } })
    const reply = await requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'report' } })
    expect(reply).toMatchObject({ reason: 'index-unavailable' })
    expect(reply).not.toHaveProperty('hits')
    expect(typeof (reply as { error?: unknown }).error).toBe('string')
    // The gateway makes `{ error }` isError, so that it is not mistaken for an empty result.
    expect(respondOrError(reply).isError).toBe(true)
    expect(respondOrError({ hits: [], total: 0, truncated: false }).isError).toBeUndefined()
  })

  it('rows dropped by exclusion are subtracted from total, and truncated is only "more than the rows returned" or a scan cut-off (wave 71 review X)', async () => {
    // All 3 were returned, but 1 (.ssh) was dropped: total 2 = the 2 returned, and it does not say that more exist.
    const all = gateway({ result: { scanTruncated: false } })
    const reply = (await all.requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'report' } })) as {
      hits: unknown[]
      total: number
      truncated: boolean
    }
    expect(reply.hits).toHaveLength(2)
    expect(reply.total).toBe(2)
    expect(reply.truncated).toBe(false)
    // If the index total is larger than the rows returned (a cut by count), it is truncated even after subtracting what was dropped.
    const more = gateway({ result: { total: 10, truncated: true, scanTruncated: false } })
    const cut = (await more.requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'report' } })) as {
      hits: unknown[]
      total: number
      truncated: boolean
    }
    expect(cut.hits).toHaveLength(2)
    expect(cut.total).toBe(9)
    expect(cut.truncated).toBe(true)
  })

  it('limit is clamped to 1-50, 20 if absent; a query that is not a string is empty', async () => {
    const { requests, calls } = gateway()
    await requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'a', limit: 500 } })
    await requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 'a', limit: 0 } })
    await requests.handle({ sessionId: 's1', kind: 'searchFiles', payload: { query: 42 } })
    expect(calls.map((call) => [call.query, call.limit])).toEqual([
      ['a', 50],
      ['a', 1],
      ['', 20]
    ])
  })
})

describe('searchFiles results of the index process carry the document id (TODO 1158)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer

  beforeAll(async () => {
    root = makeTestDir('gateway-search-files')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'release-notes.md'), 'notes\n')
    writeFileSync(join(root, 'other.txt'), 'other\n')
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
    fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
    await fs.scan()
  })

  afterAll(async () => {
    await fs.stop()
    if (db.open) db.close()
    removeTestDir(root)
  })

  it("each row of the 'link' path (gateway) result has documents.id and does not cancel the user's search", async () => {
    const user = fs.searchFiles('release', 20)
    const agent = await fs.searchFiles('release', 20, null, null, 'link')
    expect((await user).cancelled).toBe(false)
    expect(agent.entries.map((e) => e.name)).toEqual(['release-notes.md'])
    const id = db
      .prepare(`SELECT id FROM documents WHERE source = 'fs' AND name = 'release-notes.md'`)
      .pluck()
      .get() as number
    expect(agent.entries[0]?.documentId).toBe(id)
  })
})
