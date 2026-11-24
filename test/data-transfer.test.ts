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
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AiosEvent } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { MAX_SENT_ATTACHMENTS, MAX_THUMBNAIL_BYTES } from '../src/shared/attachment-thumbnail.js'
import { MAGIC, SealError, bufferSource, createSealer, open, seal, type KdfParams } from '../src/main/data-transfer/crypto.js'
import { LineSplitter, LineTooLong } from '../src/main/data-transfer/lines.js'
import { checkEvent, EXPORT_FORMAT_NAME, EXPORT_FORMAT_VERSION, LIMITS, rebaseHome } from '../src/main/data-transfer/format.js'
import type { ExportWriter, ImportReader, TransferFiles } from '../src/main/data-transfer/files.js'
import {
  DataTransfer,
  EXPORT_PAGE,
  IMPORT_CHUNK,
  checkPassphrase,
  type DataTransferDeps,
  type DataTransferSettings
} from '../src/main/data-transfer/service.js'
import { AGENT_SETTING_NAMES, AgentSettings, type AgentSettingAppliers } from '../src/main/agent-settings.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import type { SettingValues, SettingsSnapshot } from '../src/shared/settings.js'
import type { Translate } from '../src/renderer/src/i18n/index.js'

/** Only the tests run scrypt at a weak setting (2^14). The production entry point uses the default strength. */
const FAST_KDF: KdfParams = { N: 2 ** 14, r: 8, p: 1 }
const PASS = 'correct horse battery'

describe('checkEvent', () => {
  it('skill_loaded (TODO 1105) passes when it has a uri', () => {
    expect(checkEvent({ kind: 'skill_loaded', actor: 'main', ts: 1_700_000_000_000, payload: { uri: 'file:///a/SKILL.md' } }).ok).toBe(true)
    expect(checkEvent({ kind: 'skill_loaded', actor: 'main', ts: 1_700_000_000_000, payload: {} }).ok).toBe(false)
  })
})

describe('seal (crypto.ts)', () => {
  const plain = Buffer.from(JSON.stringify({ hello: 'こんにちは', n: 1 }), 'utf8')

  it('returns to the original with the right passphrase; the head is a marker and the plaintext of the content does not appear', async () => {
    const sealed = await seal(plain, PASS, FAST_KDF)
    expect(sealed.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true)
    expect(sealed.includes(Buffer.from('hello'))).toBe(false)
    expect((await open(sealed, PASS)).equals(plain)).toBe(true)
  })

  it('round-trips even at production strength (DEFAULT_KDF, 128 MiB) and fits within the read limit', async () => {
    const sealed = await seal(plain, PASS)
    expect((await open(sealed, PASS)).equals(plain)).toBe(true)
  })

  it('NFC and NFD passphrases give the same key', async () => {
    const sealed = await seal(plain, 'パスワード'.normalize('NFD'), FAST_KDF)
    expect((await open(sealed, 'パスワード'.normalize('NFC'))).equals(plain)).toBe(true)
  })

  it('a different passphrase gives decrypt-failed', async () => {
    const sealed = await seal(plain, PASS, FAST_KDF)
    await expect(open(sealed, 'wrong passphrase')).rejects.toMatchObject({ reason: 'decrypt-failed' })
  })

  it('changing even 1 byte of the body, tag or header makes it unreadable', async () => {
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

  it('refuses a wrong marker, too short, a newer seal version and an excessively strong scrypt', async () => {
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

describe('passphrase validation', () => {
  it('export needs 8 or more characters, import only needs non-empty (empty is passphrase-empty); too long is refused', () => {
    expect(checkPassphrase('short', true)).toEqual({ ok: false, reason: 'passphrase-short' })
    expect(checkPassphrase('short', false)).toEqual({ ok: true, value: 'short' })
    expect(checkPassphrase('', false)).toEqual({ ok: false, reason: 'passphrase-empty' })
    expect(checkPassphrase('', true)).toEqual({ ok: false, reason: 'passphrase-short' })
    expect(checkPassphrase(42, false)).toEqual({ ok: false, reason: 'passphrase-empty' })
    expect(checkPassphrase('x'.repeat(1025), true)).toEqual({ ok: false, reason: 'passphrase-long' })
  })
})

describe('home replacement', () => {
  it('replaces only under the home of the writing side', () => {
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

/**
 * In-memory twin of `TransferFiles`. A file being written lives in `pending` until it is committed (then it appears in `files` under its
 * final name), so a test can tell "nothing was left behind" from `pending.size === 0`. `readers` counts the opens (one per import).
 */
interface MemoryFiles extends TransferFiles {
  readonly pending: Map<string, Buffer[]>
  readonly opened: string[]
}

function memoryFiles(files: Map<string, Uint8Array>): MemoryFiles {
  const pending = new Map<string, Buffer[]>()
  const opened: string[] = []
  let serial = 0
  const writer = (temp: string, target: string): ExportWriter => {
    const parts: Buffer[] = []
    pending.set(temp, parts)
    return {
      write: async (chunk) => void parts.push(Buffer.from(chunk)),
      commit: async () => {
        files.set(target, Buffer.concat(parts))
        pending.delete(temp)
      },
      discard: async () => void pending.delete(temp)
    }
  }
  return {
    pending,
    opened,
    createNew: async (path) => {
      if (files.has(path) || pending.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      return writer(path, path)
    },
    replace: async (path) => writer(`${path}.tmp-${(serial += 1)}`, path),
    openRead: async (path): Promise<ImportReader> => {
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      opened.push(path)
      return { ...bufferSource(data), close: async () => undefined }
    }
  }
}

interface Harness {
  db: Db
  store: ThreadStore
  transfer: DataTransfer
  files: Map<string, Uint8Array>
  io: MemoryFiles
  imported: string[][]
  settings: ReturnType<typeof fakeSettings>
  /** A backend that has `os-sandbox` (TODO 1109). The tests rewrite it. */
  sandboxBackends: Set<string>
}

function harness(
  home: string,
  settingsInit: Partial<SettingValues> = {},
  files = new Map<string, Uint8Array>(),
  overrides: Partial<DataTransferDeps> = {}
): Harness {
  const db = openDb()
  const store = new ThreadStore(db, home)
  const imported: string[][] = []
  const settings = fakeSettings(settingsInit)
  const sandboxBackends = new Set(['agent-cli'])
  const io = memoryFiles(files)
  const transfer = new DataTransfer({
    store,
    settings: settings.port,
    dbUserVersion: db.pragma('user_version', { simple: true }) as number,
    appVersion: '0.64.0',
    home,
    newId: () => randomUUID(),
    files: io,
    afterImport: (ids) => void imported.push([...ids]),
    supportsOsSandbox: (backend) => sandboxBackends.has(backend),
    kdf: FAST_KDF,
    ...overrides
  })
  return { db, store, transfer, files, io, imported, settings, sandboxBackends }
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

describe('round trip (DataTransfer)', () => {
  it('reading in B a file exported in A restores threads and settings, with the tool_result bodies still absent', async () => {
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

  it('importing into the same DB adds new-id threads and leaves the original threads unchanged (importing twice gives two)', async () => {
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

  it('does not export threads that are not saved (retention none) or deleted threads', async () => {
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

  it('import also goes through the persistence gate again (redaction is applied, tool_result bodies dropped)', async () => {
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

  it('a different passphrase gives decrypt-failed and writes nothing', async () => {
    seedThread(a)
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', 'not the passphrase')).toEqual({
      kind: 'failed',
      reason: 'decrypt-failed'
    })
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
  })

  it('refuses a short export passphrase before writing', async () => {
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', 'short')).toEqual({ kind: 'failed', reason: 'passphrase-short' })
    expect(a.files.size).toBe(0)
  })

  it("a round trip of 10,000 events finishes within 1 second and does not block main's event loop for long", async () => {
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

describe('refuses invalid files', () => {
  it('a type violation gives invalid-file and writes none (even with a valid thread before it); adds which thread / which item', async () => {
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

  it('when a line is not JSON (one line in the middle is broken), refuses with that line number', async () => {
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

  it('a new formatVersion gives too-new', async () => {
    await writePayload('/tmp/new.aiosdata', { formatVersion: EXPORT_FORMAT_VERSION + 1 })
    expect(await b.transfer.importFrom('/tmp/new.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'too-new' })
  })

  it('drops and counts payload lines that exceed the limit after the persistence gate', async () => {
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
  })

  it('something that decrypts but is not JSON gives invalid-file', async () => {
    a.files.set('/tmp/notjson.aiosdata', await seal(Buffer.from('not json'), PASS, FAST_KDF))
    expect(await b.transfer.importFrom('/tmp/notjson.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'invalid-file' })
  })

  it("drops and counts lines of an unknown kind (an old version reading a new version's lines); kinds that are not saved are not written either", async () => {
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

  it('drops and counts keys not among the settings editor names and unusable values, and changes only usable values', async () => {
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

  it('can read old-format files (version 1, the whole as one JSON); version 0 is invalid-file', async () => {
    await writePayload('/tmp/v1.aiosdata', { threads: [threadJson([{ kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'v1' } }])] }, 1)
    expect(await b.transfer.importFrom('/tmp/v1.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 1, events: 1 })
    await writePayload('/tmp/v0.aiosdata', { formatVersion: 0 }, 1)
    expect(await b.transfer.importFrom('/tmp/v0.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'invalid-file' })
  })
})

// ---------------------------------------------------------------------------
// Export goes through the same checks as import (a file it wrote itself can always be read)
// ---------------------------------------------------------------------------

describe('export validation', () => {
  it('fixes and exports fields over the read limit so they can be imported as they are (a long title, an empty model id, too many reference ranges)', async () => {
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

  it('does not write but counts threads that cannot be fixed (backend name does not fit the shape), lines that do not pass and too-long payloads', async () => {
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

  it('a user_text with the maximum number of maximum-size reduced copies round-trips (TODO 1325); a payload over the limit is still dropped', async () => {
    seedThread(a, 'imgs')
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(MAX_THUMBNAIL_BYTES - 12, 1)])
    expect(bytes.length).toBe(MAX_THUMBNAIL_BYTES)
    const thumbnail = `data:image/webp;base64,${bytes.toString('base64')}`
    const attachments = Array.from({ length: MAX_SENT_ATTACHMENTS }, (_, i) => ({
      uri: `aios-clipboard:${i}`,
      name: `p${i}.webp`,
      mediaType: 'image/webp',
      thumbnail
    }))
    const payload = JSON.stringify({ text: 'with images', attachments })
    expect(payload.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(payload.length).toBeLessThanOrEqual(LIMITS.payloadChars)
    a.db.prepare(`UPDATE thread_events SET payload = ? WHERE thread_id = 'imgs' AND kind = 'user_text'`).run(payload)
    expect(await a.transfer.exportTo('/tmp/imgs.aiosdata', PASS)).toMatchObject({ kind: 'done', skippedEvents: 0 })
    expect(await b.transfer.importFrom('/tmp/imgs.aiosdata', PASS)).toMatchObject({ kind: 'done', skippedEvents: 0 })
    const text = b.store.readTimeline(b.store.listThreads()[0]!.id).find((e) => e.kind === 'user_text')
    const kept = (text?.payload as { attachments?: { thumbnail?: string }[] }).attachments
    expect(kept).toHaveLength(MAX_SENT_ATTACHMENTS)
    expect(kept?.[MAX_SENT_ATTACHMENTS - 1]?.thumbnail).toBe(thumbnail)
    // Over the limit: dropped as before.
    a.db
      .prepare(`UPDATE thread_events SET payload = ? WHERE thread_id = 'imgs' AND kind = 'user_text'`)
      .run(JSON.stringify({ text: 'y'.repeat(LIMITS.payloadChars + 1) }))
    expect(await a.transfer.exportTo('/tmp/imgs2.aiosdata', PASS)).toMatchObject({ kind: 'done', skippedEvents: 1 })
  })

  it('the OS sandbox (TODO 1109) comes back in a round trip; added as OFF when the destination backend does not have it', async () => {
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

  it('an old export without the osSandbox field is read as OFF; ON when true', async () => {
    // `threadJson` has no osSandbox field (the shape of exports from before TODO 1109).
    const old = threadJson([])
    expect('osSandbox' in old).toBe(false)
    await writePayload('/tmp/old.aiosdata', { threads: [old, threadJson([], { osSandbox: true })] })
    expect(await b.transfer.importFrom('/tmp/old.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    const rows = b.db.prepare(`SELECT os_sandbox FROM threads ORDER BY rowid`).all() as { os_sandbox: number }[]
    expect(rows.map((r) => r.os_sandbox)).toEqual([0, 1])
  })

  it('when the page count is less than the page size, does not read another empty page', async () => {
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

describe('only one at a time, and failures midway', () => {
  it('while reserved (exclusive), export and import are both immediately busy; they pass once released', async () => {
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

  it('when the DB fails in a chunk in the middle of a thread, removes every thread the import added (TODO 1318: the DB is as before)', async () => {
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
      if (calls === 3) throw new Error('db failed')
      return original(chunk)
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
    const count = b.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
    expect(count.n).toBe(0)
    // A full disk (SQLite's SQLITE_FULL) is told as such.
    calls = 0
    b.store.importThreadChunk = (chunk) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
      return original(chunk)
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'disk-full' })
    expect(b.store.listThreads()).toHaveLength(0)
  })
})

describe('the second pass stays hidden until its tag check (TODO 1318 review X)', () => {
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

  /** What every entry point outside the import can see of `ids` right now. */
  function reachable(h: Harness, ids: readonly string[]): string[] {
    const seen: string[] = []
    const listed = new Set(h.store.listThreads().map((t) => t.id))
    const deleted = new Set(h.store.listDeletedThreads().map((t) => t.id))
    const live = h.store.liveThreadIds()
    const underHome = new Set(h.store.threadIdsUnderCwd('/Users/bob'))
    const backfill = new Set(h.store.indexableEvents({ limit: 100_000 }).map((e) => e.threadId))
    for (const id of ids) {
      if (listed.has(id)) seen.push(`list:${id}`)
      if (deleted.has(id)) seen.push(`deleted:${id}`)
      if (live.has(id)) seen.push(`live:${id}`)
      if (underHome.has(id)) seen.push(`cwd:${id}`)
      if (backfill.has(id)) seen.push(`backfill:${id}`)
      if (h.store.getThread(id) !== null) seen.push(`get:${id}`)
      if (h.store.indexableEventsOfThread(id, { sinceSeq: 0, limit: 10 }).length > 0) seen.push(`index:${id}`)
      if (h.store.locateThreadLink(id, null) !== 'missing') seen.push(`link:${id}`)
    }
    return seen
  }

  it('while pass 2 writes, no entry point reaches its threads; after the tag check all of them appear at once', async () => {
    await exportTwo()
    // The receiving side already has a thread of its own, and a deleted one.
    seedThread(b, 'mine')
    seedThread(b, 'binned')
    b.store.removeThread('binned')
    const added: string[] = []
    const seenDuring: string[][] = []
    const original = b.store.importThreadChunk.bind(b.store)
    b.store.importThreadChunk = (chunk) => {
      if (!added.includes(chunk.threadId)) added.push(chunk.threadId)
      const result = original(chunk)
      seenDuring.push(reachable(b, added))
      // A restore from the deleted list cannot bring a hidden row back either.
      expect(b.store.restoreThread(chunk.threadId)).toBe(false)
      return result
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2 })
    expect(seenDuring).toHaveLength(3)
    for (const seen of seenDuring) expect(seen).toEqual([])
    // Published: both are in the list, nothing is pending, the list was told once.
    expect(b.store.listThreads().map((t) => t.id).sort()).toEqual([...added, 'mine'].sort())
    expect(b.store.listDeletedThreads().map((t) => t.id)).toEqual(['binned'])
    expect(b.store.pendingImportThreads()).toEqual([])
    expect(b.imported).toEqual([added])
    for (const id of added) expect(b.store.locateThreadLink(id, null)).toBe('live')
  })

  it('a failed cleanup leaves the rows hidden and untold; the next launch sweeps them; threads that were there are untouched', async () => {
    await exportTwo()
    seedThread(b, 'mine')
    seedThread(b, 'binned')
    b.store.removeThread('binned')
    const original = b.store.importThreadChunk.bind(b.store)
    let calls = 0
    const added: string[] = []
    b.store.importThreadChunk = (chunk) => {
      calls += 1
      if (calls === 3) throw new Error('db failed')
      if (!added.includes(chunk.threadId)) added.push(chunk.threadId)
      return original(chunk)
    }
    b.store.removePendingImportPart = () => {
      throw new Error('db failed again')
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    expect(b.imported).toEqual([])
    expect(reachable(b, added)).toEqual([])
    expect(b.store.listThreads().map((t) => t.id)).toEqual(['mine'])
    expect(b.store.listDeletedThreads().map((t) => t.id)).toEqual(['binned'])
    expect(b.store.pendingImportThreads().map((row) => row.id).sort()).toEqual([...added].sort())
    // The next launch (a fresh DataTransfer over the same DB) removes them, a chunk at a time, and tells nobody.
    const store = new ThreadStore(b.db, '/Users/bob')
    const nextLaunch = harness('/Users/bob', {}, a.files, { store })
    expect(await nextLaunch.transfer.sweepPendingImports()).toBe(2)
    nextLaunch.db.close()
    expect(store.pendingImportThreads()).toEqual([])
    expect(nextLaunch.imported).toEqual([])
    const left = b.db.prepare(`SELECT COUNT(*) AS n FROM thread_events WHERE thread_id NOT IN ('mine', 'binned')`).get() as { n: number }
    expect(left.n).toBe(0)
    expect(store.listThreads().map((t) => t.id)).toEqual(['mine'])
    expect(store.listDeletedThreads().map((t) => t.id)).toEqual(['binned'])
    expect(store.readTimeline('mine')).toHaveLength(4)
    expect(store.readTimeline('binned')).toHaveLength(4)
  })

  it('a tag mismatch in pass 2 removes every hidden thread and tells nothing', async () => {
    // Hardly compressible text after the two threads, so the file spans several reads and they are written before the end.
    const noise = a.store.createThread({
      id: 'noise',
      title: 'noise',
      cwd: '/Users/alice/git/x',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    a.store.appendEvents(
      noise,
      's',
      Array.from({ length: 300 }, () => event('noise', { kind: 'user_text', payload: { text: randomBytes(3000).toString('base64') } }))
    )
    await exportTwo()
    const file = Buffer.from(a.files.get('/tmp/out.aiosdata')!)
    let passes = 0
    const changing: TransferFiles = {
      ...a.io,
      openRead: async () => ({
        size: file.length,
        read: async (position, length) => {
          if (position === 0) passes += 1
          const bytes = Buffer.from(file.subarray(position, Math.min(file.length, position + length)))
          const at = file.length - 1 - position
          if (passes >= 2 && at >= 0 && at < bytes.length) bytes[at] = bytes[at]! ^ 0x01
          return bytes
        },
        close: async () => undefined
      })
    }
    const y = harness('/Users/bob', {}, new Map(), { files: changing })
    const added: string[] = []
    const insert = y.store.importThreadChunk.bind(y.store)
    y.store.importThreadChunk = (chunk) => {
      if (!added.includes(chunk.threadId)) added.push(chunk.threadId)
      return insert(chunk)
    }
    try {
      expect(await y.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'decrypt-failed' })
      expect(added.length).toBeGreaterThanOrEqual(2)
      expect(reachable(y, added)).toEqual([])
      expect(y.store.pendingImportThreads()).toEqual([])
      expect(y.imported).toEqual([])
    } finally {
      y.db.close()
    }
  })

  it('the launch sweep leaves the rows of an import that is running', async () => {
    await exportTwo()
    let sweep: Promise<number> | null = null
    const original = b.store.importThreadChunk.bind(b.store)
    b.store.importThreadChunk = (chunk) => {
      const result = original(chunk)
      sweep ??= b.transfer.sweepPendingImports()
      return result
    }
    expect(await b.transfer.importFrom('/tmp/out.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 2, events: IMPORT_CHUNK + 14 })
    expect(sweep).not.toBeNull()
    expect(await sweep).toBe(0)
    expect(b.store.listThreads()).toHaveLength(2)
  })

  it('stop() waits for a running sweep, which leaves the rest for the next launch', async () => {
    await exportTwo()
    const original = b.store.importThreadChunk.bind(b.store)
    let calls = 0
    b.store.importThreadChunk = (chunk) => {
      calls += 1
      if (calls === 3) throw new Error('db failed')
      return original(chunk)
    }
    b.store.removePendingImportPart = () => {
      throw new Error('db failed again')
    }
    await b.transfer.importFrom('/tmp/out.aiosdata', PASS)
    const store = new ThreadStore(b.db, '/Users/bob')
    const nextLaunch = harness('/Users/bob', {}, a.files, { store })
    const part = store.removePendingImportPart.bind(store)
    let parts = 0
    let stopping: Promise<void> | null = null
    store.removePendingImportPart = (threadId, limit) => {
      parts += 1
      stopping ??= nextLaunch.transfer.stop()
      return part(threadId, limit)
    }
    const swept = await nextLaunch.transfer.sweepPendingImports()
    await stopping
    nextLaunch.db.close()
    expect(parts).toBeGreaterThanOrEqual(1)
    expect(swept).toBeLessThan(2)
    expect(store.pendingImportThreads().length).toBe(2 - swept)
    expect(store.listThreads()).toHaveLength(0)
  })
})

describe('stop from shutdown (TODO 1117)', () => {
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

  it('stop() in the middle of an import leaves its threads hidden for the next launch and returns; closing the DB afterwards does not throw', async () => {
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
    // TODO 1318: nothing of an unfinished import is seen (the second pass's tag was never checked) - neither the first thread nor the half one.
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.store.listDeletedThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
    // Review X: the quit is not held by removing them; they stay hidden and the next launch's sweep removes them.
    expect(b.store.pendingImportThreads()).toHaveLength(2)
    expect(await b.transfer.sweepPendingImports()).toBe(0)
    const nextLaunch = harness('/Users/bob', {}, a.files, { store: b.store })
    expect(await nextLaunch.transfer.sweepPendingImports()).toBe(2)
    nextLaunch.db.close()
    expect(b.store.pendingImportThreads()).toHaveLength(0)
    const count = b.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
    expect(count.n).toBe(0)
    // Settings are not changed.
    expect(b.settings.values['theme']).not.toBe('dark')
  })

  it('stop() waits until the running import exits and does not touch the DB after returning', async () => {
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

  it('stop() in the middle of an export returns without writing the file', async () => {
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

  it('stop() returns right away when nothing is running', async () => {
    await a.transfer.stop()
    expect(await a.transfer.exportTo('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
  })
})

describe('streaming (TODO 1318)', () => {
  it('the sealer writes into the sink as it goes, in bounded pieces, and the result opens', async () => {
    const writes: number[] = []
    const parts: Buffer[] = []
    const sink = {
      write: async (chunk: Buffer): Promise<void> => {
        writes.push(chunk.length)
        parts.push(Buffer.from(chunk))
      }
    }
    const sealer = await createSealer(PASS, sink, FAST_KDF)
    // Hardly compressible input (base64 of random bytes), about 6 MiB in 64 KiB pieces.
    const plain: Buffer[] = []
    for (let i = 0; i < 96; i += 1) {
      const piece = Buffer.from(randomBytes(48 * 1024).toString('base64'), 'utf8')
      plain.push(piece)
      await sealer.write(piece)
    }
    // The header and a good part of the body reached the sink before the end (nothing accumulates until finish).
    expect(writes.length).toBeGreaterThan(2)
    const total = await sealer.finish()
    expect(total).toBe(writes.reduce((sum, n) => sum + n, 0))
    expect(Math.max(...writes)).toBeLessThan(2 * 1024 * 1024)
    expect((await open(Buffer.concat(parts), PASS)).equals(Buffer.concat(plain))).toBe(true)
  })

  it('a sink that fails (a full disk) fails the next write or the finish with the same error', async () => {
    let written = 0
    const sealer = await createSealer(
      PASS,
      {
        write: async (chunk) => {
          written += chunk.length
          if (written > 4096) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
        }
      },
      FAST_KDF
    )
    const attempt = async (): Promise<void> => {
      for (let i = 0; i < 64; i += 1) await sealer.write(randomBytes(64 * 1024))
      await sealer.finish()
    }
    await expect(attempt()).rejects.toMatchObject({ code: 'ENOSPC' })
  })

  it('reads files written by the released versions (fixtures: 0.102 = JSON lines, 0.64 = one JSON)', async () => {
    const fixture = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/data-transfer/${name}`, import.meta.url))
    const files = new Map<string, Uint8Array>([
      ['/f/v2.aiosdata', fixture('v2-0.102.aiosdata')],
      ['/f/v1.aiosdata', fixture('v1-0.64.aiosdata')]
    ])
    const h = harness('/Users/bob', {}, files)
    try {
      expect(await h.transfer.importFrom('/f/v2.aiosdata', 'fixture passphrase 1318')).toMatchObject({
        kind: 'done',
        threads: 2,
        events: 34,
        skippedEvents: 0,
        settings: 1
      })
      expect(h.store.listThreads().map((t) => t.title).sort()).toEqual(['second', '古い書き出し'])
      const old = h.store.listThreads().find((t) => t.title === '古い書き出し')!
      expect(old.cwdUri).toBe('file:///Users/bob/git/project')
      expect(h.store.readTimeline(old.id).map((e) => e.kind)).toEqual(['user_text', 'tool_use', 'tool_result', 'assistant_text'])
      expect(h.store.readTimeline(old.id)[2]!.payload).toEqual({ toolUseId: 'tu-1', ok: true, bytes: 12 })
      expect(h.settings.values.theme).toBe('dark')
      expect(await h.transfer.importFrom('/f/v1.aiosdata', 'fixture passphrase 1318')).toMatchObject({
        kind: 'done',
        threads: 1,
        events: 2,
        settings: 1
      })
      expect(h.settings.values.theme).toBe('light')
      // One open per import: both passes read the same descriptor.
      expect(h.io.opened).toEqual(['/f/v2.aiosdata', '/f/v1.aiosdata'])
      expect(await h.transfer.importFrom('/f/v2.aiosdata', 'not the passphrase')).toEqual({ kind: 'failed', reason: 'decrypt-failed' })
    } finally {
      h.db.close()
    }
  })

  it('there is no whole-file limit: contents far over the line limit round-trip when each line fits', async () => {
    const small = 64 * 1024
    const x = harness('/Users/alice', {}, new Map(), { lineBytes: small })
    const y = harness('/Users/bob', {}, x.files, { lineBytes: small })
    try {
      for (let t = 0; t < 12; t += 1) {
        const thread = x.store.createThread({
          id: `t${t}`,
          title: `t${t}`,
          cwd: '/Users/alice/git/x',
          allowedDirs: [],
          retention: 'forever',
          backend: 'agent-cli',
          modelId: null,
          thinking: null
        })
        x.store.appendEvents(
          thread,
          's',
          Array.from({ length: 20 }, (_, i) => event(`t${t}`, { kind: 'user_text', payload: { text: `${i} ` + 'z'.repeat(2000) } }))
        )
      }
      // 12 threads of about 40 KiB each: about 480 KiB of contents, over seven times the line limit.
      expect(await x.transfer.exportTo('/tmp/many.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 12, events: 240, skippedEvents: 0 })
      expect((await open(x.files.get('/tmp/many.aiosdata')!, PASS)).length).toBeGreaterThan(7 * small)
      expect(await y.transfer.importFrom('/tmp/many.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 12, events: 240 })
    } finally {
      x.db.close()
      y.db.close()
    }
  })

  it('export keeps each thread within the line limit (the rest of a too-long thread is dropped and counted) and the file reads back', async () => {
    const small = 16 * 1024
    const x = harness('/Users/alice', {}, new Map(), { lineBytes: small })
    const y = harness('/Users/bob', {}, x.files, { lineBytes: small })
    try {
      const thread = x.store.createThread({
        id: 'long',
        title: 'long',
        cwd: '/Users/alice/git/x',
        allowedDirs: [],
        retention: 'forever',
        backend: 'agent-cli',
        modelId: null,
        thinking: null
      })
      x.store.appendEvents(
        thread,
        's',
        Array.from({ length: 40 }, (_, i) => event('long', { kind: 'user_text', payload: { text: `${i} ` + 'z'.repeat(1000) } }))
      )
      const exported = await x.transfer.exportTo('/tmp/long.aiosdata', PASS)
      expect(exported).toMatchObject({ kind: 'done', threads: 1, skippedThreads: 0 })
      const kept = (exported as { events: number }).events
      expect(kept).toBeGreaterThan(5)
      expect(kept).toBeLessThan(40)
      expect(exported).toMatchObject({ skippedEvents: 40 - kept })
      // Every line of the file is within the limit.
      const lines = (await open(x.files.get('/tmp/long.aiosdata')!, PASS)).toString('utf8').split('\n').filter((l) => l !== '')
      for (const line of lines) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(small)
      // The beginning of the conversation is kept, in order.
      expect(await y.transfer.importFrom('/tmp/long.aiosdata', PASS)).toMatchObject({ kind: 'done', threads: 1, events: kept })
      const texts = y.store.readTimeline(y.store.listThreads()[0]!.id).map((e) => (e.payload as { text: string }).text.split(' ')[0])
      expect(texts).toEqual(Array.from({ length: kept }, (_, i) => String(i)))
    } finally {
      x.db.close()
      y.db.close()
    }
  })

  it('import refuses a line over the limit with too-large and its place, writing nothing', async () => {
    const small = 8 * 1024
    const y = harness('/Users/bob', {}, a.files, { lineBytes: small })
    try {
      await writePayload('/tmp/wide.aiosdata', {
        threads: [
          threadJson([{ kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'fits' } }]),
          threadJson([{ kind: 'user_text', actor: 'main', ts: 1, payload: { text: 'w'.repeat(small) } }])
        ]
      })
      expect(await y.transfer.importFrom('/tmp/wide.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'too-large', at: { thread: 2 } })
      expect(y.store.listThreads()).toHaveLength(0)
      expect(y.imported).toEqual([])
    } finally {
      y.db.close()
    }
  })

  it('the line splitter holds one line at a time and stops at the limit (a line of exactly the limit passes)', async () => {
    const lines: string[] = []
    const splitter = new LineSplitter(10, async (line, index) => void lines.push(`${index}:${line.toString('utf8')}`))
    await splitter.push(Buffer.from('0123456789\nab'))
    await splitter.push(Buffer.from('c\n\nlast'))
    await splitter.end()
    expect(lines).toEqual(['0:0123456789', '1:abc', '2:', '3:last'])
    const strict = new LineSplitter(10, async () => undefined)
    await strict.push(Buffer.from('short\n'))
    await expect(strict.push(Buffer.from('01234567890'))).rejects.toEqual(new LineTooLong(1))
    // A trailing newline does not make an empty last line.
    const trailing: string[] = []
    const ends = new LineSplitter(10, async (line) => void trailing.push(line.toString('utf8')))
    await ends.push(Buffer.from('a\nb\n'))
    await ends.end()
    expect(trailing).toEqual(['a', 'b'])
  })

  it('a tampered end of the file is decrypt-failed even though every line before it was valid, and nothing is written', async () => {
    seedThread(a)
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    const file = Buffer.from(a.files.get('/tmp/out.aiosdata')!)
    for (const at of [file.length - 17, file.length - 1]) {
      const tampered = Buffer.from(file)
      tampered[at] = tampered[at]! ^ 0x01
      a.files.set('/tmp/tampered.aiosdata', tampered)
      expect(await b.transfer.importFrom('/tmp/tampered.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'decrypt-failed' })
    }
    expect(b.store.listThreads()).toHaveLength(0)
    expect(b.imported).toEqual([])
    expect(b.settings.values.theme).not.toBe('dark')
  })

  it('a wrong content is invalid-file only when the tag matches; with a broken tag it is decrypt-failed', async () => {
    await writePayload('/tmp/bad-head.aiosdata', { format: 'something-else' })
    expect(await b.transfer.importFrom('/tmp/bad-head.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'invalid-file' })
    const tampered = Buffer.from(a.files.get('/tmp/bad-head.aiosdata')!)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01
    a.files.set('/tmp/bad-head.aiosdata', tampered)
    expect(await b.transfer.importFrom('/tmp/bad-head.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'decrypt-failed' })
  })

  it('a file changed between the two passes (same descriptor, bytes rewritten in place) is caught by the second tag check and nothing stays', async () => {
    seedThread(a, 'first')
    // A second thread of hardly compressible text, so the file spans several reads and the first thread is imported before the end.
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
      Array.from({ length: 300 }, () => event('second', { kind: 'user_text', payload: { text: randomBytes(3000).toString('base64') } }))
    )
    await a.transfer.exportTo('/tmp/out.aiosdata', PASS)
    const original = Buffer.from(a.files.get('/tmp/out.aiosdata')!)
    expect(original.length).toBeGreaterThan(3 * 256 * 1024)
    let passes = 0
    const changing: TransferFiles = {
      createNew: async () => {
        throw new Error('unused')
      },
      replace: async () => {
        throw new Error('unused')
      },
      openRead: async () => ({
        size: original.length,
        read: async (position, length) => {
          // Every pass starts by reading the magic at 0. From the second pass on, the last ciphertext byte differs.
          if (position === 0) passes += 1
          const bytes = Buffer.from(original.subarray(position, Math.min(original.length, position + length)))
          const at = original.length - 17 - position
          if (passes >= 2 && at >= 0 && at < bytes.length) bytes[at] = bytes[at]! ^ 0x01
          return bytes
        },
        close: async () => undefined
      })
    }
    const y = harness('/Users/bob', {}, new Map(), { files: changing })
    let chunks = 0
    const insert = y.store.importThreadChunk.bind(y.store)
    y.store.importThreadChunk = (chunk) => {
      chunks += 1
      return insert(chunk)
    }
    try {
      expect(await y.transfer.importFrom('/tmp/out.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'decrypt-failed' })
      expect(passes).toBe(2)
      // The second pass did write (the tag is only at the end) - and all of it was removed.
      expect(chunks).toBeGreaterThanOrEqual(1)
      expect(y.store.listThreads()).toHaveLength(0)
      const count = y.db.prepare(`SELECT COUNT(*) AS n FROM thread_events`).get() as { n: number }
      expect(count.n).toBe(0)
      expect(y.imported).toEqual([])
      expect(y.settings.values.theme).not.toBe('dark')
    } finally {
      y.db.close()
    }
  })

  it('a full disk while exporting is disk-full, the partial is removed and an existing target is left as it was', async () => {
    seedThread(a)
    a.files.set('/tmp/target.aiosdata', Buffer.from('an older export'))
    const failingFiles: TransferFiles = {
      ...a.io,
      replace: async (path) => {
        const inner = await a.io.replace(path)
        let bytes = 0
        return {
          ...inner,
          write: async (chunk) => {
            bytes += chunk.length
            if (bytes > 100) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
            await inner.write(chunk)
          }
        }
      }
    }
    const x = new DataTransfer({
      store: a.store,
      settings: a.settings.port,
      dbUserVersion: 1,
      appVersion: '0',
      home: '/Users/alice',
      newId: () => randomUUID(),
      files: failingFiles,
      afterImport: () => undefined,
      supportsOsSandbox: () => false,
      kdf: FAST_KDF
    })
    expect(await x.exportTo('/tmp/target.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'disk-full' })
    expect(Buffer.from(a.files.get('/tmp/target.aiosdata')!).toString('utf8')).toBe('an older export')
    expect(a.io.pending.size).toBe(0)
  })

  it('stop() in the middle of an export removes what was written', async () => {
    seedThread(a, 'first')
    seedThread(a, 'second')
    const original = a.store.exportEventsPage.bind(a.store)
    let stopping: Promise<void> | null = null
    a.store.exportEventsPage = (threadId, after, limit) => {
      if (threadId === 'second' && stopping === null) stopping = a.transfer.stop()
      return original(threadId, after, limit)
    }
    expect(await a.transfer.exportTo('/tmp/stopped.aiosdata', PASS)).toEqual({ kind: 'failed', reason: 'io' })
    await stopping
    expect(a.files.has('/tmp/stopped.aiosdata')).toBe(false)
    expect(a.io.pending.size).toBe(0)
  })
})

describe('result sentences (DataTransferControl)', () => {
  it('adds the places refused in import and the number dropped in export; an empty passphrase has its own sentence', async () => {
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
