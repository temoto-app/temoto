/**
 * The table of roles (migration 45 `roles`, TODO 972, ARCHITECTURE 4.3.4). Shown to the user as "Teammates".
 *
 * **Independent of electron.** The only writer is this entry point in main. The working folder is kept as a path and turned into a URI
 * only when passed to the renderer (`toRole`). The standing instructions are the user's own text and, like a scheduled prompt (323),
 * are kept as written (they must reach the backend as written; the DB is encrypted as a whole). They are never logged.
 */
import { randomUUID } from 'node:crypto'
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import { isThinkingLevel, type ThinkingLevel } from '@shared/agent.js'
import type { Role, RoleInput } from '@shared/role.js'
import { pathToUri, uriToPath } from '../../common/uri.js'

/** A row as main reads it (the working folder is a path). */
export interface StoredRole {
  readonly id: string
  readonly name: string
  /** null = no affiliation (a scratch area per conversation). */
  readonly cwd: string | null
  readonly instructions: string
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  /** TODO 983 stage 4 (migration 47): the role's conversations start in strict mode. */
  readonly approvalStrict: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

interface RoleRow {
  id: string
  name: string
  cwd: string | null
  instructions: string
  model_id: string | null
  thinking: string | null
  /** Absent on a DB before migration 47 (read as false). */
  approval_strict?: number | null
  created_at: number
  updated_at: number
}

function toStored(row: RoleRow): StoredRole {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    instructions: row.instructions,
    modelId: row.model_id,
    // A level a newer version wrote is read as "the default" (the row stays usable).
    thinking: isThinkingLevel(row.thinking) ? row.thinking : null,
    approvalStrict: row.approval_strict === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** The shape passed to the renderer. */
export function toRole(role: StoredRole): Role {
  return {
    id: role.id,
    name: role.name,
    cwdUri: role.cwd === null ? null : pathToUri(role.cwd),
    instructions: role.instructions,
    modelId: role.modelId,
    thinking: role.thinking,
    approvalStrict: role.approvalStrict,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  }
}

export class RoleStore {
  private readonly selectAll: Statement
  private readonly selectOne: Statement
  private readonly insert: Statement
  private readonly update: Statement
  private readonly remove: Statement
  /** TODO 983 stage 4: the role's grant rows (`role_grants`, key `role:<id>`). null on a DB without the table (a fake without migration 43). */
  private readonly removeGrants: Statement | null
  private readonly removeInTransaction: (id: string) => boolean

  constructor(db: Database) {
    // Listed in creation order (the thread list orders the groups by recent activity itself).
    this.selectAll = db.prepare(`SELECT * FROM roles ORDER BY created_at, rowid`)
    this.selectOne = db.prepare(`SELECT * FROM roles WHERE id = ?`)
    this.insert = db.prepare(`
      INSERT INTO roles (id, name, cwd, instructions, model_id, thinking, approval_strict, created_at, updated_at)
      VALUES (@id, @name, @cwd, @instructions, @model_id, @thinking, @approval_strict, @now, @now)
    `)
    this.update = db.prepare(`
      UPDATE roles SET name = @name, cwd = @cwd, instructions = @instructions, model_id = @model_id,
        thinking = @thinking, approval_strict = @approval_strict, updated_at = @now
      WHERE id = @id
    `)
    this.remove = db.prepare(`DELETE FROM roles WHERE id = ?`)
    this.removeGrants = prepareOrNull(db, `DELETE FROM role_grants WHERE role_key = ?`)
    // TODO 983 stage 4 (owner decision 2026-11-21): deleting a Teammate deletes its grant rows in the same transaction, so a
    // half-done delete never leaves rows behind for a role that is gone (the startup sweep catches anything else).
    this.removeInTransaction = db.transaction((id: string): boolean => {
      const removed = this.remove.run(id).changes > 0
      if (removed) this.removeGrants?.run(roleGrantKey(id))
      return removed
    })
  }

  list(): readonly StoredRole[] {
    return (this.selectAll.all() as RoleRow[]).map(toStored)
  }

  get(id: string): StoredRole | null {
    const row = this.selectOne.get(id) as RoleRow | undefined
    return row === undefined ? null : toStored(row)
  }

  /** Adds a role. The input is already checked (`validateRoleInput` + the folder's `assertAllowed`). */
  create(input: RoleInput, now: number = Date.now()): StoredRole {
    const id = randomUUID()
    this.insert.run({ id, ...this.columns(input), now })
    return this.get(id) as StoredRole
  }

  /** Rewrites a role. null if it does not exist. */
  updateRole(id: string, input: RoleInput, now: number = Date.now()): StoredRole | null {
    if (this.update.run({ id, ...this.columns(input), now }).changes === 0) return null
    return this.get(id)
  }

  /**
   * Deletes a role and its grant rows (`role:<id>`) in one transaction. The caller also detaches its conversations
   * (`ThreadStore.clearRole`) and drops the rows from the Broker's memory (`SessionManager.forgetRole`).
   */
  delete(id: string): boolean {
    return this.removeInTransaction(id)
  }

  private columns(input: RoleInput): Record<string, string | number | null> {
    return {
      name: input.name,
      cwd: input.cwdUri === null ? null : uriToPath(input.cwdUri),
      instructions: input.instructions,
      model_id: input.modelId,
      thinking: input.thinking,
      approval_strict: input.approvalStrict === true ? 1 : 0
    }
  }
}

/** The grant-table key of a role (TODO 983 stage 4, 4.2.5). The only place that builds the `role:` form. */
export function roleGrantKey(roleId: string): string {
  return `role:${roleId}`
}

function prepareOrNull(db: Database, sql: string): Statement | null {
  try {
    return db.prepare(sql)
  } catch {
    return null
  }
}
