/**
 * TODO 772 (wave 36 bundle B): saving the viewer's ← → history (main side, migration 28).
 *
 * - `sanitizeViewerHistory`: drops steps for exclusions, secrets, `about:blank`, and other schemes, cuts at 50 steps, and keeps `index` within the remaining steps.
 * - `ViewerHistoryService`: write, read, and delete the row if it is empty. Does nothing without a conversation. It is removed together with the 3-minute physical delete (526).
 *
 * The DB is a real in-memory one (with migrations). Neither the model nor electron is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import {
  ViewerHistoryService,
  parseStoredHistory,
  sanitizeViewerHistory
} from '../src/main/session/viewer-history.js'

const fs = {
  isReferenceable: (path: string): boolean => !path.includes('/excluded/'),
  isViewable: (path: string): boolean => !path.includes('/excluded/')
}
const file = (name: string): string => `file:///Users/tester/work/${name}`
const step = (uri: string, highlight: string | null = null): { uri: string; highlight: string | null } => ({
  uri,
  highlight
})

describe('sanitizeViewerHistory', () => {
  it('ふつうの履歴はそのまま (検索語は trim)', () => {
    const out = sanitizeViewerHistory(
      { entries: [step(file('a.ts'), '  needle '), step('https://example.com/docs')], index: 1 },
      fs
    )
    expect(out).toEqual({
      entries: [step(file('a.ts'), 'needle'), step('https://example.com/docs')],
      index: 1
    })
  })

  it('除外・about:blank・他のスキーム・秘密の見える URL の歩は落とし、index は近い歩に寄る', () => {
    const out = sanitizeViewerHistory(
      {
        entries: [
          step(file('a.ts')),
          step('about:blank'),
          step(file('b.ts')),
          step('file:///Users/tester/excluded/secret'),
          step('javascript:alert(1)'),
          step('ftp://example.com/x'),
          step(`https://example.com/p/ghp_${'a'.repeat(36)}`)
        ],
        index: 3
      },
      fs
    )
    expect(out?.entries.map((e) => e.uri)).toEqual([file('a.ts'), file('b.ts')])
    // The third one (excluded) was dropped, so the b.ts before it
    expect(out?.index).toBe(1)
  })

  it('クエリに秘密のある web は、クエリを落として残す (persistableWebUrl)', () => {
    const out = sanitizeViewerHistory(
      { entries: [step(`https://example.com/docs?key=AIza${'a'.repeat(35)}`)], index: 0 },
      fs
    )
    expect(out?.entries[0]?.uri).toBe('https://example.com/docs')
  })

  it('web の歩は検索語を持たない。秘密に見える検索語は捨てる', () => {
    const out = sanitizeViewerHistory(
      { entries: [step('https://example.com/', 'x'), step(file('a.ts'), `ghp_${'a'.repeat(36)}`)], index: 1 },
      fs
    )
    expect(out?.entries.map((e) => e.highlight)).toEqual([null, null])
  })

  it('50 歩を超えたら古い歩から捨て、index は同じ歩を指し続ける', () => {
    const entries = Array.from({ length: 60 }, (_, i) => step(file(`f${i}.ts`)))
    const out = sanitizeViewerHistory({ entries, index: 55 }, fs)
    expect(out?.entries).toHaveLength(50)
    expect(out?.entries[0]?.uri).toBe(file('f10.ts'))
    expect(out?.entries[out.index]?.uri).toBe(file('f55.ts'))
  })

  it('壊れた入力は null (投げない)', () => {
    for (const bad of [null, 1, 'x', {}, { entries: 'x' }, { entries: [] }, { entries: [null, 3, {}] }]) {
      expect(sanitizeViewerHistory(bad, fs), JSON.stringify(bad)).toBeNull()
    }
    expect(sanitizeViewerHistory({ entries: new Array(501).fill(step(file('a'))), index: 0 }, fs)).toBeNull()
    expect(parseStoredHistory('{not json', fs)).toBeNull()
    expect(parseStoredHistory(null, fs)).toBeNull()
  })

  it('index が範囲外・非整数でも収まる', () => {
    const entries = [step(file('a')), step(file('b'))]
    expect(sanitizeViewerHistory({ entries, index: 99 }, fs)?.index).toBe(1)
    expect(sanitizeViewerHistory({ entries, index: -5 }, fs)?.index).toBe(0)
    expect(sanitizeViewerHistory({ entries, index: 0.5 }, fs)?.index).toBe(1)
  })
})

describe('ViewerHistoryService (ThreadStore + migration 28)', () => {
  let db: Db
  let store: ThreadStore
  let service: ViewerHistoryService

  const create = (id: string): void => {
    store.createThread({
      id,
      title: '',
      titleAuto: true,
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'fake',
      modelId: null,
      thinking: null
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new ThreadStore(db, '/Users/tester')
    service = new ViewerHistoryService({ store, fs })
  })
  afterEach(() => db.close())

  it('書いたものを読み戻せる。会話ごとに別', () => {
    create('t1')
    create('t2')
    service.set('t1', { entries: [step(file('a')), step(file('b'))], index: 0 })
    service.set('t2', { entries: [step('https://example.com/')], index: 0 })
    expect(service.get('t1')).toEqual({ entries: [step(file('a')), step(file('b'))], index: 0 })
    expect(service.get('t2')?.entries).toHaveLength(1)
  })

  it('上書きと、歩が残らない保存 (行を消す)', () => {
    create('t1')
    service.set('t1', { entries: [step(file('a'))], index: 0 })
    service.set('t1', { entries: [step(file('z'))], index: 0 })
    expect(service.get('t1')?.entries[0]?.uri).toBe(file('z'))
    service.set('t1', { entries: [step('about:blank')], index: 0 })
    expect(service.get('t1')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_viewer_history').get()).toEqual({ n: 0 })
  })

  it('無い会話には書かない・読まない (外部キーで投げない)', () => {
    expect(() => service.set('ghost', { entries: [step(file('a'))], index: 0 })).not.toThrow()
    expect(service.get('ghost')).toBeNull()
  })

  it('読み戻しでも検め直す (後から除外された歩は渡さない)', () => {
    create('t1')
    db.prepare('INSERT INTO thread_viewer_history (thread_id, history, updated_at) VALUES (?, ?, 0)').run(
      't1',
      JSON.stringify({ entries: [step(file('a')), step('file:///Users/tester/excluded/x')], index: 1 })
    )
    expect(service.get('t1')).toEqual({ entries: [step(file('a'))], index: 0 })
  })

  it('3 分の物理削除 (526) で会話の行と一緒に消える。論理削除では残って復元で戻る', () => {
    create('gone')
    create('soft')
    service.set('gone', { entries: [step(file('a'))], index: 0 })
    service.set('soft', { entries: [step(file('b'))], index: 0 })
    expect(store.purgeAbandonedThread('gone', Date.now() + 60_000)).toBe(true)
    expect(db.prepare('SELECT thread_id FROM thread_viewer_history').all()).toEqual([{ thread_id: 'soft' }])
    store.removeThread('soft')
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_viewer_history').get()).toEqual({ n: 1 })
  })
})
