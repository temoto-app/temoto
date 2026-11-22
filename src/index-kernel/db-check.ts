/**
 * The light check of the whole DB at startup (TODO 1306, ARCHITECTURE 8.7). Read-only; writes nothing.
 *
 * - `PRAGMA quick_check(<table>)` **one table at a time** (it checks the table's b-tree and its indexes, not the cross-checks of
 *   `integrity_check`, which is too heavy for every launch and is never run here). The caller puts each table on the index service's
 *   queue, so index writes interleave between tables and one synchronous piece is at most one table (the same shape as `measureDb`).
 * - Runs in the index process: main's JS thread never runs it (constraint 8.1, the 39-second freeze of 2026-09-22).
 * - Only table names, counts and times come out (the whole time and the slowest table, to measure it on real machines). SQLite's
 *   messages (page numbers) are not returned or logged.
 * - How often it runs is decided by main (`BackupService`: at most once a day, not right after startup, sooner after an unfinished
 *   check or a DB that could not be opened).
 */
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { DbQuickCheckResult } from '@shared/backup.js'

/** The tables to check, in schema order (`sqlite_schema` first). Virtual tables are skipped (their shadow tables are ordinary tables). */
export function tablesToCheck(db: Database): string[] {
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY rowid`)
    .all() as { name: string; sql: string | null }[]
  const names = ['sqlite_schema']
  for (const row of rows) {
    if (row.sql !== null && /^\s*create\s+virtual\s+table\b/i.test(row.sql)) continue
    if (row.name === 'sqlite_schema' || row.name === 'sqlite_master') continue
    names.push(row.name)
  }
  return names
}

/** Checks one table. true if nothing was reported. A thrown corruption error counts as damage; any other error is re-thrown. */
export function quickCheckTable(db: Database, table: string): boolean {
  try {
    const rows = db.pragma(`quick_check("${table.replace(/"/g, '""')}")`) as { quick_check?: unknown }[]
    return rows.length === 1 && rows[0]?.quick_check === 'ok'
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')) return false
    // Dropped between listing and checking (e.g. a migration-free cleanup): nothing to check.
    if (err instanceof Error && /no such table/i.test(err.message)) return true
    throw err
  }
}

/**
 * The whole check. `step` runs one table's work (the index service passes its queue; it returns false when shutdown has begun and the
 * work was not run). Tables that vanish between listing and checking are skipped.
 */
export async function quickCheckDb(
  db: Database,
  step: (work: () => void) => Promise<boolean>,
  now: () => number = Date.now
): Promise<DbQuickCheckResult> {
  const started = now()
  let tables: string[] = []
  let listed = true
  const listedOk = await step(() => {
    try {
      tables = tablesToCheck(db)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')) listed = false
      else throw err
    }
  })
  if (!listedOk) return { ok: false, tables: 0, damaged: [], stopped: true, ms: now() - started, slowest: null }
  if (!listed) return { ok: false, tables: 0, damaged: ['sqlite_schema'], stopped: false, ms: now() - started, slowest: null }
  const damaged: string[] = []
  let slowest: { table: string; ms: number } | null = null
  for (const table of tables) {
    const ran = await step(() => {
      const begun = now()
      if (!quickCheckTable(db, table)) damaged.push(table)
      const took = now() - begun
      if (slowest === null || took > slowest.ms) slowest = { table, ms: took }
    })
    if (!ran) return { ok: false, tables: tables.length, damaged, stopped: true, ms: now() - started, slowest }
  }
  return { ok: damaged.length === 0, tables: tables.length, damaged, stopped: false, ms: now() - started, slowest }
}
