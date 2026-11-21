/**
 * TODO 972 (ARCHITECTURE 4.3.4): roles, shown as "Teammates" - the parent of conversations.
 *
 * - migrations 45 / 46: the `roles` table and `threads.role_id`; existing conversations stay without a role; applying again is a no-op
 * - `RoleStore`: create / update / delete, the folder as a path inside and a URI outside, the instructions kept as written
 * - `ThreadStore`: a conversation carries `roleId` only when it has one; deleting a role detaches its conversations
 * - `validateRoleInput`: the name, the folder scheme, the length limit of the instructions
 * - the scheduled prompt keeps `roleId` in the action JSON (no migration) and gives it back to the renderer
 * - the frame around the standing instructions passed to the backend
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { MIGRATIONS, runMigrations } from '../src/common/migrations.js'
import { RoleStore, toRole } from '../src/main/role/store.js'
import { checkRoleInput } from '../src/main/role/ipc.js'
import { ThreadStore } from '../src/main/session/store.js'
import { ScheduledJobStore, toJobInput } from '../src/main/schedule/store.js'
import {
  MAX_ROLE_INSTRUCTIONS,
  MAX_ROLE_NAME,
  cleanRoleInstructions,
  cleanRoleName,
  emptyRoleInput,
  roleInputOf,
  validateRoleInput
} from '../src/shared/role.js'
import { validateScheduledJobInput } from '../src/shared/schedule.js'
import { roleInstructionsText } from '../src/main/session/adapter/compat.js'

function open(): Db {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((row) => row.name)
}

const threadInput = (id: string, roleId?: string) => ({
  id,
  title: id,
  cwd: '/Users/tester/work',
  allowedDirs: ['/Users/tester/work'],
  retention: 'forever' as const,
  backend: 'fake',
  modelId: null,
  thinking: null,
  ...(roleId === undefined ? {} : { roleId })
})

describe('migrations 45 / 46 (TODO 972)', () => {
  it('make the roles table and threads.role_id', () => {
    const db = open()
    expect(columns(db, 'roles')).toEqual([
      'id',
      'name',
      'cwd',
      'instructions',
      'model_id',
      'thinking',
      'created_at',
      'updated_at',
      // TODO 983 stage 4 (migration 47).
      'approval_strict'
    ])
    expect(columns(db, 'threads')).toContain('role_id')
    expect(MIGRATIONS.filter((m) => m.version === 45 || m.version === 46).map((m) => m.name)).toEqual(['roles', 'thread-role'])
    db.close()
  })

  it('an existing conversation stays without a role (no default role is made)', () => {
    // Bring the DB back to the shape of 44 (no roles table, no role column), put a conversation in, then apply 45 / 46.
    const db = open()
    db.exec(`DROP TABLE roles; ALTER TABLE threads DROP COLUMN role_id;`)
    db.pragma('user_version = 44')
    db.prepare(
      `INSERT INTO threads (id, title, cwd, allowed_dirs, retention, unread, setting_sources, backend, approval_strict, created_at, updated_at)
       VALUES ('old', 'old', '/x', '[]', 'forever', 0, '[]', 'fake', 0, 1, 1)`
    ).run()
    runMigrations(db)
    expect(db.prepare(`SELECT role_id FROM threads WHERE id = 'old'`).get()).toEqual({ role_id: null })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM roles`).get()).toEqual({ n: 0 })
    db.close()
  })

  it('applying again after the number is rewound is a no-op (CREATE TABLE IF NOT EXISTS / skipIfColumn)', () => {
    const db = open()
    new RoleStore(db).create({ ...emptyRoleInput(), name: 'Kept' })
    db.pragma('user_version = 44')
    expect(() => runMigrations(db)).not.toThrow()
    expect(new RoleStore(db).list().map((role) => role.name)).toEqual(['Kept'])
    db.close()
  })
})

describe('RoleStore (TODO 972)', () => {
  it('create / list / update / delete; the folder is a path inside and a URI for the renderer', () => {
    const db = open()
    const store = new RoleStore(db)
    const role = store.create(
      { name: 'Secretary', cwdUri: 'file:///Users/tester/work', instructions: '  Line 1\nLine 2', modelId: 'm', thinking: 'high' },
      100
    )
    expect(role.cwd).toBe('/Users/tester/work')
    // The user's text is kept as written (no redaction, like a scheduled prompt).
    expect(role.instructions).toBe('  Line 1\nLine 2')
    expect(toRole(role)).toMatchObject({ name: 'Secretary', cwdUri: 'file:///Users/tester/work', modelId: 'm', thinking: 'high' })
    expect(roleInputOf(toRole(role))).toEqual({
      name: 'Secretary',
      cwdUri: 'file:///Users/tester/work',
      instructions: '  Line 1\nLine 2',
      modelId: 'm',
      thinking: 'high',
      approvalStrict: false
    })
    const updated = store.updateRole(role.id, { ...emptyRoleInput(), name: 'Renamed' }, 200)
    expect(updated).toMatchObject({ name: 'Renamed', cwd: null, modelId: null, thinking: null, createdAt: 100, updatedAt: 200 })
    expect(store.updateRole('missing', emptyRoleInput())).toBeNull()
    expect(store.list()).toHaveLength(1)
    expect(store.delete(role.id)).toBe(true)
    expect(store.delete(role.id)).toBe(false)
    expect(store.get(role.id)).toBeNull()
    db.close()
  })

  it('an unknown thinking level written by a newer version reads as the default', () => {
    const db = open()
    db.prepare(
      `INSERT INTO roles (id, name, cwd, instructions, model_id, thinking, created_at, updated_at) VALUES ('r', 'R', NULL, '', NULL, 'ultra-new', 1, 1)`
    ).run()
    expect(new RoleStore(db).get('r')?.thinking).toBeNull()
    db.close()
  })
})

describe('ThreadStore and roles (TODO 972)', () => {
  it('a conversation carries roleId only when it has one; clearRole detaches without deleting', () => {
    const db = open()
    const threads = new ThreadStore(db, '/Users/tester')
    const withRole = threads.createThread(threadInput('a', 'role-1'))
    const plain = threads.createThread(threadInput('b'))
    expect(withRole.roleId).toBe('role-1')
    expect('roleId' in plain).toBe(false)
    expect(threads.clearRole('role-1')).toBe(1)
    expect(threads.getThread('a')?.roleId).toBeUndefined()
    expect(threads.getThread('a')).not.toBeNull()
    expect(threads.clearRole('role-1')).toBe(0)
    db.close()
  })
})

describe('validateRoleInput / checkRoleInput (TODO 972)', () => {
  it('trims and cuts the name; an empty name is its own reason', () => {
    expect(validateRoleInput({ name: '   ' })).toBe('role-name-empty')
    const long = validateRoleInput({ name: `  ${'x'.repeat(MAX_ROLE_NAME + 10)}  ` })
    expect(typeof long === 'object' && long.name.length).toBe(MAX_ROLE_NAME)
    expect(validateRoleInput({ name: 'A' })).toEqual({ name: 'A', cwdUri: null, instructions: '', modelId: null, thinking: null, approvalStrict: false })
  })

  it('refuses a broken shape: a non-file folder, too long instructions, an unknown thinking level', () => {
    expect(validateRoleInput(null)).toBe('invalid-value')
    expect(validateRoleInput({ name: 'A', cwdUri: 'https://example.com' })).toBe('invalid-value')
    expect(validateRoleInput({ name: 'A', instructions: 'x'.repeat(MAX_ROLE_INSTRUCTIONS + 1) })).toBe('invalid-value')
    expect(validateRoleInput({ name: 'A', thinking: 'enormous' })).toBe('invalid-value')
    expect(validateRoleInput({ name: 'A', modelId: 3 })).toBe('invalid-value')
  })

  it('wave 96 fix Y: drops NUL and other control characters (keeps tab and newline in the instructions; the name becomes one line)', () => {
    const result = validateRoleInput({ name: ' Sec\u0000re\ntary\t ', instructions: 'line 1\r\nline\u0000 2\r\tend\u0007\u001b[0m\u0085 \n' })
    expect(result).toEqual({
      name: 'Sec re tary',
      cwdUri: null,
      instructions: 'line 1\nline 2\n\tend[0m',
      modelId: null,
      thinking: null,
      approvalStrict: false
    })
    expect(validateRoleInput({ name: '\u0000\u0001' })).toBe('role-name-empty')
    expect(cleanRoleInstructions('a\u0000b')).toBe('ab')
    expect(cleanRoleName('a\u0000b')).toBe('a b')
  })

  it('main checks the folder with the choke point it is given (an excluded folder is refused)', () => {
    const checked: string[] = []
    const assertDirectory = (uri: string): void => {
      checked.push(uri)
      if (uri.includes('excluded')) throw new Error('excluded')
    }
    expect(checkRoleInput({ name: 'A', cwdUri: 'file:///Users/tester/work' }, assertDirectory).cwdUri).toBe(
      'file:///Users/tester/work'
    )
    expect(() => checkRoleInput({ name: 'A', cwdUri: 'file:///Users/tester/excluded' }, assertDirectory)).toThrow('excluded')
    expect(() => checkRoleInput({ name: '' }, assertDirectory)).toThrow(/role-name-empty/)
    expect(checked).toEqual(['file:///Users/tester/work', 'file:///Users/tester/excluded'])
  })
})

describe('a scheduled prompt under a role (TODO 972)', () => {
  const input = (roleId?: unknown) => ({
    name: 'Morning',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: {
      kind: 'prompt',
      prompt: 'Check mail',
      cwdUri: null,
      modelId: null,
      thinking: null,
      approvalStrict: false,
      ...(roleId === undefined ? {} : { roleId })
    }
  })

  it('the input check keeps a role id; omitted / null / empty means no role', () => {
    const withRole = validateScheduledJobInput(input('role-1'))
    expect(typeof withRole === 'object' && withRole.action.kind === 'prompt' && withRole.action.roleId).toBe('role-1')
    for (const none of [undefined, null, '']) {
      const result = validateScheduledJobInput(input(none))
      expect(typeof result === 'object' && result.action.kind === 'prompt' && 'roleId' in result.action).toBe(false)
    }
    expect(validateScheduledJobInput(input(42))).toBe('invalid-value')
  })

  it('the job keeps it in the action JSON and gives it back to the renderer; an old row has no role', () => {
    const db = open()
    const jobs = new ScheduledJobStore(db)
    const checked = validateScheduledJobInput(input('role-1'))
    if (typeof checked === 'string') throw new Error(checked)
    const job = jobs.create(checked, Date.now())
    expect(job.action.kind === 'prompt' && job.action.roleId).toBe('role-1')
    const back = toJobInput(job)
    expect(back.action.kind === 'prompt' && back.action.roleId).toBe('role-1')
    const old = validateScheduledJobInput(input())
    if (typeof old === 'string') throw new Error(old)
    const oldJob = jobs.create(old, Date.now())
    expect(oldJob.action.kind === 'prompt' && 'roleId' in oldJob.action).toBe(false)
    db.close()
  })
})

describe('the frame around the standing instructions (TODO 972)', () => {
  it('nothing for empty instructions; otherwise a fixed frame followed by the text as written', () => {
    expect(roleInstructionsText(undefined)).toBeNull()
    expect(roleInstructionsText('  \n ')).toBeNull()
    const text = roleInstructionsText('Keep it short.\nAsk before paying.')
    expect(text).toMatch(/teammate the user set up in aios/)
    expect(text?.endsWith('Keep it short.\nAsk before paying.')).toBe(true)
    expect(text).toMatch(/unless the user says otherwise/)
  })
})
