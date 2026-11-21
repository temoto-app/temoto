/**
 * TODO 1280: an extension reads only its own documents by uri (`Broker.readOwnDocument`, reached through `ViewerBroker.read` for a row of its sidebar list).
 * The owner is decided by the caller id main knows and an exact namespace match; other extensions, `file:` / `thread:`, disabled and unconsented extensions are refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { PluginDocumentStore } from '../src/main/capability/plugin-store.js'
import { MAX_TEXT_BYTES, ViewerBroker, utf8Prefix } from '../src/main/capability/viewer.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

let dbDir: string
let db: Db
let audit: AuditLog
let broker: CapabilityBroker
let viewer: ViewerBroker
let store: PluginDocumentStore
let cal: PluginPolicy | null
let clearing = false

const policy = (id: string, sources: string[], granted: Set<CapabilityName>): PluginPolicy => ({
  id,
  declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: sources, ui: false },
  consented: granted
})
const OTHER = policy('test.cal2', ['test.cal2'], new Set<CapabilityName>(['index']))

beforeAll(() => {
  dbDir = makeTestDir('own-doc')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'o'.repeat(64)}'`)
  runMigrations(db)
  store = new PluginDocumentStore(db)
  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules: testExclusions(homedir()) },
    audit,
    credentials: new CredentialStore(dbDir, { available: () => false, seal: () => Buffer.alloc(0), open: () => '' }),
    policyOf: (id) => (id === 'test.cal' ? cal : id === 'test.cal2' ? OTHER : null),
    indexClearing: () => clearing,
    documents: store,
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
  viewer = new ViewerBroker({
    broker,
    audit,
    scope: { rules: testExclusions(homedir()) },
    resolveViewer: (uri) =>
      uri.startsWith('cal:') || uri.startsWith('thread:')
        ? { pluginId: 'test.cal', name: 'cal', url: 'aios-plugin://test.cal/v.html', editable: false, delivery: 'text' }
        : null
  })
})

beforeEach(() => {
  cal = policy('test.cal', ['test.cal:events'], new Set<CapabilityName>(['index']))
  clearing = false
  db.exec('DELETE FROM plugin_documents')
  store.put({ source: 'test.cal:events', sourceId: '1', title: 'Standup', uri: 'cal://event/1', body: 'daily at 10', updatedAt: 5 })
  // Another extension's document with the same uri, and one in a prefix-sharing id (`test.cal2` must not enter `test.cal`'s namespace).
  store.put({ source: 'test.cal2', sourceId: '1', title: 'Theirs', uri: 'cal://event/2', body: 'secret of cal2', updatedAt: 6 })
  store.put({ source: 'test.cal2', sourceId: '9', title: 'Same uri', uri: 'cal://event/9', body: 'cal2 body', updatedAt: 6 })
})

afterAll(() => {
  audit.dispose()
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

describe('readOwnDocument', () => {
  it('reads its own document by uri', async () => {
    expect(await broker.readOwnDocument('test.cal', 'cal://event/1')).toEqual({ title: 'Standup', text: 'daily at 10', updatedAt: 5 })
  })

  it('never returns another extension\'s document (exact namespace, not a prefix)', async () => {
    await expect(broker.readOwnDocument('test.cal', 'cal://event/2')).rejects.toMatchObject({ reason: 'not-found' })
    await expect(broker.readOwnDocument('test.cal2', 'cal://event/1')).rejects.toMatchObject({ reason: 'not-found' })
    expect(await broker.readOwnDocument('test.cal2', 'cal://event/9')).toMatchObject({ text: 'cal2 body' })
  })

  it('prefers its own document when another extension holds the same uri', async () => {
    store.put({ source: 'test.cal2', sourceId: '7', title: 'Dup', uri: 'cal://event/1', body: 'not yours', updatedAt: 1 })
    expect(await broker.readOwnDocument('test.cal', 'cal://event/1')).toMatchObject({ text: 'daily at 10' })
  })

  it('refuses file:, thread: and non-uri strings before touching the store', async () => {
    for (const uri of ['file:///etc/hosts', 'FILE:///etc/hosts', 'thread://abc', 'plain', '', 'x'.repeat(9000)]) {
      await expect(broker.readOwnDocument('test.cal', uri)).rejects.toMatchObject({ reason: 'invalid-uri' })
    }
  })

  it('refuses an unknown / disabled extension, a missing consent, and a source it did not declare', async () => {
    await expect(broker.readOwnDocument('test.nobody', 'cal://event/1')).rejects.toMatchObject({ reason: 'unknown-plugin' })
    cal = null
    await expect(broker.readOwnDocument('test.cal', 'cal://event/1')).rejects.toMatchObject({ reason: 'unknown-plugin' })
    cal = policy('test.cal', ['test.cal:events'], new Set<CapabilityName>())
    await expect(broker.readOwnDocument('test.cal', 'cal://event/1')).rejects.toMatchObject({ reason: 'not-consented' })
    cal = policy('test.cal', ['test.cal:other'], new Set<CapabilityName>(['index']))
    await expect(broker.readOwnDocument('test.cal', 'cal://event/1')).rejects.toMatchObject({ reason: 'namespace' })
  })

  it('refuses while the extension\'s old documents are being deleted', async () => {
    clearing = true
    await expect(broker.readOwnDocument('test.cal', 'cal://event/1')).rejects.toMatchObject({ reason: 'index-clearing' })
  })

  it('audits allow and deny with the uri only, never the body', async () => {
    audit.flush()
    db.exec('DELETE FROM audit_log')
    await broker.readOwnDocument('test.cal', 'cal://event/1')
    await broker.readOwnDocument('test.cal', 'cal://event/2').catch(() => undefined)
    audit.flush()
    const rows = db.prepare(`SELECT * FROM audit_log WHERE op = 'readDocument' ORDER BY id`).all() as Record<string, unknown>[]
    expect(rows.map((row) => [row['plugin_id'], row['target'], row['decision'], row['reason']])).toEqual([
      ['test.cal', 'cal://event/1', 'allow', null],
      ['test.cal', 'cal://event/2', 'deny', 'not-found']
    ])
    expect(JSON.stringify(rows)).not.toContain('daily at 10')
  })
})

describe('readByUri (review)', () => {
  it('with several own rows on one uri, the most recently updated wins, and a bad suffix is not owned', () => {
    store.put({ source: 'test.cal:events', sourceId: '2', title: 'Newer', uri: 'cal://dup', body: 'new', updatedAt: 9 })
    store.put({ source: 'test.cal:other', sourceId: '3', title: 'Older', uri: 'cal://dup', body: 'old', updatedAt: 3 })
    store.put({ source: 'test.cal:Bad Suffix', sourceId: '4', title: 'Bad', uri: 'cal://dup', body: 'bad', updatedAt: 99 })
    expect(store.readByUri('test.cal', 'cal://dup')).toMatchObject({ title: 'Newer', body: 'new', updatedAt: 9 })
    expect(store.readByUri('test.cal2', 'cal://dup')).toBeNull()
  })
})

describe('utf8Prefix (review)', () => {
  it('cuts on a character boundary, never leaving U+FFFD', () => {
    const text = 'a' + 'あ'.repeat(10)
    const bytes = Buffer.from(text, 'utf8')
    for (let max = 1; max < bytes.byteLength; max += 1) {
      const out = utf8Prefix(bytes, max)
      expect(out).not.toContain('\uFFFD')
      expect(text.startsWith(out)).toBe(true)
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max)
      expect(Buffer.byteLength(out)).toBeGreaterThan(max - 3)
    }
    expect(utf8Prefix(bytes, 1000)).toBe(text)
  })

  it('a large document of multi-byte text is truncated without a replacement character', async () => {
    store.put({ source: 'test.cal:events', sourceId: 'big', title: 'Big', uri: 'cal://big', body: 'あ'.repeat(MAX_TEXT_BYTES), updatedAt: 1 })
    const resource = await viewer.read('test.cal', 'cal://big')
    expect(resource).toMatchObject({ kind: 'text', truncated: true })
    expect((resource as { text: string }).text).not.toContain('\uFFFD')
  })
})

describe('ViewerBroker for a document uri', () => {
  it('opens and reads a row of its own list, read-only', async () => {
    expect(viewer.open('cal://event/1')?.pluginId).toBe('test.cal')
    expect(await viewer.read('test.cal', 'cal://event/1')).toMatchObject({ kind: 'text', text: 'daily at 10', readOnly: true, mtimeMs: 5 })
  })

  it('does not let another plugin id read it, and turns a refusal into an error resource', async () => {
    expect(await viewer.read('test.cal2', 'cal://event/1')).toEqual({ kind: 'error', message: 'not allowed' })
    expect(await viewer.read('test.cal', 'cal://event/2')).toEqual({ kind: 'error', message: 'not-found' })
  })

  it('thread: never reaches the store even if a viewer claims it', async () => {
    expect(await viewer.read('test.cal', 'thread://abc')).toEqual({ kind: 'error', message: 'invalid-uri' })
  })
})
