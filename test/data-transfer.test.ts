/**
 * Export and import of threads and settings (TODO 1088, ARCHITECTURE 8.6). The model is not called.
 *
 * - Sealing (scrypt -> AES-256-GCM): with the right passphrase it restores; a wrong one fails; a 1-byte tamper (header, body, or tag) fails.
 * - Round trip: export -> import into another DB -> threads and settings come back. The body of `tool_result` is still absent (constraint 10).
 * - Collisions: importing into the same DB adds with new ids and does not change the original threads.
 * - Invalid files: a type violation, a huge file, or an unknown format version is refused, and not a single row is written. Rows of unknown kinds are dropped and counted.
 * - Settings: anything that is not a name in the settings editor, or a value that cannot be used, is dropped (the same checks as `AgentSettings.prepare`).
 * - Scale: a round trip of 10,000 events finishes within 1 second, and the event loop is not blocked for longer than one chunk at a time.
 * - Checks on export: a field over the import limit is fixed; what cannot be fixed is dropped and counted (a file it wrote itself can always be read).
 * - busy reservation and cleanup after a mid-way failure.
 * - OS sandbox (TODO 1109): it comes back on a round trip; OFF if the destination backend does not have it; old exports without the field are OFF; type violations are refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import type { AiosEvent } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { MAGIC, SealError, open, seal, type KdfParams } from '../src/main/data-transfer/crypto.js'
import { checkEvent, EXPORT_FORMAT_NAME, EXPORT_FORMAT_VERSION, LIMITS, rebaseHome } from '../src/main/data-transfer/format.js'
import { DataTransfer, EXPORT_PAGE, IMPORT_CHUNK, checkPassphrase, type DataTransferSettings } from '../src/main/data-transfer/service.js'
import { AGENT_SETTING_NAMES, AgentSettings, type AgentSettingAppliers } from '../src/main/agent-settings.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import type { SettingValues, SettingsSnapshot } from '../src/shared/settings.js'
import type { Translate } from '../src/renderer/src/i18n/index.js'

/** Only the tests run scrypt at a weak setting (2^14). The production entry point uses the default strength. */
const FAST_KDF: KdfParams = { N: 2 ** 14, r: 8, p: 1 }
const PASS = 'correct horse battery'

describe('checkEvent', () => {
  it('skill_loaded (TODO 1105) は uri があれば通る', () => {
    expect(checkEvent({ kind: 'skill_loaded', actor: 'main', ts: 1_700_000_000_000, payload: { uri: 'file:///a/SKILL.md' } }).ok).toBe(true)
    expect(checkEvent({ kind: 'skill_loaded', actor: 'main', ts: 1_700_000_000_000, payload: {} }).ok).toBe(false)
  })
})

describe('封 (crypto.ts)', () => {
  const plain = Buffer.from(JSON.stringify({ hello: 'こんにちは', n: 1 }), 'utf8')

  it('正しいパスフレーズで元に戻る。先頭は印で、中身の平文は現れない', async () => {
    const sealed = await seal(plain, PASS, FAST_KDF)
    expect(sealed.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true)
    expect(sealed.includes(Buffer.from('hello'))).toBe(false)
    expect((await open(sealed, PASS)).equals(plain)).toBe(true)
  })

  it('本番の強さ (DEFAULT_KDF、128 MiB) でも往復でき、読み込みの上限に収まる', async () => {
    const sealed = await seal(plain, PASS)
    expect((await open(sealed, PASS)).equals(plain)).toBe(true)
  })

  it('NFC と NFD のパスフレーズは同じ鍵になる', async () => {
    const sealed = await seal(plain, 'パスワード'.normalize('NFD'), FAST_KDF)
    expect((await open(sealed, 'パスワード'.normalize('NFC'))).equals(plain)).toBe(true)
  })

  it('違うパスフレーズは decrypt-failed', async () => {
    const sealed = await seal(plain, PASS, FAST_KDF)
    await expect(open(sealed, 'wrong passphrase')).rejects.toMatchObject({ reason: 'decrypt-failed' })
  })

  it('本文・タグ・ヘッダのどれを 1 バイト変えても読めない', async () => {
    const sealed = await seal(plain, PASS, FAST_KDF)
    const headerEnd = MAGIC.length + 4 + sealed.readUInt32BE(MAGIC.length)
    for (const at of [headerEnd + 1, sealed.length - 1]) {
      const tampered = Buffer.from(sealed)
      tampered[at] = tampered[at]! ^ 0x01
      await expect(open(tampered, PASS)).rejects.toMatchObject({ reason: 'decrypt-failed' })
    }
    // Rewrites the IV in the header (it is in the AAD, so the tag fails).
    const header = JSON.parse(sealed.subarray(MAGIC.length + 4, headerEnd).toString('utf8'))
    const iv = Buffer.from(header.cipher.iv, 'base64')
    iv[0] = iv[0]! ^ 0x01
    header.cipher.iv = iv.toString('base64')
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(headerBytes.length)
    const forged = Buffer.concat([MAGIC, length, headerBytes, sealed.subarray(headerEnd)])
    await expect(open(forged, PASS)).rejects.toMatchObject({ reason: 'decrypt-failed' })
  })

  it('印が違う・短すぎる・新しい封の版・強すぎる scrypt を断る', async () => {
    await expect(open(Buffer.from('SQLite format 3\0'), PASS)).rejects.toMatchObject({ reason: 'not-export-file' })
    await expect(open(Buffer.alloc(3), PASS)).rejects.toMatchObject({ reason: 'not-export-file' })
    const build = (header: unknown): Buffer => {
      const bytes = Buffer.from(JSON.stringify(header), 'utf8')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      return Buffer.concat([MAGIC, length, bytes, Buffer.alloc(32)])
    }
    const salt = Buffer.alloc(16).toString('base64')
    const iv = Buffer.alloc(12).toString('base64')
    const base = { container: 1, kdf: { name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt }, cipher: { name: 'aes-256-gcm', iv }, compression: 'gzip' }
    await expect(open(build({ ...base, container: 2 }), PASS)).rejects.toMatchObject({ reason: 'too-new' })
    // scrypt that needs 1 GiB of memory is refused at the header stage (so a file from outside cannot make it use resources).
    await expect(open(build({ ...base, kdf: { ...base.kdf, N: 2 ** 20 } }), PASS)).rejects.toMatchObject({
      reason: 'not-export-file'
    })
    await expect(open(build({ ...base, kdf: { ...base.kdf, N: 1000 } }), PASS)).rejects.toBeInstanceOf(SealError)
  })
})

describe('パスフレーズの検め', () => {
  it('書き出しは 8 文字以上、読み込みは空でなければよい (空は passphrase-empty)。長すぎるものは断る', () => {
    expect(checkPassphrase('short', true)).toEqual({ ok: false, reason: 'passphrase-short' })
    expect(checkPassphrase('short', false)).toEqual({ ok: true, value: 'short' })
    expect(checkPassphrase('', false)).toEqual({ ok: false, reason: 'passphrase-empty' })
    expect(checkPassphrase('', true)).toEqual({ ok: false, reason: 'passphrase-short' })
    expect(checkPassphrase(42, false)).toEqual({ ok: false, reason: 'passphrase-empty' })
    expect(checkPassphrase('x'.repeat(1025), true)).toEqual({ ok: false, reason: 'passphrase-long' })
  })
})

describe('ホームの付け替え', () => {
  it('書いた側のホームの下だけを替える', () => {
    expect(rebaseHome('/Users/a/git/x', '/Users/a', '/Users/b')).toBe('/Users/b/git/x')
    expect(rebaseHome('/Users/a', '/Users/a', '/Users/b')).toBe('/Users/b')
    expect(rebaseHome('/Users/ab/git', '/Users/a', '/Users/b')).toBe('/Users/ab/git')
    expect(rebaseHome('/tmp/x', '/Users/a', '/Users/b')).toBe('/tmp/x')
  })
})

// ---------------------------------------------------------------------------
// Round trip (real ThreadStore + in-memory DB)
// ---------------------------------------------------------------------------

function openDb(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function event(threadId: string, partial: Pick<AiosEvent, 'kind' | 'payload'> & Partial<AiosEvent>): AiosEvent {
  return { id: randomUUID(), sessionId: 's-1', threadId, ts: 1_700_000_000_000, actor: 'main', ...partial } as AiosEvent
}

/** A fake settings object that goes through the same checks as the settings editor (`AgentSettings.prepare`). The setter only rewrites the value. */
function fakeSettings(initial: Partial<SettingValues> = {}): {
  port: DataTransferSettings
  values: Record<string, unknown>
} {
  const values: Record<string, unknown> = { ...settingDefaults(), ...initial }
  const apply = Object.fromEntries(
    AGENT_SETTING_NAMES.map((name) => [name, (value: unknown) => void (values[name] = value)])
  ) as unknown as AgentSettingAppliers
  const agent = new AgentSettings({
    snapshot: (): SettingsSnapshot => ({ values: { ...(values as unknown as SettingValues) }, defaults: settingDefaults() }),
    apply
  })
  return {
    values,
    port: {
      values: () => Object.fromEntries(agent.list().settings.map((entry) => [entry.name, entry.value])),
      apply: (name, value) => {
        const prepared = agent.prepare(name, value)
        if (!prepared.ok) return 'invalid'
        if (prepared.value.unchanged) return 'unchanged'
        agent.commit(prepared.value)
        return 'applied'
      }
    }
  }
}

interface Harness {
  db: Db
  store: ThreadStore
  transfer: DataTransfer
  files: Map<string, Uint8Array>
  imported: string[][]
  settings: ReturnType<typeof fakeSettings>
  /** A backend that has `os-sandbox` (TODO 1109). The tests rewrite it. */
  sandboxBackends: Set<string>
}

function harness(home: string, settingsInit: Partial<SettingValues> = {}, files = new Map<string, Uint8Array>()): Harness {
  const db = openDb()
  const store = new ThreadStore(db, home)
  const imported: string[][] = []
  const settings = fakeSettings(settingsInit)
  const sandboxBackends = new Set(['agent-cli'])
  const transfer = new DataTransfer({
    store,
    settings: settings.port,
    dbUserVersion: db.pragma('user_version', { simple: true }) as number,
    appVersion: '0.64.0',
    home,
    newId: () => randomUUID(),
    readFile: async (path) => {
      const data = files.get(path)
      if (data === undefined) throw new Error('ENOENT')
      return data
    },
    fileSize: async (path) => files.get(path)?.length ?? 0,
    writeFile: async (path, data) => void files.set(path, data),
    afterImport: (ids) => void imported.push([...ids]),
    supportsOsSandbox: (backend) => sandboxBackends.has(backend),
    kdf: FAST_KDF
  })
  return { db, store, transfer, files, imported, settings, sandboxBackends }
}

let a: Harness
let b: Harness

beforeEach(() => {
  a = harness('/Users/alice', { theme: 'dark', notifyEnabled: false })
  b = harness('/Users/bob', {}, a.files)
})

afterEach(() => {
  a.db.close()
  b.db.close()
})

function seedThread(h: Harness, id = 'thread-a'): void {
  const thread = h.store.createThread({
    id,
    title: '移行のテスト',
    cwd: '/Users/alice/git/project',
    allowedDirs: ['/Users/alice/git/project', '/opt/shared'],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: 'model-x',
    thinking: 'high'
  })
  h.store.appendEvents(thread, 's-1', [
    event(id, { kind: 'user_text', payload: { text: 'こんにちは' } }),
    event(id, {
      kind: 'tool_use',
      payload: { toolUseId: 'tu-1', name: 'Read', summary: 'README.md', input: { file_path: '/x' }, truncated: false }
    } as never),
    // Even if passed with a body, the save gate (`toPersistable`) reduces it to length and success/failure only.
    event(id, {
      kind: 'tool_result',
      payload: { toolUseId: 'tu-1', ok: true, bytes: 12, content: 'SECRET FILE BODY' }
    } as never),
    event(id, { kind: 'assistant_text', payload: { text: '読みました' } })
  ])
}

describe('往復 (DataTransfer)', () => {
  it('A で書き出したファイルを B で読み込むと、スレッドと設定が戻る。tool_result の本文は無いまま', async () => {
    seedThread(a)
    const exported = await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    expect(exported).toMatchObject({ kind: 'done', fileName: 'out.aiosdata', threads: 1, events: 4 })
    const file = a.files.get('/tmp/out.aiosdata')!
    // Without the passphrase the contents cannot be read (no plaintext word appears).
    expect(Buffer.from(file).includes(Buffer.from('移行のテスト'))).toBe(false)

    const result = await b.transfer.importFrom('/tmp/out.aiosdata', PASS)
    expect(result).toMatchObject({ kind: 'done', threads: 1, events: 4, skippedEvents: 0 })
    const threads = b.store.listThreads()
    expect(threads).toHaveLength(1)
    const thread = threads[0]!
    expect(thread.id).not.toBe('thread-a')
    expect(thread.title).toBe('移行のテスト')
    // Paths under home are rebased to B's home. Paths outside are kept as they are.
    expect(thread.cwdUri).toBe('file:///Users/bob/git/project')
    expect(thread.allowedDirUris).toEqual(['file:///Users/bob/git/project', 'file:///opt/shared'])
    expect(thread.modelId).toBe('model-x')
    expect(thread.thinking).toBe('high')
    const timeline = b.store.readTimeline(thread.id)
    expect(timeline.map((e) => e.kind)).toEqual(['user_text', 'tool_use', 'tool_result', 'assistant_text'])
    expect(timeline[2]!.payload).toEqual({ toolUseId: 'tu-1', ok: true, bytes: 12 })
    const raw = b.db.prepare(`SELECT payload FROM thread_events WHERE thread_id = ?`).all(thread.id) as { payload: string }[]
    expect(raw.some((row) => row.payload.includes('SECRET FILE BODY'))).toBe(false)
    // The list preview is also rebuilt.
    expect(b.store.listThreadRecords()[0]!.preview).toBe('読みました')
    // The settings are the values at the time of export.
    expect(result).toMatchObject({ settings: 2 })
    expect(b.settings.values.theme).toBe('dark')
    expect(b.settings.values.notifyEnabled).toBe(false)
    // Notice to the list and the index.
    expect(b.imported).toEqual([[thread.id]])
  })

  it('同じ DB に読み込むと新しい id のスレッドとして足し、元のスレッドは変えない (2 回読めば 2 本)', async () => {
    seedThread(a)
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    const before = a.store.readTimeline('thread-a')
    await a.transfer.importFrom('/tmp/out.aiosdata', PASS)
    await a.transfer.importFrom('/tmp/out.aiosdata', PASS)
    const ids = a.store.listThreads().map((t) => t.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(a.store.readTimeline('thread-a')).toEqual(before)
    // The event id is also new (does not overwrite an id that is unique across the whole table).
    const count = a.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
    expect(count.n).toBe(12)
  })

  it('保存しないスレッド (retention none) と消したスレッドは書き出さない', async () => {
    seedThread(a, 'kept')
    seedThread(a, 'gone')
    a.store.removeThread('gone')
    a.store.createThread({
      id: 'ephemeral',
      title: 'x',
      cwd: '/Users/alice',
      allowedDirs: [],
      retention: 'none',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toMatchObject({ threads: 1 })
  })

  it('取り込みでも保存の門を通し直す (redaction が掛かる、tool_result の本文を落とす)', async () => {
    const secret = 'sk-ant-api03-' + 'x'.repeat(40)
    await writePayload('/tmp/crafted.aiosdata', {
      threads: [
        threadJson([
          { kind: 'user_text', actor: 'main', ts: 1, payload: { text: `key ${secret}` } },
          { kind: 'tool_result', actor: 'main', ts: 2, payload: { toolUseId: 't', ok: true, bytes: 3, content: 'BODY' } }
        ])
      ]
    })
    const result = await b.transfer.importFrom('/tmp/crafted.aiosdata', PASS)
    expect(result).toMatchObject({ kind: 'done', threads: 1, events: 2 })
    const raw = b.db.prepare(`SELECT payload FROM thread_events`).all() as { payload: string }[]
    expect(raw.some((row) => row.payload.includes(secret))).toBe(false)
    expect(raw.some((row) => row.payload.includes('BODY'))).toBe(false)
  })

  it('違うパスフレーズでは decrypt-failed で、何も書かない', async () => {
    seedThread(a)
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', 'not the passphrase')).toEqual({
      kind: 'failed',
      reason: 'decrypt-failed'
    })
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
  })

  it('書き出しの短いパスフレーズは書く前に断る', async () => {
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', 'short')).toEqual({ kind: 'failed', reason: 'passphrase-short' })
    expect(a.files.size).toBe(0)
  })

  it('1 万イベントの往復が 1 秒以内に終わり、その間 main の event loop を長く塞がない', async () => {
    const thread = a.store.createThread({
      id: 'big',
      title: 'big',
      cwd: '/Users/alice/git/big',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    const events: AiosEvent[] = []
    for (let i = 0; i < 10_000; i += 1) {
      events.push(event('big', { kind: i % 2 === 0 ? 'user_text' : 'assistant_text', payload: { text: `発言 ${i} ` + 'あ'.repeat(200) } }))
    }
    a.store.appendEvents(thread, 's', events)
    // Measures the longest gap in the event loop (if each thread, page, and chunk yields, one chunk is all that blocks at a time).
    let last = Date.now()
    let longest = 0
    const probe = setInterval(() => {
      const now = Date.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    const started = Date.now()
    try {
      expect(await a.transfer.exportTo('/tmp/big.aiosdata', PASS)).toMatchObject({ events: 10_000 })
      expect(await b.transfer.importFrom('/tmp/big.aiosdata', PASS)).toMatchObject({ events: 10_000 })
    } finally {
      clearInterval(probe)
    }
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1000)
    expect(longest).toBeLessThan(250)
  })
})

// ---------------------------------------------------------------------------
// Invalid files
// ---------------------------------------------------------------------------

function threadJson(events: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 't',
    titleAuto: false,
    cwd: '/Users/alice/x',
    allowedDirs: [],
    retention: 'forever',
    retentionDays: null,
    settingSources: ['user'],
    backend: 'agent-cli',
    modelId: null,
    thinking: null,
    approvalStrict: false,
    createdAt: 1,
    lastEventAt: null,
    turns: 0,
    events,
    ...overrides
  }
}

function payloadJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT_NAME,
    formatVersion: EXPORT_FORMAT_VERSION,
    dbUserVersion: 30,
    appVersion: '0.64.0',
    exportedAt: 1,
    home: '/Users/alice',
    threads: [],
    settings: {},
    ...overrides
  }
}

/** Writes version 2 (JSON lines: a header + one thread per line). With `version: 1`, the whole thing is written as one JSON (old version). */
async function writePayload(path: string, overrides: Record<string, unknown>, version: 1 | 2 = 2): Promise<void> {
  const payload = payloadJson(version === 1 ? { formatVersion: 1, ...overrides } : overrides)
  let text: string
  if (version === 1) {
    text = JSON.stringify(payload)
  } else {
    const { threads, ...head } = payload
    text = [head, ...(threads as unknown[])].map((line) => JSON.stringify(line)).join('\n') + '\n'
  }
  a.files.set(path, await seal(Buffer.from(text, 'utf8'), PASS, FAST_KDF))
}

describe('不正なファイルを断る', () => {
  it('型の違反は invalid-file で、1 本も書かない (正しいスレッドが前にあっても)。何本目・何件目かを添える', async () => {
    const good = threadJson([{ kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'ok' } }])
    const okEvent = { kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'ok' } }
    const cases: [Record<string, unknown>, 1 | 2, unknown][] = [
      [{ threads: [good, threadJson([], { cwd: 'relative/path' })] }, 2, { thread: 2 }],
      [{ threads: [good, threadJson([], { backend: 'Bad Backend' })] }, 2, { thread: 2 }],
      // TODO 1109: osSandbox is either missing the field or just a boolean.
      [{ threads: [good, threadJson([], { osSandbox: 'yes' })] }, 2, { thread: 2 }],
      [{ threads: [good, threadJson([okEvent, { kind: 'user_text', actor: 'main', ts: 1, payload: { text: 42 } }])] }, 2, { thread: 2, event: 2 }],
      [{ threads: [good, threadJson([{ kind: 'tool_use', actor: 'main', ts: 1, payload: { name: 'x' } }])] }, 2, { thread: 2, event: 1 }],
      [{ threads: [good, threadJson([{ kind: 'user_text', actor: 'root', ts: 1, payload: { text: 'x' } }])] }, 2, { thread: 2, event: 1 }],
      // The old version (1) is checked the same way, and the location is attached.
      [{ threads: [good, threadJson([], { title: 'x'.repeat(LIMITS.title + 1) })] }, 1, { thread: 2 }],
      [{ threads: 'not an array' }, 1, undefined],
      [{ settings: [] }, 2, undefined],
      [{ format: 'something-else' }, 2, undefined]
    ]
    for (const [i, [overrides, version, at]] of cases.entries()) {
      await writePayload(`/tmp/bad-${i}.aiosdata`, overrides, version)
      const result = await b.transfer.importFrom(`/tmp/bad-${i}.aiosdata`, PASS)
      expect(result).toEqual(at === undefined ? { kind: 'failed', reason: 'invalid-file' } : { kind: 'failed', reason: 'invalid-file', at })
    }
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
  })

  it('行が JSON でない (途中の 1 行が壊れている) なら、その行の番号を添えて断る', async () => {
    const head = JSON.stringify({ ...payloadJson(), threads: undefined })
    const good = JSON.stringify(threadJson([]))
    a.files.set('/tmp/broken-line.aiosdata', await seal(Buffer.from(`${head}\n${good}\n{not json\n`, 'utf8'), PASS, FAST_KDF))
    expect(await b.transfer.importFrom('/tmp/broken-line.aiosdata', PASS)).toEqual({
      kind: 'failed',
      reason: 'invalid-file',
      at: { thread: 2 }
    })
    expect(b.store.listThreads()).toHaveLength(0)
  })

  it('新しい formatVersion は too-new', async () => {
    await writePayload('/tmp/new.aiosdata', { formatVersion: EXPORT_FORMAT_VERSION + 1 })
    expect(await b.transfer.importFrom('/tmp/new.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'too-new' })
  })

  it('保存の門の後で上限を超える payload の行は捨てて数える。ファイルの大きさの上限を超えるものは too-large', async () => {
    const huge = 'x'.repeat(LIMITS.payloadChars + 10)
    await writePayload('/tmp/huge.aiosdata', {
      threads: [
        threadJson([
          { kind: 'user_text', actor: 'main', ts: 1, payload: { text: huge } },
          { kind: 'user_text', actor: 'main', ts: 2, payload: { text: 'small' } }
        ])
      ]
    })
    expect(await b.transfer.importFrom('/tmp/huge.aiosdata', PASS)).toMatchObject({ kind: 'done', events: 1, skippedEvents: 1 })
    // The file itself is over the limit (refused by size before reading).
    const bigFile = harness('/Users/bob')
    const transfer = new DataTransfer({
      store: bigFile.store,
      settings: bigFile.settings.port,
      dbUserVersion: 1,
      appVersion: '0',
      home: '/Users/bob',
      newId: () => randomUUID(),
      readFile: async () => {
        throw new Error('must not read')
      },
      fileSize: async () => 600 * 1024 * 1024,
      writeFile: async () => undefined,
      afterImport: () => undefined,
      supportsOsSandbox: () => false
    })
    expect(await transfer.importFrom('/tmp/x', PASS)).toEqual({ kind: 'failed', reason: 'too-large' })
    bigFile.db.close()
  })

  it('復号はできても JSON でないものは invalid-file', async () => {
    a.files.set('/tmp/notjson.aiosdata', await seal(Buffer.from('not json'), PASS, FAST_KDF))
    expect(await b.transfer.importFrom('/tmp/notjson.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'invalid-file' })
  })

  it('知らない種別の行は捨てて数える (新しい版の行を古い版が読む)。保存しない種別も書かない', async () => {
    await writePayload('/tmp/kinds.aiosdata', {
      threads: [
        threadJson([
          { kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'a' } },
          { kind: 'future_kind', actor: 'main', ts: 2, payload: { whatever: true } },
          { kind: 'assistant_delta', actor: 'main', ts: 3, payload: { text: 'd' } }
        ])
      ]
    })
    const result = await b.transfer.importFrom('/tmp/kinds.aiosdata', PASS)
    expect(result).toMatchObject({ kind: 'done', threads: 1, events: 1, skippedEvents: 2 })
  })

  it('設定エディタの名前に無い鍵・使えない値は捨てて数え、使える値だけ変える', async () => {
    await writePayload('/tmp/settings.aiosdata', {
      settings: {
        theme: 'light',
        locale: 'klingon',
        'scan.lastFull': '{}',
        'web.trustedCertificates': [],
        notAKey: 1,
        maxConcurrent: 99_999
      }
    })
    const result = await b.transfer.importFrom('/tmp/settings.aiosdata', PASS)
    expect(result).toMatchObject({ kind: 'done', settings: 1, skippedSettings: 5 })
    expect(b.settings.values.theme).toBe('light')
    expect(b.settings.values.locale).toBe(settingDefaults().locale)
  })

  it('古い形式の版 (1、全体が 1 本の JSON) のファイルも読める。版 0 は invalid-file', async () => {
    await writePayload('/tmp/v1.aiosdata', { threads: [threadJson([{ kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'v1' } }])] }, 1)
    expect(await b.transfer.importFrom('/tmp/v1.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 1, events: 1 })
    await writePayload('/tmp/v0.aiosdata', { formatVersion: 0 }, 1)
    expect(await b.transfer.importFrom('/tmp/v0.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'invalid-file' })
  })
})

// ---------------------------------------------------------------------------
// Export goes through the same checks as import (a file it wrote itself can always be read)
// ---------------------------------------------------------------------------

describe('書き出しの検め', () => {
  it('読み込みの上限を超える欄は直して書き出し、そのまま読み込める (長い題・空の model id・多すぎる参照範囲)', async () => {
    seedThread(a)
    const dirs = Array.from({ length: LIMITS.allowedDirs + 100 }, (_, i) => `/Users/alice/d${i}`)
    a.db
      .prepare(`UPDATE threads SET title = ?, model_id = '', allowed_dirs = ? WHERE id = 'thread-a'`)
      .run('題'.repeat(LIMITS.title + 500), JSON.stringify([...dirs, 'relative/x']))
    expect(await a.transfer.exportTo('/tmp/fix.aiosdata', PASS)).toMatchObject({
      kind: 'done',
      threads: 1,
      events: 4,
      skippedThreads: 0,
      skippedEvents: 0
    })
    expect(await b.transfer.importFrom('/tmp/fix.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 1, events: 4 })
    const thread = b.store.listThreads()[0]!
    expect(thread.title).toHaveLength(LIMITS.title)
    expect(thread.modelId).toBeNull()
    expect(thread.allowedDirUris).toHaveLength(LIMITS.allowedDirs)
  })

  it('直せないスレッド (backend の名前が形に合わない) と通らない行・長すぎる payload は書かずに数える', async () => {
    seedThread(a, 'good')
    seedThread(a, 'bad')
    a.db.prepare(`UPDATE threads SET backend = 'Bad Backend' WHERE id = 'bad'`).run()
    // Rows in the DB that do not pass the import checks (type violations in a field) and payloads over the limit.
    a.db.prepare(`UPDATE thread_events SET payload = '{"text":42}' WHERE thread_id = 'good' AND kind = 'user_text'`).run()
    a.db
      .prepare(`UPDATE thread_events SET payload = ? WHERE thread_id = 'good' AND kind = 'assistant_text'`)
      .run(JSON.stringify({ text: 'y'.repeat(LIMITS.payloadChars + 1) }))
    expect(await a.transfer.exportTo('/tmp/skip.aiosdata', PASS)).toMatchObject({
      kind: 'done',
      threads: 1,
      events: 2,
      skippedThreads: 1,
      skippedEvents: 2
    })
    expect(await b.transfer.importFrom('/tmp/skip.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 1, events: 2, skippedEvents: 0 })
    expect(b.store.readTimeline(b.store.listThreads()[0]!.id).map((e) => e.kind)).toEqual(['tool_use', 'tool_result'])
  })

  it('OS の sandbox (TODO 1109) は往復で戻る。宛先のバックエンドが持たなければ OFF で足す', async () => {
    seedThread(a, 'on')
    seedThread(a, 'off')
    a.store.setOsSandbox('on', true)
    expect(await a.transfer.exportTo('/tmp/sandbox.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    expect(await b.transfer.importFrom('/tmp/sandbox.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    // Added in the old-to-new order (on -> off).
    expect(b.store.listThreads().map((t) => t.osSandbox === true).sort()).toEqual([false, true])
    // If the destination does not have it (not yet probed, OpenCode, etc.), even an ON row is OFF.
    b.sandboxBackends.clear()
    expect(await b.transfer.importFrom('/tmp/sandbox.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    const rows = b.db.prepare(`SELECT os_sandbox FROM threads ORDER BY rowid`).all() as { os_sandbox: number }[]
    expect(rows.map((r) => r.os_sandbox)).toEqual([1, 0, 0, 0])
  })

  it('osSandbox の欄が無い古い書き出しは OFF として読む。真なら ON', async () => {
    // `threadJson` has no osSandbox field (the shape of exports from before TODO 1109).
    const old = threadJson([])
    expect('osSandbox' in old).toBe(false)
    await writePayload('/tmp/old.aiosdata', { threads: [old, threadJson([], { osSandbox: true })] })
    expect(await b.transfer.importFrom('/tmp/old.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    const rows = b.db.prepare(`SELECT os_sandbox FROM threads ORDER BY rowid`).all() as { os_sandbox: number }[]
    expect(rows.map((r) => r.os_sandbox)).toEqual([0, 1])
  })

  it('ページの件数がページの大きさより少なければ、空のページをもう 1 回読まない', async () => {
    seedThread(a)
    const calls: number[] = []
    const original = a.store.exportEventsPage.bind(a.store)
    a.store.exportEventsPage = (threadId, afterSeq, limit) => {
      calls.push(afterSeq)
      return original(threadId, afterSeq, limit)
    }
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    expect(calls).toEqual([0])
    expect(EXPORT_PAGE).toBeGreaterThan(4)
  })
})

describe('同時に 1 つだけ・途中の失敗', () => {
  it('予約 (exclusive) の間は書き出しも読み込みも即 busy。解けば通る', async () => {
    seedThread(a)
    let release!: () => void
    const held = a.transfer.exclusive('held', () => new Promise<string>((resolve) => (release = () => resolve('done'))))
    expect(a.transfer.busy).toBe(true)
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'busy' })
    expect(await a.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'busy' })
    expect(await a.transfer.exclusive('second', async () => 'ran')).toBe('second')
    release()
    expect(await held).toBe('done')
    expect(a.transfer.busy).toBe(false)
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toMatchObject({ kind: 'done' })
  })

  it('スレッドの途中の塊で DB が失敗したら、そのスレッドは行ごと消し、足し終えたスレッドだけ知らせる', async () => {
    seedThread(a, 'first')
    const big = a.store.createThread({
      id: 'second',
      title: 'second',
      cwd: '/Users/alice/git/x',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    a.store.appendEvents(
      big,
      's',
      Array.from({ length: IMPORT_CHUNK + 10 }, (_, i) => event('second', { kind: 'user_text', payload: { text: `m${i}` } }))
    )
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    const original = b.store.importThreadChunk.bind(b.store)
    let calls = 0
    b.store.importThreadChunk = (chunk) => {
      calls += 1
      // The first one (one chunk) passes, and the second thread is dropped at its second chunk.
      if (calls === 3) throw new Error('disk full')
      return original(chunk)
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    const threads = b.store.listThreads()
    expect(threads).toHaveLength(1)
    expect(b.imported).toEqual([[threads[0]!.id]])
    const count = b.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
    expect(count.n).toBe(4)
  })
})

describe('終了処理から止める (TODO 1117)', () => {
  /** Exports `first` (4 items) and `second`, which is split into two chunks. */
  async function exportTwo(): Promise<void> {
    seedThread(a, 'first')
    const big = a.store.createThread({
      id: 'second',
      title: 'second',
      cwd: '/Users/alice/git/x',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    a.store.appendEvents(
      big,
      's',
      Array.from({ length: IMPORT_CHUNK + 10 }, (_, i) => event('second', { kind: 'user_text', payload: { text: `m${i}` } }))
    )
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toMatchObject({ kind: 'done' })
  }

  it('読み込みの途中の stop() は書きかけのスレッドを消して返り、その後の DB を閉じても投げない', async () => {
    await exportTwo()
    const original = b.store.importThreadChunk.bind(b.store)
    let calls = 0
    let stopping: Promise<void> | null = null
    b.store.importThreadChunk = (chunk) => {
      calls += 1
      const result = original(chunk)
      // Shutdown starts (⌘Q) right after the first chunk of the second thread is written.
      if (calls === 2) stopping = b.transfer.stop()
      return result
    }
    const result = await b.transfer.importFrom('/tmp/out.aiosdata', PASS)
    expect(stopping).not.toBeNull()
    await stopping
    expect(result).toEqual({ kind: 'failed', reason: 'io' })
    // The second chunk of the second thread is not written.
    expect(calls).toBe(2)
    // Only the first thread, which was fully added, remains; the half-written second thread is removed in its entirety.
    const threads = b.store.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0]!.title).toBe('移行のテスト')
    expect(b.imported).toEqual([[threads[0]!.id]])
    const count = b.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
    expect(count.n).toBe(4)
    // Settings are not changed.
    expect(b.settings.values['theme']).not.toBe('dark')
  })

  it('stop() は走っている読み込みが抜けるまで待ち、返った後は DB に触らない', async () => {
    await exportTwo()
    let writesAfterStop = 0
    let stopped = false
    const original = b.store.importThreadChunk.bind(b.store)
    b.store.importThreadChunk = (chunk) => {
      if (stopped) writesAfterStop += 1
      return original(chunk)
    }
    const running = b.transfer.importFrom('/tmp/out.aiosdata', PASS)
    // Stops in the middle of decryption and the first-pass checks.
    await new Promise((resolve) => setImmediate(resolve))
    await b.transfer.stop()
    stopped = true
    expect(await running).toEqual({ kind: 'failed', reason: 'io' })
    expect(writesAfterStop).toBe(0)
    // An import or export that arrives after stop() (it enters the main process after the dialog closes) is refused without touching the DB or the file.
    let touched = 0
    b.store.exportThreadRows = () => {
      touched += 1
      return []
    }
    b.store.importThreadChunk = () => {
      touched += 1
      throw new Error('closed')
    }
    expect(await b.transfer.runImport('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    expect(await b.transfer.runExport('/tmp/again.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    expect(touched).toBe(0)
    expect(b.files.has('/tmp/again.aiosdata')).toBe(false)
  })

  it('書き出しの途中の stop() はファイルを書かずに返る', async () => {
    await exportTwo()
    a.files.delete('/tmp/out.aiosdata')
    const original = a.store.exportEventsPage.bind(a.store)
    let stopping: Promise<void> | null = null
    a.store.exportEventsPage = (threadId, after, limit) => {
      const page = original(threadId, after, limit)
      if (threadId === 'second' && stopping === null) stopping = a.transfer.stop()
      return page
    }
    const result = await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    await stopping
    expect(result).toEqual({ kind: 'failed', reason: 'io' })
    expect(a.files.has('/tmp/out.aiosdata')).toBe(false)
  })

  it('走っていなければ stop() はすぐ返る', async () => {
    await a.transfer.stop()
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
  })
})

describe('結果の文 (DataTransferControl)', () => {
  it('読み込みで断った場所と、書き出しで捨てた件数を添える。空のパスフレーズは専用の文', async () => {
    const { describeExport, describeImport } = await import('../src/renderer/src/components/DataTransferControl.js')
    const { translate } = await import('../src/renderer/src/i18n/index.js')
    const ja: Translate = (key, params) => translate('ja', key, params)
    const en: Translate = (key, params) => translate('en', key, params)
    expect(describeImport(ja, { kind: 'failed', reason: 'invalid-file', at: { thread: 3, event: 12 } })).toMatchObject({
      text: 'ファイルの中身の形が違うため、何も読み込みませんでした (スレッド 3 件目の 12 行目)',
      error: true
    })
    expect(describeImport(en, { kind: 'failed', reason: 'invalid-file', at: { thread: 2 } })).toMatchObject({
      text: expect.stringContaining('(thread 2)')
    })
    expect(describeImport(ja, { kind: 'failed', reason: 'passphrase-empty' })).toMatchObject({ text: 'パスフレーズを入れてください' })
    expect(describeImport(en, { kind: 'failed', reason: 'passphrase-empty' })).toMatchObject({ text: 'Enter the passphrase' })
    const exported = describeExport(ja, {
      kind: 'done',
      fileName: 'x.aiosdata',
      threads: 1,
      events: 2,
      settings: 3,
      skippedThreads: 1,
      skippedEvents: 4
    })
    expect(exported).toMatchObject({ error: false, text: expect.stringContaining('スレッド 1 件と行 4 件は書き出していません') })
  })
})
