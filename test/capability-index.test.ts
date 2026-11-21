/**
 * The index capability (the `index` row of ARCHITECTURE.md 7.7, the single writer of 6.2).
 *
 * By the user's judgment (12.9), Phase 4 made **only the entry point and tests**;
 * real use comes from plugins in Phase 5. Three points are pinned down here:
 *
 *  1. It can only write to the source it declared (namespace)
 *  2. A submitted document can actually be searched (it is on IndexService's queue)
 *  3. The canonical copy of the body is only in `plugin_documents`, and `documents` does not hold it
 *     (constraint 9 / 6.5)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { IndexService } from '../src/index-kernel/service.js'
import { IndexStore } from '../src/index-kernel/store.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import { makeTestDir, testExclusions } from './helpers/tmp.js'

let dbDir: string
let db: Db
let broker: CapabilityBroker
let audit: AuditLog
let index: IndexService
/** Automatic security review of wave 87: an id while the previous document is being deleted. */
const clearing = new Set<string>()

const policy: PluginPolicy = {
  id: 'test.mail',
  declared: {
    credentials: [],
    networkHosts: [],
    fsRead: [],
    fsWrite: [],
    indexSources: ['test.mail:inbox'],
    ui: false
  },
  consented: new Set<CapabilityName>(['index'])
}

/**
 * TODO 920: even with a declaration assembled without manifest validation (in case of a loophole), the Broker refuses anything outside the namespace.
 * A plugin whose body "declares" the built-in source and another plugin's source.
 */
const intruder: PluginPolicy = {
  id: 'test.intruder',
  declared: {
    credentials: [],
    networkHosts: [],
    fsRead: [],
    fsWrite: [],
    indexSources: ['conversation', 'transcript', 'fs', 'test.mail:inbox', 'test.intruderx', 'test.intruder:own'],
    ui: false
  },
  consented: new Set<CapabilityName>(['index'])
}

beforeAll(() => {
  dbDir = makeTestDir('idx-db')
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'e'.repeat(64)}'`)
  runMigrations(db)

  const store = new IndexStore(db)
  const pluginDocuments = new PluginDocumentStore(db)
  index = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    // P1: the index process only asks the canonical copy through a reverse RPC (3.4). Main is the one that writes the canonical copy.
    plugins: { read: async (source, sourceId) => pluginDocuments.read(source, sourceId) },
    onStatus: () => undefined
  })

  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules: testExclusions(homedir()) },
    audit,
    credentials: new CredentialStore(dbDir, {
      available: () => false,
      seal: () => Buffer.alloc(0),
      open: () => ''
    }),
    policyOf: (id) => (id === 'test.mail' ? policy : id === 'test.intruder' ? intruder : null),
    indexClearing: (id) => clearing.has(id),
    index: {
      // **Canonical copy first, index after** (6.5). Main keeps the order that was split apart in P1 (3.4).
      put: async (document) => {
        const updatedAt = document.updatedAt ?? Date.now()
        pluginDocuments.put({ ...document, updatedAt })
        await index.putPluginDocument({ ...document, updatedAt })
      },
      remove: async (source, sourceId) => {
        await index.removePluginDocument(source, sourceId)
        pluginDocuments.remove(source, sourceId)
      }
    },
    notify: () => undefined
  })
})

afterAll(() => {
  // The audit log has a 16 ms batch. If the DB is closed without discarding it, a leftover timer
  // fires after close and fails with "The database connection is not open".
  audit.dispose()
  db.close()
  rmSync(dbDir, { recursive: true, force: true })
})

const put = (document: Record<string, unknown>): Promise<unknown> =>
  broker.handle('test.mail', { capability: 'index', op: 'put', document: document as never })

describe('index 能力', () => {
  it('宣言した source にだけ書ける', async () => {
    await expect(
      put({
        source: 'other-source',
        sourceId: '1',
        title: 'x',
        uri: 'other://1',
        body: 'x'
      })
    ).rejects.toThrow('namespace')
  })

  it('投入した文書が検索できる (日本語も分かち書きされる)', async () => {
    await put({
      source: 'test.mail:inbox',
      sourceId: 'msg-1',
      title: '請求書の件',
      uri: 'test-mail://msg-1',
      body: '来月の請求書について打ち合わせをお願いします。形態素解析の話も少し。',
      updatedAt: 1_700_000_000_000
    })

    const response = await index.search('請求書', 'files', { limit: 10 })
    const hit = response.hits.find((h) => h.uri === 'test-mail://msg-1')
    expect(hit).toBeDefined()
    expect(hit?.title).toBe('請求書の件')
    // Snippets are cut **from the canonical copy** (6.5). No stand-in made by word segmentation is produced.
    expect(hit?.snippet).toContain('請求書')
  })

  it('本文の正本は plugin_documents だけで、documents は本文を持たない (制約 9)', () => {
    const row = db
      .prepare(`SELECT body FROM plugin_documents WHERE source = ? AND source_id = ?`)
      .get('test.mail:inbox', 'msg-1') as { body: string } | undefined
    expect(row?.body).toContain('請求書')

    const columns = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).not.toContain('body')
  })

  it('remove で正本も索引も消える (tombstone、6.5)', async () => {
    await broker.handle('test.mail', {
      capability: 'index',
      op: 'remove',
      source: 'test.mail:inbox',
      sourceId: 'msg-1'
    })

    const row = db
      .prepare(`SELECT body FROM plugin_documents WHERE source = ? AND source_id = ?`)
      .get('test.mail:inbox', 'msg-1')
    expect(row).toBeUndefined()

    const response = await index.search('請求書', 'files', { limit: 10 })
    expect(response.hits.find((h) => h.uri === 'test-mail://msg-1')).toBeUndefined()
  })

  it('宣言していない source は remove もできない', async () => {
    await expect(
      broker.handle('test.mail', {
        capability: 'index',
        op: 'remove',
        source: 'conversation',
        sourceId: 'x'
      })
    ).rejects.toThrow('namespace')
  })

  it('**TODO 920: 宣言していても組み込み・他の plugin の source には put も remove もできない**', async () => {
    const calls: string[] = []
    for (const source of ['conversation', 'transcript', 'fs', 'test.mail:inbox', 'test.intruderx']) {
      await expect(
        broker.handle('test.intruder', { capability: 'index', op: 'remove', source, sourceId: 'x' })
      ).rejects.toThrow('namespace')
      await expect(
        broker.handle('test.intruder', {
          capability: 'index',
          op: 'put',
          document: { source, sourceId: 'x', title: 'x', uri: 'x://1', body: 'x' } as never
        })
      ).rejects.toThrow('namespace')
      calls.push(source)
    }
    expect(calls).toHaveLength(5)
    // Writing to its own namespace is allowed.
    await expect(
      broker.handle('test.intruder', {
        capability: 'index',
        op: 'remove',
        source: 'test.intruder:own',
        sourceId: 'x'
      })
    ).resolves.toEqual({ ok: true })
  })

  it('第 87 波 自動セキュリティレビュー: 前の文書を消している間は put も remove も index-clearing で断り、終われば通る', async () => {
    clearing.add('test.mail')
    try {
      await expect(
        put({ source: 'test.mail:inbox', sourceId: 'c-1', title: 'x', uri: 'test-mail://c-1', body: 'x' })
      ).rejects.toThrow('index-clearing')
      await expect(
        broker.handle('test.mail', { capability: 'index', op: 'remove', source: 'test.mail:inbox', sourceId: 'c-1' })
      ).rejects.toThrow('index-clearing')
    } finally {
      clearing.delete('test.mail')
    }
    await expect(
      broker.handle('test.mail', { capability: 'index', op: 'remove', source: 'test.mail:inbox', sourceId: 'c-1' })
    ).resolves.toEqual({ ok: true })
  })
})
