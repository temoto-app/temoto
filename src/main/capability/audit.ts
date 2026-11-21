/**
 * Audit log (ARCHITECTURE.md chapter 8 / 7.7 "Broker calls are recorded with the plugin ID").
 *
 * **It lives in a table of the encrypted DB** (user decision, 12.9). This is consistent with constraint 11 and
 * avoids plugin IDs, paths, and URLs piling up in a plaintext file.
 *
 * Writes are batched with a `Batcher` (16 ms) into one transaction. One INSERT per Broker
 * call would add the encrypted DB's write cost (+77% over plaintext,
 * spike 11b) directly to the path's latency.
 *
 * **Values are not kept.** Only paths / hosts / source names; bodies and argument values are not stored
 * (the same standard as the logging rules in IMPLEMENTATION_BRIEF chapter 7).
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type { AuditEntry } from '@shared/plugin.js'
import { Batcher } from '../../common/batch.js'

/** Upper bound per listing. **No full COUNT** (the lesson of 12.7's progress aggregation). */
export const MAX_AUDIT_ROWS = 500

export class AuditLog {
  private readonly insert: Statement
  // Item 89: a statement that used to be `db.prepare`d on every call.
  private readonly selectRecent: Statement
  private readonly selectRecentByPlugin: Statement
  private readonly deleteOlder: Statement
  private readonly batcher: Batcher<AuditEntry>
  private readonly writeMany: (entries: readonly AuditEntry[]) => void

  constructor(
    private readonly db: Database,
    onFlush?: (entries: readonly AuditEntry[]) => void
  ) {
    this.insert = db.prepare(`
      INSERT INTO audit_log (at, plugin_id, capability, op, target, decision, reason, ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectRecent = db.prepare(`SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`)
    this.selectRecentByPlugin = db.prepare(
      `SELECT * FROM audit_log WHERE plugin_id = ? ORDER BY at DESC, id DESC LIMIT ?`
    )
    this.deleteOlder = db.prepare(`DELETE FROM audit_log WHERE at < ?`)
    const insertAll = db.transaction((entries: readonly AuditEntry[]) => {
      for (const entry of entries) {
        this.insert.run(
          entry.at,
          entry.pluginId,
          entry.capability,
          entry.op,
          entry.target,
          entry.decision,
          entry.reason,
          entry.ms
        )
      }
    })
    this.writeMany = insertAll
    this.batcher = new Batcher<AuditEntry>((entries) => {
      insertAll(entries)
      onFlush?.(entries)
    })
  }

  record(entry: AuditEntry): void {
    this.batcher.push(entry)
  }

  /** Synchronously writes out everything accumulated, for tests and shutdown. */
  flush(): void {
    this.batcher.flushNow()
  }

  /** Recent records. Can be filtered by plugin ID. The count is not computed (only an index-backed range fetch). */
  recent(limit: number = 100, pluginId?: string): readonly AuditEntry[] {
    const bounded = Math.min(Math.max(limit, 1), MAX_AUDIT_ROWS)
    const rows =
      pluginId === undefined
        ? this.selectRecent.all(bounded)
        : this.selectRecentByPlugin.all(pluginId, bounded)
    return (rows as Record<string, unknown>[]).map((row) => ({
      at: row['at'] as number,
      pluginId: row['plugin_id'] as string,
      capability: row['capability'] as string,
      op: row['op'] as string,
      target: (row['target'] as string | null) ?? null,
      decision: row['decision'] as 'allow' | 'deny',
      reason: (row['reason'] as string | null) ?? null,
      ms: (row['ms'] as number | null) ?? null
    }))
  }

  /** Drops entries past the retention period. */
  prune(olderThan: number): number {
    return this.deleteOlder.run(olderThan).changes
  }

  /** Writes out everything accumulated and stops later batches (call before closing the DB). */
  dispose(): void {
    this.batcher.flushNow()
    this.batcher.dispose()
  }

  /** Writes one entry synchronously (for cases that cannot wait for a batch, such as at exit). */
  recordSync(entry: AuditEntry): void {
    this.writeMany([entry])
  }
}
