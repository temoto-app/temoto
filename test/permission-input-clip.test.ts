/**
 * TODO 838: the input of a permission request (permission_request) is clipped and saved by the same rules as tool_use.
 * At save time (ThreadStore), and in migration 29 (re-clipping of existing rows). The model is not called.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { MAX_ARG_CHARS } from '../src/common/clip-json.js'
import { ThreadStore } from '../src/main/session/store.js'

const opened: Db[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function open(): Db {
  const db = new Database(':memory:')
  opened.push(db)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

const BIG = 'x'.repeat(50_000)

describe('permission_request の input の切り詰め (TODO 838)', () => {
  it('大きな Write の承認要求は input が切れて保存される', () => {
    const db = open()
    const store = new ThreadStore(db, '/Users/tester')
    const thread = store.createThread({
      id: 'thread-1',
      title: 't',
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    store.appendEvents(thread, 'session-1', [
      {
        id: 'p',
        threadId: 'thread-1',
        sessionId: 'session-1',
        seq: 0,
        ts: 1,
        actor: 'main',
        parentToolUseId: null,
        kind: 'permission_request',
        payload: {
          requestId: 'r',
          toolUseId: 't',
          toolName: 'Write',
          summary: 'Write /a',
          input: { file_path: '/a', content: BIG, list: Array.from({ length: 80 }, (_, i) => i) },
          requestedAt: 1,
          decidedAt: 2,
          outcome: { kind: 'allowed', by: 'auto' }
        }
      } as never
    ])
    const [item] = store.readTimeline('thread-1')
    if (item?.kind !== 'permission_request') throw new Error('wrong kind')
    const input = item.payload.input as { content: string; list: unknown[]; file_path: string }
    expect(input.file_path).toBe('/a')
    expect(input.content.length).toBeLessThan(MAX_ARG_CHARS + 60)
    expect(input.content).toContain('50000 chars')
    expect(input.list).toHaveLength(50)
    const bytes = db.prepare(`SELECT payload_bytes AS b FROM thread_events WHERE id = 'p'`).get() as { b: number }
    expect(bytes.b).toBeLessThan(3000)
  })

  it('redaction は切る前に掛かる — 1,000 字を超える秘密鍵も伏せて保存される', () => {
    const db = open()
    const store = new ThreadStore(db, '/Users/tester')
    const thread = store.createThread({
      id: 'thread-1',
      title: 't',
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
    const body = 'A'.repeat(64)
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${Array.from({ length: 40 }, () => body).join('\n')}\n-----END RSA PRIVATE KEY-----\n`
    expect(key.length).toBeGreaterThan(MAX_ARG_CHARS * 2)
    store.appendEvents(thread, 'session-1', [
      {
        id: 'p',
        threadId: 'thread-1',
        sessionId: 'session-1',
        seq: 0,
        ts: 1,
        actor: 'main',
        parentToolUseId: null,
        kind: 'permission_request',
        payload: {
          requestId: 'r',
          toolUseId: 't',
          toolName: 'Write',
          summary: 'Write /a',
          input: { file_path: '/a', content: key },
          requestedAt: 1,
          decidedAt: 2,
          outcome: { kind: 'allowed', by: 'auto' }
        }
      } as never
    ])
    const raw = (db.prepare(`SELECT payload FROM thread_events WHERE id = 'p'`).get() as { payload: string }).payload
    expect(raw).not.toContain(body)
  })

  it('migration 29 は既存の長い permission_request だけを切り詰め直す', () => {
    const db = open()
    db.pragma('user_version = 28') // Re-apply 29 (the SQL of migration 29 is idempotent)
    db.prepare(
      `INSERT INTO threads (id, title, cwd, allowed_dirs, created_at, updated_at) VALUES ('t', 'x', '/w', '[]', 1, 1)`
    ).run()
    const insert = db.prepare(
      `INSERT INTO thread_events (id, thread_id, seq, ts, kind, payload, payload_bytes) VALUES (?, 't', ?, 1, ?, ?, ?)`
    )
    const long = JSON.stringify({ requestId: 'r', input: { content: BIG, n: 1 }, outcome: { kind: 'pending' } })
    const short = JSON.stringify({ requestId: 'r', input: { command: 'ls' } })
    const other = JSON.stringify({ text: BIG })
    insert.run('long', 1, 'permission_request', long, long.length)
    insert.run('short', 2, 'permission_request', short, short.length)
    insert.run('other', 3, 'assistant_text', other, other.length)
    insert.run('broken', 4, 'permission_request', 'x'.repeat(3000), 3000)

    expect(runMigrations(db)).toBeGreaterThanOrEqual(29)

    const row = (id: string): { payload: string; payload_bytes: number } =>
      db.prepare(`SELECT payload, payload_bytes FROM thread_events WHERE id = ?`).get(id) as never
    const l = row('long')
    const parsed = JSON.parse(l.payload) as { input: { content: string; n: number }; outcome: unknown }
    expect(parsed.input.content.length).toBeLessThan(MAX_ARG_CHARS + 60)
    expect(parsed.input.n).toBe(1)
    expect(parsed.outcome).toEqual({ kind: 'pending' })
    expect(l.payload_bytes).toBe(Buffer.byteLength(l.payload, 'utf8'))
    expect(row('short').payload).toBe(short)
    expect(row('other').payload).toBe(other)
    expect(row('broken').payload).toBe('x'.repeat(3000))
  })
})
