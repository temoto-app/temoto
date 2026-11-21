/**
 * migration 32 (TODO 1015, wave 55): sets the strict mode of saved scheduled jobs to false across the board.
 * Puts prompt jobs (strict true / false / no field) and a plugin job into a DB at 31, then applies 32.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../src/common/migrations.js'

const opened: Db[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function at31(): Db {
  const db = new Database(':memory:')
  opened.push(db)
  db.pragma('foreign_keys = ON')
  // Applies everything, then goes back to 31 (the functions the migration SQL uses are registered by runMigrations). 32 is only an UPDATE, so it can be rolled back and reapplied.
  runMigrations(db)
  db.pragma('user_version = 31')
  return db
}

function insert(db: Db, id: string, kind: string, action: string): void {
  db.prepare(
    `INSERT INTO scheduled_jobs (id, name, kind, spec, action, anchor_at, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, 0, 0, 0)`
  ).run(id, id, kind, action)
}

describe('migration 32 (TODO 1015)', () => {
  it('sets approvalStrict of prompt jobs to false and leaves other fields and plugin jobs unchanged', () => {
    const db = at31()
    insert(db, 'on', 'prompt', JSON.stringify({ kind: 'prompt', prompt: 'p', cwd: '/x', approvalStrict: true }))
    insert(db, 'off', 'prompt', JSON.stringify({ kind: 'prompt', prompt: 'q', approvalStrict: false }))
    insert(db, 'none', 'prompt', JSON.stringify({ kind: 'prompt', prompt: 'r' }))
    insert(db, 'plugin', 'plugin', JSON.stringify({ kind: 'plugin', pluginId: 'a', taskId: 'b' }))
    insert(db, 'broken', 'prompt', 'not json')
    expect(runMigrations(db)).toBeGreaterThanOrEqual(32)
    const action = (id: string): unknown => {
      const row = db.prepare('SELECT action FROM scheduled_jobs WHERE id = ?').get(id) as { action: string }
      return JSON.parse(row.action)
    }
    expect(action('on')).toEqual({ kind: 'prompt', prompt: 'p', cwd: '/x', approvalStrict: false })
    expect(action('off')).toEqual({ kind: 'prompt', prompt: 'q', approvalStrict: false })
    expect(action('none')).toEqual({ kind: 'prompt', prompt: 'r', approvalStrict: false })
    expect(action('plugin')).toEqual({ kind: 'plugin', pluginId: 'a', taskId: 'b' })
    expect((db.prepare("SELECT action FROM scheduled_jobs WHERE id = 'broken'").get() as { action: string }).action).toBe(
      'not json'
    )
  })
})
