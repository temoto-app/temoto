/**
 * Storage for the per-role grant table (TODO 983 stage 1, 2. of ARCHITECTURE 4.2.5, migration 43 `role_grants`).
 *
 * **The only writer is this entry point in main** (it receives the DB, like `schedule/store.ts`). The Broker does not know the DB and receives `RoleGrantPersistence` by injection
 * (like `ApprovalRuleStore`). Matching uses the Broker's memory; this only reads at startup and writes when adding.
 * Row validation (`sanitizeGrantRow`) is done by the Broker every time it reads - this only shapes the columns.
 * Stage 2: deleting rows (the table's ✕, deleting a job / conversation, sweeping expired ones) and updating `last_used_at` / `use_count`.
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type { RoleGrantScope, RoleGrantSubjectKind } from '@shared/thread.js'
import type { RoleGrantRow } from './grants.js'

export interface RoleGrantPersistence {
  loadRoleGrants(): readonly RoleGrantRow[]
  /** Add rows (the rows of one press in one transaction). */
  addRoleGrants(rows: readonly RoleGrantRow[]): void
  removeRoleGrants(ids: readonly string[]): void
  /** Update `last_used_at` / `use_count` of the rows used (when passed through the table). */
  touchRoleGrants(ids: readonly string[], now: number): void
}

interface GrantDbRow {
  id: string
  role_key: string
  tool_name: string
  subject_kind: string
  subject: string | null
  subject_hash: string | null
  access: string | null
  scope: string
  thread_id: string | null
  expires_at: number | null
  source: string
  created_at: number
  last_used_at: number | null
  use_count: number
}

export class RoleGrantStore implements RoleGrantPersistence {
  private readonly selectAll: Statement
  private readonly insert: Statement
  private readonly insertMany: (rows: readonly RoleGrantRow[]) => void
  private readonly deleteMany: (ids: readonly string[]) => void
  private readonly touchMany: (ids: readonly string[], now: number) => void

  constructor(db: Database) {
    this.selectAll = db.prepare(`SELECT * FROM role_grants ORDER BY created_at, rowid`)
    this.insert = db.prepare(`
      INSERT INTO role_grants (id, role_key, tool_name, subject_kind, subject, subject_hash, access, scope, thread_id, expires_at,
        source, created_at, last_used_at, use_count)
      VALUES (@id, @role_key, @tool_name, @subject_kind, @subject, @subject_hash, @access, @scope, @thread_id, @expires_at,
        @source, @created_at, @last_used_at, @use_count)
    `)
    this.insertMany = db.transaction((rows: readonly RoleGrantRow[]) => {
      for (const row of rows) this.insert.run(toDbRow(row))
    })
    const remove = db.prepare(`DELETE FROM role_grants WHERE id = ?`)
    this.deleteMany = db.transaction((ids: readonly string[]) => {
      for (const id of ids) remove.run(id)
    })
    const touch = db.prepare(`UPDATE role_grants SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`)
    this.touchMany = db.transaction((ids: readonly string[], now: number) => {
      for (const id of ids) touch.run(now, id)
    })
  }

  loadRoleGrants(): readonly RoleGrantRow[] {
    return (this.selectAll.all() as GrantDbRow[]).map(fromDbRow)
  }

  addRoleGrants(rows: readonly RoleGrantRow[]): void {
    if (rows.length === 0) return
    this.insertMany(rows)
  }

  removeRoleGrants(ids: readonly string[]): void {
    if (ids.length === 0) return
    this.deleteMany(ids)
  }

  touchRoleGrants(ids: readonly string[], now: number): void {
    if (ids.length === 0) return
    this.touchMany(ids, now)
  }
}

function toDbRow(row: RoleGrantRow): GrantDbRow {
  return {
    id: row.id,
    role_key: row.roleKey,
    tool_name: row.toolName,
    subject_kind: row.subjectKind,
    subject: row.subject,
    subject_hash: row.subjectHash,
    access: row.access,
    scope: row.scope,
    thread_id: row.threadId,
    expires_at: row.expiresAt,
    source: row.source,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    use_count: row.useCount
  }
}

/** Only shapes the columns. Unknown values are passed on as they are, and `sanitizeGrantRow` drops them. */
function fromDbRow(row: GrantDbRow): RoleGrantRow {
  return {
    id: row.id,
    roleKey: row.role_key,
    toolName: row.tool_name,
    subjectKind: row.subject_kind as RoleGrantSubjectKind,
    subject: row.subject,
    subjectHash: row.subject_hash,
    access: row.access === 'read' || row.access === 'write' ? row.access : null,
    scope: row.scope as RoleGrantScope,
    threadId: row.thread_id,
    expiresAt: row.expires_at,
    source: row.source === 'drill' ? 'drill' : 'approval',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count
  }
}
