/**
 * Automatic selection of the recommended answer to a question is per conversation, and off by default (TODO 1222, ARCHITECTURE 4.2.2, migration 37).
 *
 * What is guarded: a new conversation is OFF; it can be written and read per conversation; it does not leak into other conversations; it is not written to a logically deleted conversation; migration 37 is idempotent (it does not run if the column exists); and the global setting key is no longer read or written. No model is called.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'

const newStore = (): { db: InstanceType<typeof Database>; store: ThreadStore } => {
  const db = new Database(':memory:')
  runMigrations(db)
  return { db, store: new ThreadStore(db, '/Users/tester') }
}

const make = (store: ThreadStore, id: string) =>
  store.createThread({
    id,
    title: id,
    cwd: '/Users/tester/work',
    allowedDirs: ['/Users/tester/work'],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })

describe('threads.auto_pick_recommended', () => {
  it('新しい会話は OFF (欄ごと省く)。ON にした会話だけ ON で、他の会話には漏れない', () => {
    const { db, store } = newStore()
    try {
      const a = make(store, 'a')
      make(store, 'b')
      expect(a.autoPickRecommended).toBeUndefined()
      expect(store.setAutoPickRecommended('a', true)).toBe(true)
      expect(store.getThread('a')?.autoPickRecommended).toBe(true)
      expect(store.getThread('b')?.autoPickRecommended).toBeUndefined()
      // Turning it off returns it.
      store.setAutoPickRecommended('a', false)
      expect(store.getThread('a')?.autoPickRecommended).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('消した会話には書かない', () => {
    const { db, store } = newStore()
    try {
      make(store, 'a')
      db.prepare('UPDATE threads SET deleted_at = 1 WHERE id = ?').run('a')
      expect(store.setAutoPickRecommended('a', true)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('以前の全体の設定の値は引き継がない (承認の既定に欄が無い)', () => {
    const { db, store } = newStore()
    try {
      db.prepare(`INSERT INTO app_settings (key, value) VALUES ('approval.autoPickRecommended', 'true')`).run()
      expect(store.readApprovalPolicy()).not.toHaveProperty('autoPickRecommended')
      expect(make(store, 'a').autoPickRecommended).toBeUndefined()
    } finally {
      db.close()
    }
  })
})

describe('migration 37 (threads.auto_pick_recommended)', () => {
  it('既存の行は OFF。番号を巻き戻して当て直しても落ちない (列があれば流さない)', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const columns = db.prepare(`SELECT name, dflt_value FROM pragma_table_info('threads')`).all() as {
        name: string
        dflt_value: string | null
      }[]
      expect(columns.find((column) => column.name === 'auto_pick_recommended')?.dflt_value).toBe('0')
      db.pragma('user_version = 36')
      expect(runMigrations(db)).toBeGreaterThanOrEqual(37)
    } finally {
      db.close()
    }
  })
})
