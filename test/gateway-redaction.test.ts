/**
 * Regression for the exclusion of credential locations, and for the redaction of the body passed to the gateway (TODO 855).
 *
 * 1. Credential locations that were added (`~/.config/gcloud/…` etc.) do not enter the index.
 * 2. `*.env` appears in name searches, but its body is not indexed (even if chunks that entered earlier remain, the body is not shown).
 * 3. Redaction applies to the bodies of the gateway's (forAgent) search snippets, getDocument, getDocumentText, and getChunk. The position fields stay in the coordinates of the canonical copy before masking. It is not applied to the screen (not forAgent).
 *
 * Real SQLite (in memory) and the real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}`
const DEPLOY = `# deploy\n\nthe deployneedle step uses token: ${GH_TOKEN} for the push.\n`

let root: string
let db: Db
let store: IndexStore
let fs: FsIndexer
let index: IndexService

beforeAll(async () => {
  root = makeTestDir('gateway-redaction')
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'deploy.md'), DEPLOY)
  writeFileSync(join(root, 'notes', 'prod.env'), 'envneedle=1\nAPI_TOKEN=abcdefabcdef\n')
  mkdirSync(join(root, '.config', 'gcloud'), { recursive: true })
  writeFileSync(
    join(root, '.config', 'gcloud', 'application_default_credentials.json'),
    '{"refresh_token": "adcneedle"}\n'
  )
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new IndexStore(db)
  fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
  index = new IndexService({
    db,
    store,
    conversation: { readEventText: async () => null, threadTitle: async () => null },
    transcripts: null,
    fsRules: () => fs.exclusionRules,
    onStatus: () => {}
  })
  await fs.scan()
  await index.build()
})

afterAll(async () => {
  await index.stop()
  await fs.stop()
  if (db.open) db.close()
  removeTestDir(root)
})

const rowOf = (name: string): { id: number; index_state: string } | undefined =>
  db
    .prepare(`SELECT id, index_state FROM documents WHERE source = 'fs' AND name = ?`)
    .get(name) as { id: number; index_state: string } | undefined

describe('資格情報の置き場と *.env (TODO 855)', () => {
  it('足した資格情報の置き場は索引に入らない', async () => {
    expect(rowOf('application_default_credentials.json')).toBeUndefined()
    expect((await index.search('adcneedle', 'files', { forAgent: true })).hits).toHaveLength(0)
  })

  it('*.env は名前の検索に出るが、本文は索引しない', async () => {
    expect(rowOf('prod.env')?.index_state).toBe('skipped')
    expect((await fs.searchFiles('prod.env')).entries.map((entry) => entry.name)).toContain('prod.env')
    expect((await index.search('envneedle', 'files', {})).hits).toHaveLength(0)
    const id = String(rowOf('prod.env')?.id)
    expect(await index.getDocumentText(id, 0, 100, true)).toBeNull()
  })
})

describe('gateway に渡す本文の redaction (TODO 855)', () => {
  const docId = (): string => String(rowOf('deploy.md')?.id)

  it('search の snippet: gateway には伏せ字、画面にはそのまま', async () => {
    const agent = await index.search('deployneedle', 'files', { forAgent: true })
    expect(agent.hits).toHaveLength(1)
    expect(agent.hits[0]?.snippet).toContain('[redacted]')
    expect(agent.hits[0]?.snippet).not.toContain(GH_TOKEN)
    const ui = await index.search('deployneedle', 'files', {})
    expect(ui.hits[0]?.snippet).toContain(GH_TOKEN)
  })

  it('getDocumentText: 本文は伏せ字、位置の欄は正本の座標のまま', async () => {
    const size = statSync(join(root, 'notes', 'deploy.md')).size
    const agent = (await index.getDocumentText(docId(), 0, 4096, true)) as Record<string, unknown>
    expect(agent['text']).not.toContain(GH_TOKEN)
    expect(agent['text']).toContain('token: [redacted]')
    expect(agent['redacted']).toBe(true)
    expect(agent['offset']).toBe(0)
    expect(agent['bytes']).toBe(size)
    expect(agent['total_bytes']).toBe(size)
    expect(agent['next_offset']).toBeNull()
    const ui = (await index.getDocumentText(docId(), 0, 4096, false)) as Record<string, unknown>
    expect(ui['text']).toBe(DEPLOY)
    expect(ui['redacted']).toBeUndefined()
  })

  it('getDocument / getChunk も gateway には伏せ字', async () => {
    const doc = (await index.getDocument(docId(), 4096, true)) as Record<string, unknown>
    expect(doc['text']).not.toContain(GH_TOKEN)
    expect(doc['bytes']).toBe(Buffer.byteLength(DEPLOY))
    expect(doc['has_more']).toBe(false)
    const chunkId = (
      db.prepare(`SELECT id FROM chunks WHERE document_id = ? LIMIT 1`).get(Number(docId())) as {
        id: number
      }
    ).id
    const chunk = (await index.getChunk(String(chunkId), true)) as Record<string, unknown>
    expect(chunk['text']).not.toContain(GH_TOKEN)
    expect(chunk['text']).toContain('[redacted]')
    const uiChunk = (await index.getChunk(String(chunkId), false)) as Record<string, unknown>
    expect(uiChunk['text']).toContain(GH_TOKEN)
  })

  it('伏せるものが無ければ redacted を付けない', async () => {
    writeFileSync(join(root, 'notes', 'plain.md'), 'nothing secret here plainneedle\n')
    await fs.enqueueChanges([{ type: 'create', path: join(root, 'notes', 'plain.md') }])
    await index.build()
    const id = String(rowOf('plain.md')?.id)
    const agent = (await index.getDocumentText(id, 0, 4096, true)) as Record<string, unknown>
    expect(agent['text']).toBe('nothing secret here plainneedle\n')
    expect('redacted' in agent).toBe(false)
  })
})
