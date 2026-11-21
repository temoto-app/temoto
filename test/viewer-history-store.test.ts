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
  it('keeps an ordinary history as is (search terms trimmed)', () => {
    const out = sanitizeViewerHistory(
      { entries: [step(file('a.ts'), '  needle '), step('https://example.com/docs')], index: 1 },
      fs
    )
    expect(out).toEqual({
      entries: [step(file('a.ts'), 'needle'), step('https://example.com/docs')],
      index: 1
    })
  })

  it('drops steps that are excluded, about:blank, other schemes, or URLs that show a secret, and index moves to a nearby step', () => {
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

  it('for a web step with a secret in the query, drops the query and keeps the step (persistableWebUrl)', () => {
    const out = sanitizeViewerHistory(
      { entries: [step(`https://example.com/docs?key=AIza${'a'.repeat(35)}`)], index: 0 },
      fs
    )
    expect(out?.entries[0]?.uri).toBe('https://example.com/docs')
  })

  it('a web step has no search terms; search terms that look like secrets are discarded', () => {
    const out = sanitizeViewerHistory(
      { entries: [step('https://example.com/', 'x'), step(file('a.ts'), `ghp_${'a'.repeat(36)}`)], index: 1 },
      fs
    )
    expect(out?.entries.map((e) => e.highlight)).toEqual([null, null])
  })

  it('beyond 50 steps, drops the oldest steps and index keeps pointing at the same step', () => {
    const entries = Array.from({ length: 60 }, (_, i) => step(file(`f${i}.ts`)))
    const out = sanitizeViewerHistory({ entries, index: 55 }, fs)
    expect(out?.entries).toHaveLength(50)
    expect(out?.entries[0]?.uri).toBe(file('f10.ts'))
    expect(out?.entries[out.index]?.uri).toBe(file('f55.ts'))
  })

  it('broken input gives null (does not throw)', () => {
    for (const bad of [null, 1, 'x', {}, { entries: 'x' }, { entries: [] }, { entries: [null, 3, {}] }]) {
      expect(sanitizeViewerHistory(bad, fs), JSON.stringify(bad)).toBeNull()
    }
    expect(sanitizeViewerHistory({ entries: new Array(501).fill(step(file('a'))), index: 0 }, fs)).toBeNull()
    expect(parseStoredHistory('{not json', fs)).toBeNull()
    expect(parseStoredHistory(null, fs)).toBeNull()
  })

  it('fits even when index is out of range or not an integer', () => {
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

  it('reads back what was written, separately per conversation', () => {
    create('t1')
    create('t2')
    service.set('t1', { entries: [step(file('a')), step(file('b'))], index: 0 })
    service.set('t2', { entries: [step('https://example.com/')], index: 0 })
    expect(service.get('t1')).toEqual({ entries: [step(file('a')), step(file('b'))], index: 0 })
    expect(service.get('t2')?.entries).toHaveLength(1)
  })

  it('overwrites, and saving with no steps (deletes the row)', () => {
    create('t1')
    service.set('t1', { entries: [step(file('a'))], index: 0 })
    service.set('t1', { entries: [step(file('z'))], index: 0 })
    expect(service.get('t1')?.entries[0]?.uri).toBe(file('z'))
    service.set('t1', { entries: [step('about:blank')], index: 0 })
    expect(service.get('t1')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_viewer_history').get()).toEqual({ n: 0 })
  })

  it('does not write or read for a conversation that does not exist (does not throw on the foreign key)', () => {
    expect(() => service.set('ghost', { entries: [step(file('a'))], index: 0 })).not.toThrow()
    expect(service.get('ghost')).toBeNull()
  })

  it('re-validates on readback (does not hand over steps excluded later)', () => {
    create('t1')
    db.prepare('INSERT INTO thread_viewer_history (thread_id, history, updated_at) VALUES (?, ?, 0)').run(
      't1',
      JSON.stringify({ entries: [step(file('a')), step('file:///Users/tester/excluded/x')], index: 1 })
    )
    expect(service.get('t1')).toEqual({ entries: [step(file('a'))], index: 0 })
  })

  it('is removed together with the conversation row by the 3-minute physical deletion (526); a soft delete leaves it and it returns on restore', () => {
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
