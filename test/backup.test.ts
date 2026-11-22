/**
 * Automatic backup and recovery (TODO 1306, ARCHITECTURE 8.7). The model is not called; the keychain is a fake.
 *
 * - Generation names: strict shape with the owner id, rotation keeps the newest 3 of ours, other files and other owners' generations are
 *   never touched, generations from the future are ordered last and the one just written is always kept.
 * - Nothing runs without a passphrase, and nothing runs in a verification launch.
 * - A backup is TODO 1088's export file (opens with the passphrase, no plaintext) written through an exclusively created partial file +
 *   rename; a failure midway leaves no partial and keeps the existing generations; a planted symlink is never followed.
 * - Idle and due decisions; a requested backup stays due until one is really written.
 * - A damaged DB stops backups and offers the restore; the restore spans a restart (marker -> move aside -> import into a fresh DB), and
 *   until the import ends `restored` nothing is backed up or rotated. A typed passphrase is used for the restore only.
 * - The light check runs at most once a day, not right after startup, and at once after an unfinished check.
 * - Shutdown: `stop()` stops the transfer, waits for the running body, and writes nothing to the DB afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiosEvent } from '../src/shared/agent.js'
import type { BackupFailure, DbQuickCheckResult } from '../src/shared/backup.js'
import type { DataExportResult, DataImportResult } from '../src/shared/data-transfer.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { open, type KdfParams } from '../src/main/data-transfer/crypto.js'
import { DataTransfer, verifyExportFile, writeNewFileDurably } from '../src/main/data-transfer/service.js'
import {
  backupFileName,
  generationTime,
  generationsOf,
  generationsToPrune,
  parseGenerationName,
  partialFileName,
  partialsToSweep
} from '../src/main/backup/generations.js'
import { BackupService, type BackupDeps, type BackupTransfer } from '../src/main/backup/service.js'
import {
  RESTORE_PASSPHRASE_FILE,
  readRestoreMarker,
  removeRestoreMarker,
  takePendingRestore,
  writeRestoreMarker
} from '../src/main/backup/restore.js'
import { makeTestDir } from './helpers/tmp.js'

const FAST_KDF: KdfParams = { N: 2 ** 14, r: 8, p: 1 }
const PASS = 'correct horse battery'
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 22, 3, 0, 0)
const OWNER = '0123456789abcdef'
const OTHER = 'fedcba9876543210'
const NONCE = 'aaaaaaaaaaaaaaaa'
const ORDER = { now: T0, futureMs: DAY }
const name = (ms: number, owner: string = OWNER): string => backupFileName(ms, owner)
const OK_CHECK: DbQuickCheckResult = { ok: true, tables: 3, damaged: [], stopped: false, ms: 1, slowest: { table: 'threads', ms: 1 } }

// ---------------------------------------------------------------------------

describe('generation names (generations.ts)', () => {
  it('round-trips the time and the owner, and is UTC with seconds', () => {
    expect(name(T0)).toBe(`backup-20261122-030000Z-${OWNER}.aiosdata`)
    expect(generationTime(name(T0))).toBe(T0)
    expect(parseGenerationName(name(T0, OTHER))).toEqual({ at: T0, owner: OTHER })
    expect(partialFileName(T0, OWNER, NONCE)).toBe(`.backup-20261122-030000Z-${OWNER}-${NONCE}.aiosdata.partial`)
    expect(() => backupFileName(T0, 'alice-macbook')).toThrow()
  })

  it('only names of the exact shape (and a real date) are ours', () => {
    for (const bad of [
      `backup-20261322-030000Z-${OWNER}.aiosdata`,
      `backup-20261122-030000-${OWNER}.aiosdata`,
      'backup-20261122-030000Z.aiosdata',
      `backup-20261122-030000Z-${OWNER.toUpperCase()}.aiosdata`,
      `backup-20261122-030000Z-${OWNER}0.aiosdata`,
      `mybackup-20261122-030000Z-${OWNER}.aiosdata`,
      `backup-20261122-030000Z-${OWNER}.aiosdata.bak`,
      `backup-20261122-030000Z-${OWNER}.aiosdata/../x`,
      'aios-data-2026-11-22.aiosdata',
      'notes.txt'
    ]) {
      expect(generationTime(bad), bad).toBeNull()
    }
  })

  it('rotation keeps the newest N of ours and never lists other names or other owners', () => {
    const names = [
      name(T0 - 3 * DAY),
      'notes.txt',
      name(T0),
      name(T0 - DAY),
      name(T0 - 5 * DAY, OTHER),
      'aios-data-2026-11-22.aiosdata',
      name(T0 - 2 * DAY)
    ]
    expect(generationsOf(names, OWNER, ORDER).map((g) => g.at)).toEqual([T0, T0 - DAY, T0 - 2 * DAY, T0 - 3 * DAY])
    expect(generationsToPrune(names, 3, OWNER, ORDER)).toEqual([name(T0 - 3 * DAY)])
    expect(generationsToPrune(names, 10, OWNER, ORDER)).toEqual([])
    expect(generationsOf(names, OTHER, ORDER).map((g) => g.name)).toEqual([name(T0 - 5 * DAY, OTHER)])
  })

  it('generations from the future go last, and the one just written is always kept', () => {
    const futures = [name(T0 + 10 * DAY), name(T0 + 11 * DAY), name(T0 + 12 * DAY)]
    const names = [...futures, name(T0)]
    expect(generationsOf(names, OWNER, ORDER).map((g) => g.name)).toEqual([name(T0), ...[...futures].reverse()])
    expect(generationsToPrune(names, 3, OWNER, ORDER, name(T0))).toEqual([name(T0 + 10 * DAY)])
    // Even with keep = 1 the generation just written survives.
    expect(generationsToPrune(names, 1, OWNER, ORDER, name(T0))).not.toContain(name(T0))
  })

  it('a partial file of ours is swept only when its stamp is beyond the grace time (either way)', () => {
    const hour = 60 * 60 * 1000
    const old = partialFileName(T0 - 2 * hour, OWNER, NONCE)
    const future = partialFileName(T0 + 2 * hour, OWNER, NONCE)
    const young = partialFileName(T0 - 60 * 1000, OWNER, NONCE)
    const others = partialFileName(T0 - 2 * hour, OTHER, NONCE)
    const noNonce = `.backup-20261122-010000Z-${OWNER}.aiosdata.partial`
    expect(partialsToSweep([old, future, young, others, noNonce, '.other.partial'], OWNER, T0, hour)).toEqual([old, future])
  })
})

// ---------------------------------------------------------------------------

function event(threadId: string, kind: 'user_text' | 'assistant_text', text: string): AiosEvent {
  return { id: randomUUID(), sessionId: 's-1', threadId, ts: T0, actor: 'main', kind, payload: { text } } as AiosEvent
}

interface Harness {
  readonly db: Db
  readonly store: ThreadStore
  readonly transfer: DataTransfer
  readonly records: { failure: { at: number; reason: BackupFailure } | null; dismissed: boolean; writes: number }
  readonly passphrase: { value: string | null; available: boolean; gets: number }
  readonly restorePassphrase: { value: string | null }
  readonly userData: string
  readonly dir: string
  now: number
  idle: boolean
  systemIdle: number
  checks: number
  check: () => Promise<DbQuickCheckResult>
  service(overrides?: Partial<BackupDeps>): BackupService
}

let root: string
const open_: Db[] = []

function harness(label: string, owner: string | null = OWNER): Harness {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  open_.push(db)
  const store = new ThreadStore(db, '/Users/alice')
  const transfer = new DataTransfer({
    store,
    settings: { values: () => ({}), apply: () => 'invalid' },
    dbUserVersion: 1,
    appVersion: '0.99.0',
    home: '/Users/alice',
    newId: () => randomUUID(),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    fileSize: async (path) => (await stat(path)).size,
    writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
    afterImport: () => undefined,
    supportsOsSandbox: () => false,
    kdf: FAST_KDF
  })
  const userData = join(root, label, 'userData')
  mkdirSync(userData, { recursive: true })
  if (owner !== null) writeFileSync(join(userData, 'backup.id'), `${owner}\n`)
  const h: Harness = {
    db,
    store,
    transfer,
    records: { failure: null, dismissed: false, writes: 0 },
    passphrase: { value: null, available: true, gets: 0 },
    restorePassphrase: { value: null },
    userData,
    dir: join(root, label, 'userData Backups'),
    now: T0,
    idle: true,
    systemIdle: 600,
    checks: 0,
    check: async () => OK_CHECK,
    service: (overrides = {}) =>
      new BackupService({
        unsupportedReason: null,
        initialHealth: 'unknown',
        keyUnreadable: false,
        transfer,
        passphrase: {
          available: () => h.passphrase.available,
          isSet: () => h.passphrase.value !== null,
          get: () => {
            h.passphrase.gets += 1
            return h.passphrase.value
          },
          set: (value) => void (h.passphrase.value = value)
        },
        restorePassphrase: {
          available: () => true,
          get: () => h.restorePassphrase.value,
          set: (value) => void (h.restorePassphrase.value = value)
        },
        records: {
          lastFailure: () => h.records.failure,
          setLastFailure: (value) => {
            h.records.writes += 1
            h.records.failure = value
          },
          noticeDismissed: () => h.records.dismissed,
          dismissNotice: () => {
            h.records.writes += 1
            h.records.dismissed = true
          }
        },
        configFile: join(userData, 'backup.json'),
        ownerFile: join(userData, 'backup.id'),
        checkRecordFile: join(userData, 'db-check.json'),
        defaultDir: h.dir,
        isIdle: () => h.idle,
        systemIdleSeconds: () => h.systemIdle,
        quickCheck: () => {
          h.checks += 1
          return h.check()
        },
        verifyFile: (path, passphrase) =>
          verifyExportFile(
            { readFile: async (p) => new Uint8Array(await readFile(p)), fileSize: async (p) => (await stat(p)).size },
            path,
            passphrase
          ),
        writeRestoreMarker: (marker) => writeRestoreMarker(userData, marker),
        removeRestoreMarker: () => {
          h.restorePassphrase.value = null
          removeRestoreMarker(userData)
        },
        onChanged: () => undefined,
        now: () => h.now,
        ...overrides
      })
  }
  return h
}

function seed(h: Harness, title = 'バックアップのテスト'): void {
  const thread = h.store.createThread({
    id: randomUUID(),
    title,
    cwd: '/Users/alice/git/project',
    allowedDirs: ['/Users/alice/git/project'],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })
  h.store.appendEvents(thread, 's-1', [event(thread.id, 'user_text', 'こんにちは'), event(thread.id, 'assistant_text', '読みました')])
}

/** A transfer whose export / import are replaced (the rest is the harness's real one). */
function transferWith(h: Harness, parts: Partial<Pick<BackupTransfer, 'runExport' | 'runImport' | 'stop'>>): BackupTransfer {
  return {
    exclusive: (busy, fn) => h.transfer.exclusive(busy, fn),
    runExport: parts.runExport ?? ((path, passphrase, options) => h.transfer.runExport(path, passphrase, options)),
    runImport: parts.runImport ?? ((path, passphrase) => h.transfer.runImport(path, passphrase)),
    stop: parts.stop ?? (() => h.transfer.stop())
  }
}

beforeEach(() => {
  root = makeTestDir('backup')
})

afterEach(() => {
  for (const db of open_.splice(0)) db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('BackupService: when it does not run', () => {
  it('without a passphrase nothing is written (tick and Back Up Now)', async () => {
    const h = harness('nopass')
    seed(h)
    const service = h.service()
    await service.tick()
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'no-passphrase' })
    expect(existsSync(h.dir)).toBe(false)
    expect(service.status()).toMatchObject({ supported: true, passphraseSet: false, generations: [] })
  })

  it('a verification launch (instance) does nothing, never checks the DB, and writes no file in userData', async () => {
    const h = harness('instance', null)
    h.passphrase.value = PASS
    seed(h)
    const service = h.service({ unsupportedReason: 'instance' })
    service.start()
    await service.startHealthCheck()
    await service.checkHealth()
    await service.tick()
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'unsupported' })
    expect(service.setPassphrase('another passphrase')).toEqual({ kind: 'failed', reason: 'unsupported' })
    expect(h.passphrase.value).toBe(PASS)
    expect(h.checks).toBe(0)
    expect(existsSync(h.dir)).toBe(false)
    expect(readdirSync(h.userData)).toEqual([])
    expect(service.status()).toMatchObject({ supported: false, unsupportedReason: 'instance', noticeDismissed: true, passphraseSet: false })
    await service.stop()
  })

  it('the passphrase follows the export rule and is not stored when the keychain cannot seal', () => {
    const h = harness('pass')
    const service = h.service()
    expect(service.setPassphrase('short')).toEqual({ kind: 'failed', reason: 'passphrase-short' })
    h.passphrase.available = false
    expect(service.setPassphrase(PASS)).toEqual({ kind: 'failed', reason: 'unsupported' })
    expect(h.passphrase.value).toBeNull()
    h.passphrase.available = true
    expect(service.setPassphrase(PASS)).toEqual({ kind: 'done' })
    expect(h.passphrase.value).toBe(PASS)
    // Setting it makes a backup due right away.
    expect(service.isDue()).toBe(true)
  })

  it('review 8: status() never unseals the passphrase (it asks the store whether one is set)', () => {
    const h = harness('status-cheap')
    h.passphrase.value = PASS
    const service = h.service()
    for (let i = 0; i < 5; i += 1) expect(service.status().passphraseSet).toBe(true)
    expect(h.passphrase.gets).toBe(0)
  })
})

describe('BackupService: owner id (review 3)', () => {
  it('is created once per profile (random, 16 hex digits), kept outside the DB, and reused', () => {
    const h = harness('owner-new', null)
    const first = h.service()
    expect(first.ownerId).toMatch(/^[0-9a-f]{16}$/)
    expect(readFileSync(join(h.userData, 'backup.id'), 'utf8').trim()).toBe(first.ownerId)
    expect(h.service().ownerId).toBe(first.ownerId)
    expect(harness('owner-other', null).service().ownerId).not.toBe(first.ownerId)
  })

  it('never deletes, lists or restores another owner\'s generations in a shared folder', async () => {
    const h = harness('shared')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    const theirs = [1, 2, 3, 4].map((i) => name(T0 - i * 60 * 1000, OTHER))
    for (const file of theirs) writeFileSync(join(h.dir, file), 'theirs')
    for (let i = 1; i <= 3; i += 1) writeFileSync(join(h.dir, name(T0 - i * DAY)), 'mine')
    const service = h.service()
    expect(await service.runNow()).toEqual({ kind: 'done' })
    const names = readdirSync(h.dir)
    for (const file of theirs) expect(names).toContain(file)
    expect(names.filter((n) => n.includes(OWNER)).sort()).toEqual([name(T0), name(T0 - DAY), name(T0 - 2 * DAY)].sort())
    expect(service.status().generations.map((g) => g.fileName)).toEqual([name(T0), name(T0 - DAY), name(T0 - 2 * DAY)])
  })

  it('restore never picks another owner\'s generation, even when it is newer', async () => {
    const h = harness('shared-restore')
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(join(h.dir, name(T0, OTHER)), 'theirs')
    h.passphrase.value = PASS
    const service = h.service({ initialHealth: 'unopenable' })
    expect(await service.prepareRestore(PASS)).toEqual({ ok: false, reason: 'no-backup' })
    expect(service.status().generations).toEqual([])
  })
})

describe('BackupService: writing a generation', () => {
  it('writes an export file that opens with the passphrase, with no partial left and no plaintext', async () => {
    const h = harness('write')
    h.passphrase.value = PASS
    seed(h)
    const service = h.service()
    expect(await service.runNow()).toEqual({ kind: 'done' })
    const names = readdirSync(h.dir)
    expect(names).toEqual([name(T0)])
    const bytes = readFileSync(join(h.dir, names[0]!))
    expect(bytes.includes(Buffer.from('バックアップのテスト'))).toBe(false)
    const plain = (await open(bytes, PASS)).toString('utf8')
    expect(plain).toContain('バックアップのテスト')
    expect((await stat(join(h.dir, names[0]!))).mode & 0o777).toBe(0o600)
    expect(service.status().generations).toEqual([{ fileName: name(T0), at: T0, bytes: bytes.length }])
  })

  it('keeps the newest 3 and leaves the other files in the folder alone', async () => {
    const h = harness('rotate')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    const others = ['notes.txt', `mybackup-20261101-000000Z-${OWNER}.aiosdata`, 'aios-data-2026-11-01.aiosdata', '.backup-x.partial']
    for (const file of others) writeFileSync(join(h.dir, file), 'mine')
    for (let i = 1; i <= 4; i += 1) writeFileSync(join(h.dir, name(T0 - i * DAY)), 'old')
    expect(await h.service().runNow()).toEqual({ kind: 'done' })
    const names = readdirSync(h.dir).sort()
    expect(names).toEqual([...others, name(T0), name(T0 - DAY), name(T0 - 2 * DAY)].sort())
  })

  it('review 2: with three generations from the future (the clock went back), the one just written stays', async () => {
    const h = harness('future')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    const futures = [10, 11, 12].map((d) => name(T0 + d * DAY))
    for (const file of futures) writeFileSync(join(h.dir, file), 'future')
    const service = h.service()
    await service.refresh()
    expect(service.isDue()).toBe(true)
    await service.tick()
    const names = readdirSync(h.dir).sort()
    expect(names).toContain(name(T0))
    // The oldest of the futures went, the newest generation in the list is the one just written, and it is not due again.
    expect(names).toEqual([name(T0), name(T0 + 11 * DAY), name(T0 + 12 * DAY)].sort())
    expect(service.status().generations[0]?.fileName).toBe(name(T0))
    expect(service.status().lastFailure).toBeNull()
    expect(service.isDue(T0 + 60 * 60 * 1000 + 1)).toBe(false)
  })

  it('a failure midway leaves no partial file, keeps the generations, and records the reason', async () => {
    const h = harness('fail')
    h.passphrase.value = PASS
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(join(h.dir, name(T0 - DAY)), 'old')
    // The export dies after writing part of its output (a crash between write and rename is the same on disk).
    const failing = transferWith(h, {
      runExport: async (path): Promise<DataExportResult> => {
        writeFileSync(path, 'half')
        return { kind: 'failed', reason: 'io' }
      }
    })
    const service = h.service({ transfer: failing })
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'io' })
    expect(readdirSync(h.dir)).toEqual([name(T0 - DAY)])
    expect(h.records.failure).toEqual({ at: T0, reason: 'io' })
    expect(service.status().lastFailure).toEqual({ at: T0, reason: 'io' })
  })

  it('a partial left by an earlier crash is swept by the next success (only an old one of ours)', async () => {
    const h = harness('sweep')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    const old = partialFileName(T0 - 3 * 60 * 60 * 1000, OWNER, NONCE)
    const young = partialFileName(T0 - 60 * 1000, OWNER, NONCE)
    const theirs = partialFileName(T0 - 3 * 60 * 60 * 1000, OTHER, NONCE)
    for (const file of [old, young, theirs]) writeFileSync(join(h.dir, file), 'x')
    expect(await h.service().runNow()).toEqual({ kind: 'done' })
    expect(readdirSync(h.dir).sort()).toEqual([young, theirs, name(T0)].sort())
  })

  it('a chosen folder that does not exist is not created (dir-missing)', async () => {
    const h = harness('missing')
    h.passphrase.value = PASS
    const service = h.service()
    const chosen = join(root, 'missing', 'external')
    mkdirSync(chosen)
    expect(await service.setDir(chosen)).toEqual({ kind: 'done' })
    rmSync(chosen, { recursive: true })
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'dir-missing' })
    expect(existsSync(chosen)).toBe(false)
    // The choice is kept outside the DB (readable when the DB is not).
    expect(JSON.parse(readFileSync(join(h.userData, 'backup.json'), 'utf8'))).toEqual({ dir: chosen })
    expect(h.service().status()).toMatchObject({ dir: chosen, dirIsDefault: false })
  })
})

describe('BackupService: the partial file is created exclusively (review 9)', () => {
  it('writeNewFileDurably never follows or overwrites a symlink or a file at the path', async () => {
    const dir = join(root, 'exclusive')
    mkdirSync(dir, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'precious')
    const link = join(dir, 'link')
    symlinkSync(victim, link)
    await expect(writeNewFileDurably(link, new Uint8Array([1, 2, 3]))).rejects.toThrow()
    await expect(writeNewFileDurably(victim, new Uint8Array([1, 2, 3]))).rejects.toThrow()
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    const fresh = join(dir, 'fresh')
    await writeNewFileDurably(fresh, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(fresh)]).toEqual([1, 2, 3])
    expect((await stat(fresh)).mode & 0o777).toBe(0o600)
  })

  it('a symlink planted at the partial name is not followed, written through, or removed', async () => {
    const h = harness('planted')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    const victim = join(root, 'planted', 'victim.txt')
    writeFileSync(victim, 'precious')
    let planted = ''
    // Plant a symlink at the exact path the backup is about to create (the name is random, so this simulates a winning race).
    const racing = transferWith(h, {
      runExport: (path, passphrase, options) => {
        planted = path
        symlinkSync(victim, path)
        return h.transfer.runExport(path, passphrase, options)
      }
    })
    const service = h.service({ transfer: racing })
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'io' })
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(lstatSync(planted).isSymbolicLink()).toBe(true)
    expect(readdirSync(h.dir).filter((n) => n.startsWith('backup-'))).toEqual([])
  })

  it('the manual export still overwrites the file chosen in the save dialog', async () => {
    const h = harness('manual-export')
    seed(h)
    const target = join(root, 'manual-export', 'chosen.aiosdata')
    writeFileSync(target, 'an older export')
    expect(await h.transfer.runExport(target, PASS)).toMatchObject({ kind: 'done' })
    expect((await open(readFileSync(target), PASS)).toString('utf8')).toContain('バックアップのテスト')
  })
})

describe('BackupService: schedule', () => {
  it('runs only when due and idle (no conversation running, and the computer idle unless overdue)', async () => {
    const h = harness('schedule')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(join(h.dir, name(T0 - 2 * 60 * 60 * 1000)), 'recent')
    const service = h.service()
    // Not due: the newest is 2 hours old.
    await service.tick()
    expect(readdirSync(h.dir)).toHaveLength(1)
    // Due, but a conversation is running.
    h.now = T0 + DAY
    h.idle = false
    await service.tick()
    expect(readdirSync(h.dir)).toHaveLength(1)
    // Due, no conversation, but the user is typing (and it is not overdue).
    h.idle = true
    h.systemIdle = 5
    await service.tick()
    expect(readdirSync(h.dir)).toHaveLength(1)
    // Idle: runs.
    h.systemIdle = 600
    await service.tick()
    expect(readdirSync(h.dir)).toHaveLength(2)
  })

  it('overdue (2 days) runs even while the user is typing, but never during a conversation', async () => {
    const h = harness('overdue')
    h.passphrase.value = PASS
    seed(h)
    const service = h.service()
    h.systemIdle = 0
    h.idle = false
    await service.tick()
    expect(existsSync(h.dir)).toBe(false)
    h.idle = true
    await service.tick()
    expect(readdirSync(h.dir)).toHaveLength(1)
  })

  it('a failed attempt is retried after an hour, not at every tick', async () => {
    const h = harness('retry')
    h.passphrase.value = PASS
    let calls = 0
    const failing = transferWith(h, {
      runExport: async (): Promise<DataExportResult> => {
        calls += 1
        return { kind: 'failed', reason: 'too-large' }
      }
    })
    const service = h.service({ transfer: failing })
    await service.tick()
    h.now = T0 + 10 * 60 * 1000
    await service.tick()
    expect(calls).toBe(1)
    expect(h.records.failure).toEqual({ at: T0, reason: 'too-large' })
    h.now = T0 + 61 * 60 * 1000
    await service.tick()
    expect(calls).toBe(2)
  })

  it('review 7: a requested backup (new passphrase) stays due after busy and after a failure, until one is written', async () => {
    const h = harness('force-due')
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(join(h.dir, name(T0 - 60 * 60 * 1000)), 'recent')
    const service = h.service()
    await service.refresh()
    expect(service.setPassphrase(PASS)).toEqual({ kind: 'done' })
    // The user's own export holds the transfer: busy.
    let release: () => void = () => undefined
    const holding = h.transfer.exclusive(undefined, () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))))
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'busy' })
    release()
    await holding
    expect(service.isDue()).toBe(true)
    // A failure keeps it requested too (retried after the hour, not dropped).
    const failing = h.service({ transfer: transferWith(h, { runExport: async () => ({ kind: 'failed', reason: 'io' }) }) })
    await failing.refresh()
    failing.setPassphrase(PASS)
    expect(await failing.runNow()).toEqual({ kind: 'failed', reason: 'io' })
    expect(failing.isDue(T0 + 61 * 60 * 1000)).toBe(true)
    // Written: no longer due.
    expect(await service.runNow()).toEqual({ kind: 'done' })
    expect(service.isDue(T0 + 61 * 60 * 1000)).toBe(false)
  })
})

describe('BackupService: the light check of the DB (review 4)', () => {
  it('not right after startup; once the delay passes, at an idle tick; then at most once a day', async () => {
    const h = harness('check-daily')
    const service = h.service({ checkDelayMs: 15 * 60 * 1000 })
    await service.startHealthCheck()
    expect(h.checks).toBe(0)
    h.now = T0 + 5 * 60 * 1000
    await service.tick()
    expect(h.checks).toBe(0)
    // Past the delay, but the user is busy.
    h.now = T0 + 20 * 60 * 1000
    h.systemIdle = 5
    await service.tick()
    expect(h.checks).toBe(0)
    h.systemIdle = 600
    await service.tick()
    expect(h.checks).toBe(1)
    expect(service.status().health).toBe('ok')
    expect(JSON.parse(readFileSync(join(h.userData, 'db-check.json'), 'utf8'))).toEqual({ checkedAt: T0 + 20 * 60 * 1000, pending: false })
    // The next launch the same day does not check.
    h.now = T0 + 2 * 60 * 60 * 1000
    const next = h.service({ checkDelayMs: 0 })
    await next.startHealthCheck()
    await next.tick()
    expect(h.checks).toBe(1)
    // A day later it does (also in a launch that stays up).
    h.now = T0 + DAY + 30 * 60 * 1000
    await next.tick()
    expect(h.checks).toBe(2)
  })

  it('an unfinished check (crash or quit midway) or an unopenable DB makes the next launch check at once', async () => {
    const h = harness('check-urgent')
    const first = h.service()
    let release: (r: DbQuickCheckResult) => void = () => undefined
    h.check = () => new Promise((resolve) => (release = resolve))
    const running = first.checkHealth()
    // The launch dies here: the record says "pending".
    expect(JSON.parse(readFileSync(join(h.userData, 'db-check.json'), 'utf8'))).toMatchObject({ pending: true })
    release({ ...OK_CHECK, ok: false, stopped: true })
    await running
    h.check = async () => OK_CHECK
    const second = h.service()
    await second.startHealthCheck()
    expect(h.checks).toBe(2)
    expect(second.status().health).toBe('ok')
    // A DB that could not be opened: the launch after it checks at once as well.
    h.service({ initialHealth: 'unopenable' })
    const third = h.service()
    await third.startHealthCheck()
    expect(h.checks).toBe(3)
  })

  it('damage found keeps the next launch checking at once', async () => {
    const h = harness('check-damage')
    h.check = async () => ({ ...OK_CHECK, ok: false, damaged: ['thread_events'] })
    await h.service().checkHealth()
    h.check = async () => OK_CHECK
    await h.service().startHealthCheck()
    expect(h.checks).toBe(2)
  })
})

describe('BackupService: damaged DB and restore', () => {
  it('a damaged DB stops backups and offers the newest backup', async () => {
    const h = harness('corrupt')
    h.passphrase.value = PASS
    seed(h)
    const service = h.service()
    expect(await service.runNow()).toEqual({ kind: 'done' })
    h.check = async () => ({ ...OK_CHECK, ok: false, damaged: ['thread_events'] })
    await service.checkHealth()
    expect(service.status().health).toBe('corrupt')
    h.now = T0 + 3 * DAY
    await service.tick()
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'unhealthy' })
    expect(readdirSync(h.dir)).toEqual([name(T0)])
  })

  it('a check stopped for shutdown is not a verdict', async () => {
    const h = harness('stopped')
    h.check = async () => ({ ...OK_CHECK, ok: false, stopped: true })
    const service = h.service()
    await service.checkHealth()
    expect(service.status().health).toBe('unknown')
  })

  it('restore is offered only when broken; the passphrase is checked before anything is written', async () => {
    const h = harness('prepare')
    h.passphrase.value = PASS
    seed(h)
    const service = h.service()
    await service.runNow()
    expect(await service.prepareRestore(null)).toEqual({ ok: false, reason: 'not-broken' })
    h.check = async () => ({ ...OK_CHECK, ok: false, damaged: ['threads'] })
    await service.checkHealth()
    expect(await service.prepareRestore('wrong passphrase')).toEqual({ ok: false, reason: 'decrypt-failed' })
    h.passphrase.value = null
    expect(await service.prepareRestore(null)).toEqual({ ok: false, reason: 'passphrase-needed' })
    // A stored passphrase that does not open the newest (changed afterwards, or a lost keychain item) also asks.
    h.passphrase.value = 'a different passphrase'
    expect(await service.prepareRestore(null)).toEqual({ ok: false, reason: 'passphrase-needed' })
    const prepared = await service.prepareRestore(PASS)
    expect(prepared).toMatchObject({ ok: true, value: { fileName: name(T0), fromUser: true } })
    expect(readRestoreMarker(h.userData)).toBeNull()
  })

  it('a DB that could not be opened with no backup has nothing to restore', async () => {
    const h = harness('nobackup')
    const service = h.service({ initialHealth: 'unopenable' })
    expect(await service.prepareRestore(PASS)).toEqual({ ok: false, reason: 'no-backup' })
    // An in-memory DB is never backed up (it would rotate out the good generations).
    h.passphrase.value = PASS
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'unhealthy' })
  })

  it('review 5: a passphrase typed for the restore is used for the import only; the remembered one is not changed', async () => {
    const h = harness('typed')
    h.passphrase.value = PASS
    seed(h, '戻るはずのスレッド')
    await h.service().runNow()
    // Later the remembered passphrase was changed (the newest backup opens only with the old one), then the DB broke.
    h.passphrase.value = 'the newer remembered passphrase'
    const broken = h.service({ initialHealth: 'unopenable' })
    expect(await broken.prepareRestore(null)).toEqual({ ok: false, reason: 'passphrase-needed' })
    const prepared = await broken.prepareRestore(PASS)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(broken.commitRestore(prepared.value)).toEqual({ kind: 'done' })
    expect(h.passphrase.value).toBe('the newer remembered passphrase')
    expect(h.restorePassphrase.value).toBe(PASS)
    writeFileSync(join(h.userData, 'aios.db'), 'aios.db')
    const pending = takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY)
    if (pending === null) throw new Error('no pending restore')
    // After the restart, in the fresh DB (the same userData, so the same owner id and the same sealed passphrase).
    const fresh = harness('typed-fresh')
    const service = h.service({ transfer: fresh.transfer })
    await service.importPending(pending)
    expect(service.status().restore).toMatchObject({ kind: 'restored', threads: 1 })
    expect(fresh.store.listThreads().map((t) => t.title)).toEqual(['戻るはずのスレッド'])
    expect(h.passphrase.value).toBe('the newer remembered passphrase')
    expect(h.restorePassphrase.value).toBeNull()
    expect(readRestoreMarker(h.userData)).toBeNull()
  })

  it('across a restart: marker -> the broken files are moved aside (not deleted) -> import into a fresh DB', async () => {
    const h = harness('restore')
    h.passphrase.value = PASS
    seed(h, '戻るはずのスレッド')
    const before = h.service()
    await before.runNow()
    // The DB could not be opened because its key is unreadable: the restore also moves db.key aside.
    const broken = h.service({ initialHealth: 'unopenable', keyUnreadable: true })
    const prepared = await broken.prepareRestore('')
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(broken.commitRestore(prepared.value)).toEqual({ kind: 'done' })
    expect(readRestoreMarker(h.userData)).toMatchObject({ phase: 'move', moveKey: true })

    // Next launch, before the DB is opened.
    for (const file of ['aios.db', 'aios.db-wal', 'db.key', 'credentials.json']) writeFileSync(join(h.userData, file), file)
    const pending = takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY)
    expect(pending).toMatchObject({ file: join(h.dir, name(T0)), moveKey: true, interrupted: false })
    const after = readdirSync(h.userData).sort()
    expect(after).toContain('credentials.json')
    expect(after).not.toContain('aios.db')
    expect(after).not.toContain('db.key')
    expect(after.filter((n) => n.includes('.broken-')).sort()).toEqual(
      ['aios.db.broken-20261123T030000Z', 'aios.db.broken-20261123T030000Z-wal', 'db.key.broken-20261123T030000Z'].sort()
    )
    expect(readFileSync(join(h.userData, 'aios.db.broken-20261123T030000Z'), 'utf8')).toBe('aios.db')
    expect(readRestoreMarker(h.userData)).toMatchObject({ phase: 'import' })
    // A crash before the import: the next launch does not move again (the fresh DB stays), it only imports.
    expect(takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY + 1)).toEqual(pending)

    // After the services are up: the import into the fresh DB.
    const fresh = harness('fresh')
    const service = h.service({ transfer: fresh.transfer })
    await service.importPending(pending!)
    expect(readRestoreMarker(h.userData)).toBeNull()
    expect(service.status().restore).toMatchObject({ kind: 'restored', threads: 1, events: 2 })
    expect(fresh.store.listThreads().map((t) => t.title)).toEqual(['戻るはずのスレッド'])
  })

  it('review 1: the DB is not moved aside when the backup file is gone', async () => {
    const h = harness('restore-gone')
    h.passphrase.value = PASS
    seed(h)
    await h.service().runNow()
    const broken = h.service({ initialHealth: 'unopenable' })
    const prepared = await broken.prepareRestore(null)
    if (!prepared.ok) throw new Error(prepared.reason)
    broken.commitRestore(prepared.value)
    rmSync(prepared.value.file)
    writeFileSync(join(h.userData, 'aios.db'), 'aios.db')
    expect(takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY)).toBeNull()
    expect(readFileSync(join(h.userData, 'aios.db'), 'utf8')).toBe('aios.db')
    expect(readRestoreMarker(h.userData)).toBeNull()
  })

  it('review 1: an import that fails or is interrupted stops backups and rotation until restored or kept', async () => {
    const h = harness('restore-fail')
    h.passphrase.value = PASS
    seed(h)
    mkdirSync(h.dir, { recursive: true })
    for (let i = 1; i <= 2; i += 1) writeFileSync(join(h.dir, name(T0 - i * DAY)), 'older')
    await h.service().runNow()
    const good = readdirSync(h.dir).sort()
    expect(good).toHaveLength(3)
    const broken = h.service({ initialHealth: 'unopenable' })
    const prepared = await broken.prepareRestore(null)
    if (!prepared.ok) throw new Error(prepared.reason)
    broken.commitRestore(prepared.value)
    writeFileSync(join(h.userData, 'aios.db'), 'aios.db')
    const pending = takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY)
    if (pending === null) throw new Error('no pending restore')

    // The import dies midway (the fresh DB may hold part of it).
    h.now = T0 + 3 * DAY
    let imports = 0
    const dying = transferWith(h, {
      runImport: async (): Promise<DataImportResult> => {
        imports += 1
        expect(readRestoreMarker(h.userData)).toMatchObject({ phase: 'importing' })
        return { kind: 'failed', reason: 'io' }
      }
    })
    const failed = h.service({ transfer: dying })
    await failed.importPending(pending)
    expect(imports).toBe(1)
    expect(failed.status()).toMatchObject({ health: 'restore-incomplete', restore: { kind: 'failed', reason: 'io' } })
    expect(readRestoreMarker(h.userData)).toMatchObject({ phase: 'importing' })
    await failed.tick()
    expect(await failed.runNow()).toEqual({ kind: 'failed', reason: 'unhealthy' })
    expect(readdirSync(h.dir).sort()).toEqual(good)

    // The next launch: not imported again, still stopped, and "restore again" is offered.
    const interrupted = takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + 4 * DAY)
    expect(interrupted).toMatchObject({ interrupted: true })
    expect(existsSync(join(h.userData, 'aios.db.broken-20261126T030000Z'))).toBe(false)
    const relaunched = h.service({ transfer: dying })
    relaunched.start()
    await relaunched.importPending(interrupted!)
    expect(imports).toBe(1)
    expect(relaunched.status()).toMatchObject({ health: 'restore-incomplete', restore: { kind: 'failed', reason: 'interrupted' } })
    await relaunched.startHealthCheck()
    await relaunched.tick()
    expect(readdirSync(h.dir).sort()).toEqual(good)
    expect(await relaunched.prepareRestore(null)).toMatchObject({ ok: true })

    // Keeping the current DB removes the marker and lets backups resume (after the check).
    expect(relaunched.keepCurrent()).toEqual({ kind: 'done' })
    expect(readRestoreMarker(h.userData)).toBeNull()
    expect(relaunched.status()).toMatchObject({ health: 'unknown', restore: null })
    await relaunched.tick()
    expect(relaunched.status().health).toBe('ok')
    await relaunched.tick()
    expect(readdirSync(h.dir)).toContain(name(T0 + 3 * DAY))
    await relaunched.stop()
  })

  it('restoring again after an interrupted import moves the half-filled DB aside first', async () => {
    const h = harness('restore-again')
    h.passphrase.value = PASS
    seed(h)
    await h.service().runNow()
    const file = join(h.dir, name(T0))
    writeRestoreMarker(h.userData, { version: 1, file, moveKey: false, phase: 'importing', createdAt: T0 })
    const service = h.service()
    await service.importPending({ file, moveKey: false, createdAt: T0, interrupted: true })
    const prepared = await service.prepareRestore(null)
    if (!prepared.ok) throw new Error(prepared.reason)
    expect(service.commitRestore(prepared.value)).toEqual({ kind: 'done' })
    writeFileSync(join(h.userData, 'aios.db'), 'half')
    expect(takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' }, T0 + DAY)).toMatchObject({ interrupted: false })
    expect(readFileSync(join(h.userData, 'aios.db.broken-20261123T030000Z'), 'utf8')).toBe('half')
  })

  it('a marker that is broken or points outside our names is ignored and removed', () => {
    const h = harness('marker')
    writeFileSync(join(h.userData, 'backup-restore.json'), JSON.stringify({ version: 1, file: '/etc/passwd', moveKey: false, phase: 'move', createdAt: 1 }))
    writeFileSync(join(h.userData, RESTORE_PASSPHRASE_FILE), 'sealed')
    writeFileSync(join(h.userData, 'aios.db'), 'db')
    expect(takePendingRestore(h.userData, { dbFile: 'aios.db', keyFile: 'db.key' })).toBeNull()
    expect(existsSync(join(h.userData, 'aios.db'))).toBe(true)
    expect(existsSync(join(h.userData, 'backup-restore.json'))).toBe(false)
    expect(existsSync(join(h.userData, RESTORE_PASSPHRASE_FILE))).toBe(false)
  })
})

describe('BackupService: shutdown (12.9)', () => {
  it('stop() stops the transfer, waits for the running backup, and writes nothing afterwards', async () => {
    const h = harness('shutdown')
    h.passphrase.value = PASS
    let release: (result: DataExportResult) => void = () => undefined
    let transferStopped = 0
    const slow = transferWith(h, {
      runExport: (path) =>
        new Promise<DataExportResult>((resolve) => {
          writeFileSync(path, 'half')
          release = resolve
        }),
      stop: async () => {
        transferStopped += 1
        // DataTransfer leaves at a boundary and returns `io` without writing the file.
        release({ kind: 'failed', reason: 'io' })
      }
    })
    const service = h.service({ transfer: slow })
    const running = service.runNow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.status().running).toBe(true)
    let stopped = false
    const stopping = service.stop().then(() => {
      stopped = true
    })
    await stopping
    expect(stopped).toBe(true)
    expect(transferStopped).toBe(1)
    expect(await running).toEqual({ kind: 'failed', reason: 'io' })
    // No record written after shutdown began, no partial left.
    expect(h.records.writes).toBe(0)
    expect(readdirSync(h.dir)).toEqual([])
    // Nothing starts afterwards.
    expect(await service.runNow()).toEqual({ kind: 'failed', reason: 'io' })
    await service.tick()
    expect(service.setPassphrase('another passphrase')).toEqual({ kind: 'failed', reason: 'io' })
    service.dismissNotice()
    expect(h.records.writes).toBe(0)
  })

  it('stop() with nothing running returns at once and cancels the timers', async () => {
    const h = harness('idle-stop')
    h.passphrase.value = PASS
    const service = h.service({ firstDelayMs: 10, tickMs: 10 })
    service.start()
    await service.stop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(existsSync(h.dir)).toBe(false)
  })
})
