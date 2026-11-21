/**
 * RPC of the index process (P1, docs/OPTIMIZATION_BRIEF.md 3.8, item 4).
 *
 * No process is started. Instead:
 *  - **kernel side**: connects `IndexKernel` to a fake port (two `RpcPeer`s wired directly together), and actually round-trips `open` → `fs.listDirectory` / `index.search` → the reverse `conversation.readEventText` → `stop`.
 *    The DB is a real SQLite (in memory, with tables made by `migrations`).
 *  - **main side**: with `RpcPeer`, confirms that "a request before ready is made to wait" and that "if the peer dies, unanswered requests are rejected".
 *
 * The model is not called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { DirectoryListing, FileSearchResult } from '../src/shared/types.js'
import type { IndexStatus, SearchResponse } from '../src/shared/search.js'
import type { IndexRpcMessage } from '../src/shared/index-rpc.js'
import { INDEX_PROCESS_BUSY, INDEX_PROCESS_CRASHED } from '../src/shared/index-rpc.js'
import { parseReason } from '../src/shared/reason.js'
import type { ScanStatus } from '../src/shared/types.js'
import { RPC_TIMEOUT, RpcPeer } from '../src/common/rpc.js'
import { IndexKernel } from '../src/index-kernel/kernel.js'
import { pathToUri } from '../src/common/uri.js'
import type { TranscriptFeed } from '../src/main/index/client.js'
import { makeTestDir } from './helpers/tmp.js'

const temporary: string[] = []

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Wires the `RpcPeer` on the main side and the one on the kernel side directly together, and puts `IndexKernel` on top of them.
 * `setTimeout(0)` is inserted so that it is **asynchronous**, as the real `postMessage` is (if wired synchronously, a bug that only shows up on re-entry would be missed).
 */
interface Wired {
  readonly main: RpcPeer
  readonly kernel: IndexKernel
  readonly notifies: { event: string; payload: unknown }[]
}

function wire(
  mainMethods: Record<string, (params: unknown) => unknown> = {},
  options: { openFile?: (file: string, key: string | null) => Db } = {}
): Wired {
  const notifies: { event: string; payload: unknown }[] = []
  // They refer to each other, so one is set up later (the same order as the two real processes).
  const peers: { kernel?: RpcPeer } = {}
  const main = new RpcPeer(
    (message) => setTimeout(() => peers.kernel?.receive(message), 0),
    mainMethods,
    (notify) => notifies.push({ event: notify.event, payload: notify.payload })
  )
  const kernelPeer = new RpcPeer((message) => setTimeout(() => main.receive(message), 0))
  peers.kernel = kernelPeer
  const kernel = new IndexKernel(
    {
      notify: (event, payload) => kernelPeer.notify(event, payload),
      call: (method, params) => kernelPeer.request(method, params)
    },
    options.openFile === undefined ? {} : { openFile: options.openFile }
  )
  kernelPeer.setMethods(kernel.methods)
  return { main, kernel, notifies }
}

describe('IndexKernel を RPC 越しに叩く', () => {
  it('open → 一覧 → 検索 → 逆向きの正本読み → stop が往復する', async () => {
    const root = makeTestDir('rpc-test')
    temporary.push(root)
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'notes/report.md'), '# 報告\n\n索引プロセスの本文。\n')

    const events = new Map([
      ['e1', { text: '会話の本文です', threadId: 't1', ts: 1 }]
    ])
    const asked: string[] = []

    const wired = wire({
      'conversation.readEventText': (params) => {
        const { eventId } = params as { eventId: string }
        asked.push(eventId)
        return events.get(eventId) ?? null
      },
      'conversation.threadTitle': () => 'テストスレッド',
      'transcript.readMessageText': () => null,
      'plugin.read': () => null
    })

    // Uses the same path as the fallback (`file: null`). The index process makes its tables in its own :memory:, so the real migrations and the real SQLite run.
    await wired.main.request('open', {
      file: null,
      key: null,
      userVersion: 0,
      home: root,
      roots: [root]
    })
    expect(wired.notifies.map((n) => n.event)).toContain('ready')

    await wired.main.request('start', {})
    // The scan starts without waiting, so wait until the listing is returned from the index.
    for (let i = 0; i < 100; i += 1) {
      const listing = (await wired.main.request('fs.listDirectory', {
        uri: pathToUri(root)
      })) as DirectoryListing
      if (!listing.live) break
      await new Promise((done) => setTimeout(done, 50))
    }
    const listing = (await wired.main.request('fs.listDirectory', {
      uri: pathToUri(root)
    })) as DirectoryListing
    expect(listing.entries.map((e) => e.name)).toContain('notes')

    // The request number **works across the process boundary** (P6). The number is carried inside `options`, so if a type or repacking drops it along the way, the cut-off silently stops working.
    const fresh = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 5 }
    })) as SearchResponse
    expect(fresh.stale).not.toBe(true)
    const overtaken = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 3 }
    })) as SearchResponse
    expect(overtaken.stale).toBe(true)
    // The window (`origin`, TODO 497) is also carried inside `options`. A small number from another window is not discarded, and after `index.forgetOrigin` clears the bookkeeping, the same window's numbers pass again from 1.
    const windowOne = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 7, origin: 1 }
    })) as SearchResponse
    expect(windowOne.stale).not.toBe(true)
    const windowTwo = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 1, origin: 2 }
    })) as SearchResponse
    expect(windowTwo.stale).not.toBe(true)
    const behind = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 6, origin: 1 }
    })) as SearchResponse
    expect(behind.stale).toBe(true)
    await wired.main.request('index.forgetOrigin', { origin: 1 })
    const reloaded = (await wired.main.request('index.search', {
      query: 'notes',
      scope: 'files',
      options: { seq: 1, origin: 1 }
    })) as SearchResponse
    expect(reloaded.stale).not.toBe(true)

    // Putting in conversation events makes the index ask main for the body through a reverse RPC (3.4).
    await wired.main.request('index.conversationEvents', {
      events: [{ id: 'e1', threadId: 't1', title: '会話', ts: 1 }]
    })
    for (let i = 0; i < 100 && asked.length === 0; i += 1) {
      await new Promise((done) => setTimeout(done, 20))
    }
    expect(asked).toContain('e1')

    await wired.main.request('stop', {})
    expect(wired.notifies.map((n) => n.event)).toContain('stopped')
    // A request after closing is refused as "not open" (it does not go and touch the DB, 12.9).
    await expect(wired.main.request('fs.getScanStatus', {})).rejects.toThrow(/not open/)
  }, 60_000)

  it('main から届く電源の値が索引構築の速さの段に繋がっている (P4 × P1 → TODO 434 / 448)', async () => {
    // **Even if this wiring is cut, all the other tests still pass**: heat or Low Power Mode only stops the build from stopping, so the conditions of hang fact 8 (which occurred in Low Power Mode) are hit repeatedly against the machine. That is why it is checked here.
    const wired = wire()
    const home = makeTestDir('rpc-idle')
    temporary.push(home)
    await wired.main.request('open', { file: null, key: null, userVersion: 0, home, roots: [] })

    // If the heat is serious, the automatic resume does not run, and it waits (thermal).
    await wired.main.request('power', {
      idleSeconds: 10_000,
      onBattery: false,
      thermalState: 'serious',
      lowPower: false
    })
    await wired.main.request('index.resume', {})
    let status = (await wired.main.request('index.getStatus', {})) as IndexStatus
    expect(status.state).toBe('waiting')
    expect(status.message).toBe('thermal')

    // Low Power Mode also waits (low-power).
    await wired.main.request('power', {
      idleSeconds: 0,
      onBattery: true,
      thermalState: 'nominal',
      lowPower: true
    })
    await wired.main.request('index.resume', {})
    status = (await wired.main.request('index.getStatus', {})) as IndexStatus
    expect(status.state).toBe('waiting')
    expect(status.message).toBe('low-power')

    // The "resume" the user presses also passes the judgment since TODO 448: it does not advance while still in Low Power Mode (it only releases `userPaused`; the way of walking is the same as the automatic resume).
    await wired.main.request('index.resume', { manual: true })
    expect(((await wired.main.request('index.getStatus', {})) as IndexStatus).state).toBe(
      'waiting'
    )

    // When Low Power Mode is turned off, the same "resume" advances.
    await wired.main.request('power', {
      idleSeconds: 0,
      onBattery: false,
      thermalState: 'nominal',
      lowPower: false
    })
    await wired.main.request('index.resume', { manual: true })
    expect(((await wired.main.request('index.getStatus', {})) as IndexStatus).state).not.toBe(
      'waiting'
    )

    await wired.main.request('stop', {})
  }, 30_000)

  it('fs.scanSubtree が RPC 越しに部分木を走査し、cwd の区画に出す (項目 246)', async () => {
    const wired = wire()
    const home = makeTestDir('rpc-subtree')
    temporary.push(home)
    await wired.main.request('open', { file: null, key: null, userVersion: 0, home, roots: [home] })
    await wired.main.request('start', {})
    for (let i = 0; i < 100; i += 1) {
      const status = (await wired.main.request('fs.getScanStatus', {})) as ScanStatus
      if (status.state === 'done') break
      await new Promise((done) => setTimeout(done, 20))
    }
    // A tree made after the full scan (watch is set, but the test does not wait for its notification).
    const repo = join(home, 'fresh-repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'gizmo.ts'), 'export {}\n')

    const result = (await wired.main.request('fs.scanSubtree', { path: repo })) as { state: string }
    expect(result.state).toBe('done')
    const found = (await wired.main.request('fs.searchFiles', {
      query: 'gizmo',
      limit: 20,
      cwdUri: pathToUri(repo)
    })) as FileSearchResult
    expect(found.cwd?.entries.map((e) => e.name)).toEqual(['gizmo.ts'])
    // Checking the arguments: refuse if it is not a string.
    await expect(wired.main.request('fs.scanSubtree', { path: 1 })).rejects.toThrow(/path/)

    await wired.main.request('stop', {})
  }, 30_000)

  it('open していない kernel はどの method も断る', async () => {
    const wired = wire()
    await expect(wired.main.request('index.search', { query: 'x' })).rejects.toThrow(/not open/)
  })

  it('user_version が食い違う DB は開かない (migration は main の仕事)', async () => {
    // Returns a DB with `user_version = 0` without opening a real file.
    const wired = wire({}, { openFile: () => makeBareDatabase() })
    await expect(
      wired.main.request('open', {
        file: '/tmp/does-not-matter.db',
        key: null,
        userVersion: 99,
        home: homedir(),
        roots: null
      })
    ).rejects.toThrow(/version mismatch/)
  })
})

describe('RpcPeer', () => {
  it('相手が死んだら未応答の要求はまとめて reject される', async () => {
    const sent: IndexRpcMessage[] = []
    const peer = new RpcPeer((message) => sent.push(message))
    const first = peer.request('fs.getScanStatus', {})
    const second = peer.request('index.search', { query: 'x' })
    expect(peer.pendingCount).toBe(2)

    const err = new Error('index process exited')
    err.name = INDEX_PROCESS_CRASHED
    peer.rejectAll(err)

    await expect(first).rejects.toThrow('index process exited')
    await expect(second).rejects.toThrow('index process exited')
    expect(peer.pendingCount).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it('知らない method は error の応答を返す (投げっぱなしにしない)', async () => {
    const outbox: IndexRpcMessage[] = []
    const peer = new RpcPeer((message) => outbox.push(message), {})
    peer.receive({ kind: 'req', id: 7, method: 'nope', params: {} })
    await new Promise((done) => setTimeout(done, 0))
    expect(outbox[0]).toMatchObject({ kind: 'res', id: 7, ok: false })
  })

  it('上限を過ぎた要求は RpcTimeout で reject され、遅れた応答は捨てられる (項目 87)', async () => {
    const sent: IndexRpcMessage[] = []
    const peer = new RpcPeer((message) => sent.push(message))
    const slow = peer.request('index.search', { query: 'x' }, { timeoutMs: 20 })
    const unlimited = peer.request('fs.rescan', {})
    await expect(slow).rejects.toMatchObject({ name: RPC_TIMEOUT })
    // A request that was given up is removed from the wait. A request without a limit remains.
    expect(peer.pendingCount).toBe(1)

    // A response that arrives late has no id, so it is silently discarded (it does not resolve another request).
    const slowId = (sent[0] as { id: number }).id
    peer.receive({ kind: 'res', id: slowId, ok: true, result: { hits: [] } })
    expect(peer.pendingCount).toBe(1)

    const rescanId = (sent[1] as { id: number }).id
    peer.receive({ kind: 'res', id: rescanId, ok: true, result: null })
    await expect(unlimited).resolves.toBeNull()
  })

  it('上限内に返った要求の timer は残らない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sent: IndexRpcMessage[] = []
      const peer = new RpcPeer((message) => sent.push(message))
      const quick = peer.request('fs.listDirectory', {}, { timeoutMs: 10_000 })
      expect(vi.getTimerCount()).toBe(1)
      peer.receive({ kind: 'res', id: (sent[0] as { id: number }).id, ok: true, result: 1 })
      await expect(quick).resolves.toBe(1)
      expect(vi.getTimerCount()).toBe(0)

      const dead = peer.request('fs.listDirectory', {}, { timeoutMs: 10_000 })
      peer.rejectAll(new Error('index process exited'))
      await expect(dead).rejects.toThrow('exited')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ready 前に積まれた要求は、ready の後にまとめて流れる', async () => {
    // The same shape as `IndexClient.call`: waits for the `ready` Promise before sending.
    const sent: string[] = []
    let markReady: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    const peer = new RpcPeer((message) => {
      if (message.kind === 'req') sent.push(message.method)
    })
    const call = async (method: string): Promise<void> => {
      await ready
      void peer.request(method, {})
    }
    void call('fs.listDirectory')
    void call('index.search')
    await new Promise((done) => setTimeout(done, 10))
    expect(sent).toEqual([])

    markReady()
    await new Promise((done) => setTimeout(done, 10))
    expect(sent).toEqual(['fs.listDirectory', 'index.search'])
  })
})

/**
 * An in-memory DB with no tables, where `user_version` stays 0.
 * (Phase 1 fact: since it is an N-API prebuild, the real thing can be used from plain Node Vitest.)
 */
function makeBareDatabase(): Db {
  return new Database(':memory:')
}

/**
 * Drives IndexClient (the main side) with a **fake child process**.
 *
 * An Electron utility process cannot be started from plain Node, so `electron` is replaced and `utilityProcess.fork` returns an EventEmitter.
 * Only three things are checked here:
 *
 *  - a request that comes before `ready` (the response to `open`) is **held without being sent** (3.3)
 *  - if the child dies, unanswered requests are rejected with `IndexProcessCrashed` (3.7)
 *  - after it dies, it **forks again** with exponential backoff (3.7)
 */
class FakeChild extends EventEmitter {
  readonly posted: IndexRpcMessage[] = []
  killed = false
  readonly stdout = null
  readonly stderr = null
  postMessage(message: IndexRpcMessage): void {
    this.posted.push(message)
    // As with the real kernel, it answers `stop` at once. If it did not answer, main would wait 10 seconds and then kill it, which is correct in itself, but the test could not wait for it.
    if (message.kind === 'req' && message.method === 'stop') {
      setTimeout(() => this.reply(message.id, null), 0)
    }
  }
  kill(): void {
    this.killed = true
  }
  /** Returns one response from the child. */
  reply(id: number, result: unknown): void {
    this.emit('message', { kind: 'res', id, ok: true, result } satisfies IndexRpcMessage)
  }
  requests(): IndexRpcMessage[] {
    return this.posted.filter((m) => m.kind === 'req')
  }
}

const children: FakeChild[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    }
  }
}))

describe('IndexClient (偽の子プロセス)', () => {
  const makeClient = async (
    transcripts: TranscriptFeed | null = null,
    options: {
      timeouts?: Readonly<Record<string, number>>
      onScanStatus?: (status: ScanStatus) => void
      readyTimeoutMs?: number
    } = {}
  ): Promise<{ client: InstanceType<typeof IndexClient> }> => {
    const { IndexClient } = await import('../src/main/index/client.js')
    const client = new IndexClient({
      entry: '/nonexistent/index-host.js',
      open: { file: null, key: null, userVersion: 0, home: homedir(), roots: null },
      canonical: {
        conversation: { readEventText: () => null, threadTitle: () => null },
        transcripts,
        plugins: { read: () => null }
      },
      events: {
        onScanStatus: options.onScanStatus ?? (() => undefined),
        onFileChanges: () => undefined,
        onIndexStatus: () => undefined,
        onRules: () => undefined
      },
      ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs })
    })
    return { client } as { client: InstanceType<typeof IndexClient> }
  }

  it('ready の前に来た要求は送られずに待ち、ready の後にまとめて流れる', async () => {
    children.length = 0
    const { client } = await makeClient()
    const started = client.start()
    const child = children[0] as FakeChild
    expect(child.requests()).toHaveLength(0)

    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    // The only thing sent right after spawn is `open`. **The key is handed over here** (not in argv or env).
    expect(child.requests().map((m) => (m as { method: string }).method)).toEqual(['open'])

    // It is not ready yet. This request is not sent.
    const pending = client.listDirectory('file:///tmp')
    await new Promise((done) => setTimeout(done, 5))
    expect(child.requests()).toHaveLength(1)

    child.reply(1, { version: 0 })
    await started
    // After ready resolves, the waiting request flows. **The response is returned only after waiting for it** (if it were returned first, it would be a response to an id not yet registered, and would wait forever).
    for (let i = 0; i < 50 && child.requests().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    expect(child.requests().map((m) => (m as { method: string }).method)).toEqual([
      'open',
      'fs.listDirectory'
    ])
    child.reply(2, { uri: 'file:///tmp', entries: [], live: false })
    await pending
    await client.stop()
  })

  it('scanSubtree は fs.scanSubtree を 1 通送り、応答を待たせない (項目 246)', async () => {
    children.length = 0
    const { client } = await makeClient()
    const started = client.start()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    child.reply(1, { version: 0 })
    await started

    // No return value (void). It does not make the SessionManager creation path wait.
    expect(client.scanSubtree('/Users/tester/work/new-repo')).toBeUndefined()
    let req: { id: number; method: string; params: unknown } | undefined
    for (let i = 0; i < 50 && req === undefined; i += 1) {
      req = child
        .requests()
        .find((m) => (m as { method: string }).method === 'fs.scanSubtree') as typeof req
      if (req === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (req === undefined) throw new Error('fs.scanSubtree was not sent')
    expect(req.params).toEqual({ path: '/Users/tester/work/new-repo' })
    child.reply(req.id, { state: 'skipped', reason: 'outside' })
    await client.stop()
  })

  it('転写の在りかが古ければ (stale) そのファイルを 1 回だけ取り込み直す (項目 78)', async () => {
    children.length = 0
    const locators: unknown[] = []
    const reads: string[] = []
    const feed: TranscriptFeed = {
      listFiles: async () => [],
      readMessages: async (fileId) => {
        reads.push(fileId)
        return {
          id: fileId,
          uri: `transcript://${fileId}`,
          version: '200:900',
          sessionId: null,
          messages: [
            { id: 'm1', role: 'user', text: '本文', ts: 1, sessionId: 's', offset: 5, length: 40 }
          ]
        }
      },
      readMessageText: async (_fileId, messageId, locator) => {
        locators.push(locator)
        return { text: `本文 ${messageId}`, stale: locator === null, missing: false }
      }
    }
    const { client } = await makeClient(feed)
    const started = client.start()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    child.reply(1, { version: 0 })
    await started

    // A reverse request from the index process. A locator that is absent is not imported again.
    child.emit('message', {
      kind: 'req',
      id: 100,
      method: 'transcript.readMessageText',
      params: { fileId: 'p/a.jsonl', messageId: 'm1', locator: { offset: 5, length: 40, version: '1:2' } }
    } satisfies IndexRpcMessage)
    // Three entries with no locator in the same file = one re-import. A broken locator falls to null.
    for (const [id, locator] of [[101, undefined], [102, { offset: 'x' }], [103, null]] as const) {
      child.emit('message', {
        kind: 'req',
        id,
        method: 'transcript.readMessageText',
        params: { fileId: 'p/b.jsonl', messageId: 'm1', locator }
      } satisfies IndexRpcMessage)
    }
    const transcriptWrites = (): IndexRpcMessage[] =>
      child.requests().filter((m) => (m as { method: string }).method === 'index.transcriptMessages')
    for (let i = 0; i < 50 && transcriptWrites().length < 1; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    const responses = child.posted.filter((m) => m.kind === 'res')
    expect(responses.map((m) => (m as { result: unknown }).result)).toEqual([
      '本文 m1',
      '本文 m1',
      '本文 m1',
      '本文 m1'
    ])
    expect(locators).toEqual([{ offset: 5, length: 40, version: '1:2' }, null, null, null])
    expect(reads).toEqual(['p/b.jsonl'])
    expect(transcriptWrites()).toHaveLength(1)
    // The version recorded is the version of the fd that was read (the return of `readMessages`).
    expect((transcriptWrites()[0] as { params: unknown }).params).toMatchObject({
      file: { id: 'p/b.jsonl', version: '200:900' },
      messages: [{ id: 'm1', offset: 5, length: 40 }]
    })
    const write = transcriptWrites()[0] as { id: number }
    child.reply(write.id, 1)
    await client.stop()
  })

  it('indexTranscripts は一覧に無い (消えた) ファイルの行を索引から落とす (項目 241)', async () => {
    children.length = 0
    const feed: TranscriptFeed = {
      // Only a.jsonl actually exists now. b.jsonl is assumed to be deleted (it does not appear in listFiles).
      listFiles: async () => [{ id: 'a.jsonl', uri: 'transcript://a.jsonl', version: '1:1', mtimeMs: 1 }],
      readMessages: async (fileId) => ({
        id: fileId,
        uri: `transcript://${fileId}`,
        version: '1:1',
        sessionId: null,
        messages: []
      }),
      readMessageText: async () => ({ text: null, stale: false, missing: false })
    }
    const { client } = await makeClient(feed)
    const started = client.start()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    child.reply(1, { version: 0 })
    await started

    const done = client.indexTranscripts()

    // Answers the import of a.jsonl itself (its contents are empty). Without answering it, the sequential `indexTranscripts` does not advance until the next `index.listTranscriptFileIds`.
    let writeReq: { id: number } | undefined
    for (let i = 0; i < 50 && writeReq === undefined; i += 1) {
      writeReq = child
        .requests()
        .find((m) => (m as { method: string }).method === 'index.transcriptMessages') as
        | { id: number }
        | undefined
      if (writeReq === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (writeReq === undefined) throw new Error('index.transcriptMessages was not sent')
    child.reply(writeReq.id, 0)

    // `index.listTranscriptFileIds` answers that both a.jsonl and b.jsonl are in the index now.
    let listReq: { id: number } | undefined
    for (let i = 0; i < 50 && listReq === undefined; i += 1) {
      listReq = child
        .requests()
        .find((m) => (m as { method: string }).method === 'index.listTranscriptFileIds') as
        | { id: number }
        | undefined
      if (listReq === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (listReq === undefined) throw new Error('index.listTranscriptFileIds was not sent')
    child.reply(listReq.id, ['a.jsonl', 'b.jsonl'])

    let removeReq: { id: number; params: unknown } | undefined
    for (let i = 0; i < 50 && removeReq === undefined; i += 1) {
      removeReq = child
        .requests()
        .find((m) => (m as { method: string }).method === 'index.removeTranscript') as
        | { id: number; params: unknown }
        | undefined
      if (removeReq === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (removeReq === undefined) throw new Error('index.removeTranscript was not sent')
    // Does not drop the a.jsonl that exists; drops only the deleted b.jsonl.
    expect(removeReq.params).toEqual({ fileId: 'b.jsonl' })
    child.reply(removeReq.id, 7)

    expect(await done).toBe(0)
    await client.stop()
  })

  it('子が落ちたら未応答は IndexProcessCrashed で reject され、もう一度 fork する', async () => {
    children.length = 0
    const { client } = await makeClient()
    const started = client.start()
    const first = children[0] as FakeChild
    first.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    first.reply(1, { version: 0 })
    await started

    const inFlight = client.search('x', 'files')
    for (let i = 0; i < 50 && first.requests().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    expect(first.requests()).toHaveLength(2)
    first.emit('exit', 1)
    await expect(inFlight).rejects.toThrow(/exited/)
    await expect(inFlight).rejects.toMatchObject({ name: INDEX_PROCESS_CRASHED })
    expect(client.getStatus().state).toBe('starting')

    // The second child is started after a backoff of 1 s, and it starts again from `open` (3.7).
    await new Promise((done) => setTimeout(done, 1200))
    expect(children).toHaveLength(2)
    const second = children[1] as FakeChild
    second.emit('spawn')
    for (let i = 0; i < 50 && second.requests().length < 1; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    expect((second.requests()[0] as { method: string }).method).toBe('open')
    second.reply(1, { version: 0 })
    // The resume position is held by `documents.index_state`, so it only starts the scan and build afresh.
    for (let i = 0; i < 50 && second.requests().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    expect((second.requests()[1] as { method: string }).method).toBe('start')
    await client.stop()
    expect(second.killed).toBe(true)
  }, 10_000)

  /** A client that has finished `open`, and the first fake child. */
  const startClient = async (
    options: Parameters<typeof makeClient>[1] = {}
  ): Promise<{ client: Awaited<ReturnType<typeof makeClient>>['client']; child: FakeChild }> => {
    children.length = 0
    const { client } = await makeClient(null, options)
    const started = client.start()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    child.reply(1, { version: 0 })
    await started
    return { client, child }
  }

  const waitForRequests = async (child: FakeChild, count: number): Promise<void> => {
    for (let i = 0; i < 50 && child.requests().length < count; i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
  }

  it('上限を過ぎた検索は index-busy で reject され、遅れた応答は捨てられる (項目 87)', async () => {
    const { client, child } = await startClient({ timeouts: { 'index.search': 30 } })

    const slow = client.search('x', 'files')
    await waitForRequests(child, 2)
    const err = await slow.catch((e: unknown) => e)
    expect(err).toMatchObject({ name: INDEX_PROCESS_BUSY })
    // The renderer receives only the message. It must be possible to pick it up again as a reason code.
    expect(parseReason((err as Error).message)).toEqual({ code: 'index-busy', params: { seconds: 1 } })

    // Even if the late response arrives after the jam clears, nothing happens (the next request round-trips as usual).
    const late = child.requests()[1] as { id: number }
    child.reply(late.id, { hits: [], tookMs: 1 })
    const next = client.search('y', 'files')
    await waitForRequests(child, 3)
    const third = child.requests()[2] as { id: number }
    child.reply(third.id, { hits: [], tookMs: 2 })
    await expect(next).resolves.toMatchObject({ tookMs: 2 })
    await client.stop()
  })

  it('上限の無い method (走査) は待ち続ける', async () => {
    const { client, child } = await startClient({ timeouts: { 'index.search': 30 } })
    let settled = false
    const rescan = client.rescan().finally(() => {
      settled = true
    })
    await waitForRequests(child, 2)
    await new Promise((done) => setTimeout(done, 80))
    expect(settled).toBe(false)
    child.reply((child.requests()[1] as { id: number }).id, null)
    await rescan
    await client.stop()
  })

  it('落ちたら走査の状態を idle に戻す (古い scanning + 件数を残さない、項目 87)', async () => {
    const statuses: ScanStatus[] = []
    const { client, child } = await startClient({ onScanStatus: (status) => statuses.push(status) })
    child.emit('message', {
      kind: 'ntf',
      event: 'scanStatus',
      payload: {
        state: 'scanning',
        seen: 1234,
        indexed: 1000,
        excluded: 3,
        denied: 1,
        deniedExamples: [],
        startedAt: 1,
        finishedAt: null,
        message: null,
        lastFullScanAt: 42,
        skipped: false,
        nextFullScanAt: 99,
        tccDeferredUntil: null
      } satisfies ScanStatus
    } satisfies IndexRpcMessage)
    expect(client.getScanStatus().state).toBe('scanning')

    child.emit('exit', 1)
    const status = client.getScanStatus()
    expect(status).toMatchObject({ state: 'idle', seen: 0, indexed: 0, startedAt: null })
    // Keep the values from the DB (the last full run and the next schedule).
    expect(status).toMatchObject({ lastFullScanAt: 42, nextFullScanAt: 99 })
    expect(statuses.at(-1)).toBe(status)
    await client.stop()
  })

  /** The list of method names that were sent. */
  const methods = (child: FakeChild): string[] =>
    child.requests().map((m) => (m as { method: string }).method)

  const waitUntil = async (cond: () => boolean, tries = 100): Promise<void> => {
    for (let i = 0; i < tries && !cond(); i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
  }

  it('TODO 854 / 第 42 波 code-review: open が上限より遅れても子は殺さず、遅れて返ったら ready になる (走査は 1 回だけ)', async () => {
    children.length = 0
    const { client } = await makeClient(null, { readyTimeoutMs: 100 })
    const started = client.start()
    // As with bootstrap, the scan is asked for without waiting for ready.
    void client.startScanning()
    let ingested = false
    const waiting = client.whenReady().then(() => {
      ingested = true
    })
    const first = children[0] as FakeChild
    first.emit('spawn')
    // Does not answer `open`. Returns false without throwing (bootstrap is not stopped).
    await expect(started).resolves.toBe(false)
    expect(first.killed).toBe(false)
    expect(ingested).toBe(false)
    // Even past the limit, no restart is scheduled (an open that takes 20 seconds is killed each time and does not reach giving up).
    await new Promise((done) => setTimeout(done, 1300))
    expect(children).toHaveLength(1)
    expect(first.killed).toBe(false)
    // The open returns late.
    first.reply(1, { version: 0 })
    await waiting
    expect(ingested).toBe(true)
    await waitUntil(() => first.requests().length >= 2)
    await new Promise((done) => setTimeout(done, 20))
    expect(methods(first)).toEqual(['open', 'start'])
    // Asking again does not send to the same child.
    await client.startScanning()
    expect(methods(first)).toEqual(['open', 'start'])
    await client.stop()
  }, 10_000)

  it('TODO 854: spawn の直後に落ちても start は投げず、再起動した子で ready になる', async () => {
    children.length = 0
    const { client } = await makeClient()
    const started = client.start()
    const first = children[0] as FakeChild
    first.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    first.emit('exit', 1)
    await expect(started).resolves.toBe(false)
    expect(client.getStatus().state).toBe('starting')
    // A scan asked for after a crash is sent once the next child is ready.
    await client.startScanning()
    const ready = client.whenReady()

    await new Promise((done) => setTimeout(done, 1200))
    expect(children).toHaveLength(2)
    const second = children[1] as FakeChild
    second.emit('spawn')
    await waitUntil(() => second.requests().length >= 1)
    second.reply(1, { version: 0 })
    await ready
    await waitUntil(() => second.requests().length >= 2)
    expect(methods(second)).toEqual(['open', 'start'])
    // A request after ready round-trips as usual.
    const listing = client.listDirectory('file:///tmp')
    await waitUntil(() => second.requests().length >= 3)
    second.reply((second.requests()[2] as { id: number }).id, { uri: 'file:///tmp', entries: [], live: false })
    await expect(listing).resolves.toMatchObject({ uri: 'file:///tmp' })
    await client.stop()
    await expect(client.whenReady()).rejects.toThrow(/stopping/)
  }, 10_000)

  it('TODO 926: 子が spawn を出さずに終わっても、ready を待っていた要求は reject される', async () => {
    children.length = 0
    const { client } = await makeClient()
    const started = client.start()
    const first = children[0] as FakeChild
    // The IPC for search and listing right after startup waits for that child to be ready.
    const listing = client.listDirectory('file:///tmp')
    const search = client.listDirectory('file:///var')
    await new Promise((done) => setTimeout(done, 0))
    first.emit('exit', 1)
    await expect(started).resolves.toBe(false)
    await expect(listing).rejects.toThrow(/exited/)
    await expect(search).rejects.toThrow(/exited/)
    await client.stop()
  }, 10_000)

  it('TODO 926: spawn の前に stop すると、ready を待っていた要求は reject される', async () => {
    children.length = 0
    const { client } = await makeClient()
    void client.start()
    const listing = client.listDirectory('file:///tmp')
    await new Promise((done) => setTimeout(done, 0))
    const stopping = client.stop()
    await expect(listing).rejects.toThrow(/stopping/)
    await stopping
  }, 20_000)

  it('TODO 860: 起動前に頼んだ「消す」知らせは積まれ、open の直後に他より先に流れる', async () => {
    children.length = 0
    const { client } = await makeClient()
    // SessionManager.start (applyRetention) runs before the index process does.
    client.pruneConversations([
      { threadId: 'td', before: 5000 },
      { threadId: 'tn', before: null }
    ])
    client.removeThread('tv')
    const started = client.start()
    void client.startScanning()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    expect(methods(child)).toEqual(['open'])
    child.reply(1, { version: 0 })
    await started
    await waitUntil(() => child.requests().length >= 5)
    expect(methods(child)).toEqual([
      'open',
      'index.removeThread',
      'index.pruneConversations',
      'index.removeThread',
      'start'
    ])
    const params = child.requests().slice(1, 4).map((m) => (m as { params: unknown }).params)
    expect(params).toEqual([
      { threadId: 'tn' },
      { items: [{ threadId: 'td', before: 5000 }] },
      { threadId: 'tv' }
    ])
    await client.stop()
  })

  it('TODO 860: 再起動の待ちの間の removeThread と、落ちて届かなかった分は、次の子に送り直す', async () => {
    const { client, child: first } = await startClient()
    client.removeThread('t-inflight')
    await waitUntil(() => first.requests().length >= 2)
    expect(methods(first)).toEqual(['open', 'index.removeThread'])
    // Crashed before answering: since it is not known whether it arrived, it is queued again.
    first.emit('exit', 1)
    await new Promise((done) => setTimeout(done, 0))
    // What was asked for while waiting to restart (with `ready` still rejected). Before, it failed at once here and was lost.
    client.removeThread('t-waiting')

    await waitUntil(() => children.length >= 2, 400)
    const second = children[1] as FakeChild
    second.emit('spawn')
    await waitUntil(() => second.requests().length >= 1)
    second.reply(1, { version: 0 })
    await waitUntil(() => second.requests().length >= 4)
    expect(methods(second).slice(0, 3)).toEqual(['open', 'index.removeThread', 'index.removeThread'])
    expect(
      second
        .requests()
        .slice(1, 3)
        .map((m) => (m as { params: { threadId: string } }).params.threadId)
        .sort()
    ).toEqual(['t-inflight', 't-waiting'])
    // Resuming the scan and build comes after the removal notice.
    expect(methods(second).slice(3)).toContain('start')
    await client.stop()
  }, 10_000)

  it('TODO 863: 起動時の掃除は、索引に会話の文書があって生きていないスレッドに removeThread を送る', async () => {
    const { client, child } = await startClient()
    let asked = 0
    const sweep = client.sweepGoneConversationThreads(() => {
      asked += 1
      return new Set(['alive'])
    })
    await waitForRequests(child, 2)
    expect(methods(child)).toEqual(['open', 'index.listConversationThreadIds'])
    // Whether it is alive is read after the listing is received (so that a restore or deletion in between is not mixed up).
    expect(asked).toBe(0)
    child.reply((child.requests()[1] as { id: number }).id, ['alive', 'gone-soft', 'gone-purged'])
    await expect(sweep).resolves.toBe(2)
    expect(asked).toBe(1)
    await waitForRequests(child, 4)
    expect(methods(child).slice(2)).toEqual(['index.removeThread', 'index.removeThread'])
    expect(
      child
        .requests()
        .slice(2)
        .map((m) => (m as { params: { threadId: string } }).params.threadId)
    ).toEqual(['gone-soft', 'gone-purged'])
    // If it has entered the end (unreadable = null), send nothing.
    const quiet = client.sweepGoneConversationThreads(() => null)
    await waitForRequests(child, 5)
    child.reply((child.requests()[4] as { id: number }).id, ['gone-again'])
    await expect(quiet).resolves.toBe(0)
    await new Promise((done) => setTimeout(done, 10))
    expect(methods(child)).toHaveLength(5)
    await client.stop()
  })

  const event = (threadId: string, id: string) => ({ id, threadId, title: 't', ts: 1 })

  it('TODO 875: 掃除の一覧の応答を待つ間に復元したスレッドは消さない', async () => {
    const { client, child } = await startClient()
    const live = new Set(['alive'])
    const sweep = client.sweepGoneConversationThreads(() => live)
    await waitForRequests(child, 2)
    // Restored before the listing response (deleted_at returns, and the re-creation is queued).
    live.add('restored')
    client.indexConversationEvents([event('restored', 'e1')])
    child.reply((child.requests()[1] as { id: number }).id, ['alive', 'restored', 'gone'])
    await expect(sweep).resolves.toBe(1)
    await waitForRequests(child, 4)
    const sent = child.requests().slice(2) as { method: string; params: { threadId?: string } }[]
    expect(sent.map((m) => m.method).sort()).toEqual(['index.conversationEvents', 'index.removeThread'])
    expect(sent.find((m) => m.method === 'index.removeThread')?.params.threadId).toBe('gone')
    await client.stop()
  })

  it('TODO 875: 掃除が消すと決めた後の復元の作り直しは、消す知らせより後に並ぶ', async () => {
    const { client, child } = await startClient()
    const sweep = client.sweepGoneConversationThreads(() => new Set())
    await waitForRequests(child, 2)
    child.reply((child.requests()[1] as { id: number }).id, ['t'])
    await expect(sweep).resolves.toBe(1)
    // Restored right after reading whether the sweep is alive.
    client.indexConversationEvents([event('t', 'e1')])
    await waitForRequests(child, 4)
    expect(methods(child).slice(2)).toEqual(['index.removeThread', 'index.conversationEvents'])
    await client.stop()
  })

  it('TODO 875: 起動前に消して復元したスレッドの作り直しは、消す知らせの後に流れる', async () => {
    children.length = 0
    const { client } = await makeClient()
    client.removeThread('t')
    client.indexConversationEvents([event('t', 'e1')])
    const started = client.start()
    const child = children[0] as FakeChild
    child.emit('spawn')
    await new Promise((done) => setTimeout(done, 0))
    child.reply(1, { version: 0 })
    await started
    await waitForRequests(child, 3)
    expect(methods(child)).toEqual(['open', 'index.removeThread', 'index.conversationEvents'])
    await client.stop()
  })

  it('TODO 875: 再起動の待ちの間に消して復元したスレッドの作り直しは、落とさず消す知らせの後に流す', async () => {
    const { client, child: first } = await startClient()
    first.emit('exit', 1)
    await new Promise((done) => setTimeout(done, 0))
    // While waiting for a restart (`ready` still rejected): removal, then the re-creation of the restore. Before, only the re-creation failed at once and was dropped, and a later removal emptied the index of the restored thread.
    client.removeThread('t')
    client.indexConversationEvents([event('t', 'e1')])
    // A re-creation queued before a removal of all entries is discarded (if the removal of all comes later, it is removed anyway).
    client.indexConversationEvents([event('u', 'e2')])
    client.removeAllConversations()
    client.indexConversationEvents([event('v', 'e3')])

    await waitUntil(() => children.length >= 2, 400)
    const second = children[1] as FakeChild
    second.emit('spawn')
    await waitUntil(() => second.requests().length >= 1)
    second.reply(1, { version: 0 })
    await waitUntil(() => second.requests().length >= 3)
    const sent = second.requests().slice(1, 3) as { method: string; params: unknown }[]
    expect(sent.map((m) => m.method)).toEqual(['index.removeAllConversations', 'index.conversationEvents'])
    expect(sent[1]?.params).toEqual({ events: [event('v', 'e3')] })
    await client.stop()
  }, 10_000)

  it('TODO 875: 再起動の待ちの間の削除 → 復元は、削除・作り直しの順で次の子に届く', async () => {
    const { client, child: first } = await startClient()
    first.emit('exit', 1)
    await new Promise((done) => setTimeout(done, 0))
    client.removeThread('t')
    client.indexConversationEvents([event('t', 'e1')])
    await waitUntil(() => children.length >= 2, 400)
    const second = children[1] as FakeChild
    second.emit('spawn')
    await waitUntil(() => second.requests().length >= 1)
    second.reply(1, { version: 0 })
    await waitUntil(() => second.requests().length >= 3)
    expect(methods(second).slice(0, 3)).toEqual(['open', 'index.removeThread', 'index.conversationEvents'])
    await client.stop()
  }, 10_000)

  it('TODO 875: 送った投入が応答の前に落ちたら、消す知らせと送った順のまま次の子に送り直す', async () => {
    const { client, child: first } = await startClient()
    client.removeThread('t')
    client.indexConversationEvents([event('t', 'e1')])
    await waitForRequests(first, 3)
    expect(methods(first).slice(1)).toEqual(['index.removeThread', 'index.conversationEvents'])
    first.emit('exit', 1)
    await waitUntil(() => children.length >= 2, 400)
    const second = children[1] as FakeChild
    second.emit('spawn')
    await waitUntil(() => second.requests().length >= 1)
    second.reply(1, { version: 0 })
    await waitUntil(() => second.requests().length >= 3)
    expect(methods(second).slice(0, 3)).toEqual(['open', 'index.removeThread', 'index.conversationEvents'])
    await client.stop()
  }, 10_000)

  it('TODO 875: 生きた子が投入に error を返したら送り直さない', async () => {
    const { client, child } = await startClient()
    client.indexConversationEvents([event('t', 'e1')])
    await waitForRequests(child, 2)
    child.emit('message', {
      kind: 'res',
      id: (child.requests()[1] as { id: number }).id,
      ok: false,
      error: { name: 'Error', message: 'boom' }
    } satisfies IndexRpcMessage)
    await new Promise((done) => setTimeout(done, 5))
    client.removeThread('x')
    await waitForRequests(child, 3)
    expect(methods(child).slice(1)).toEqual(['index.conversationEvents', 'index.removeThread'])
    await client.stop()
  })

  it('TODO 863: 逆向きの conversation.liveEventIds に答える (正本の口が無ければ全部在ると答える)', async () => {
    const { client, child } = await startClient()
    child.emit('message', {
      kind: 'req',
      id: 9001,
      method: 'conversation.liveEventIds',
      params: { eventIds: ['a', 7, 'b'] }
    } satisfies IndexRpcMessage)
    for (let i = 0; i < 50 && !child.posted.some((m) => m.kind === 'res' && m.id === 9001); i += 1) {
      await new Promise((done) => setTimeout(done, 5))
    }
    const reply = child.posted.find((m) => m.kind === 'res' && m.id === 9001)
    expect(reply).toMatchObject({ ok: true, result: ['a', 'b'] })
    await client.stop()
  })
})
