/**
 * Measurement of the DB breakdown (TODO 846 / 914 / 988, wave 61 bundle D). Read-only; writes nothing.
 * Called only by `IndexService.measureDatabase` (inside the write queue). Yields the event loop between stages.
 */
import { statSync } from 'node:fs'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { DbBreakdown, DbBreakdownEntry } from '@shared/db-breakdown.js'

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Is it `CREATE VIRTUAL TABLE …`? The main FTS5 table is virtual even when `sqlite_schema.type` is 'table', and `count(*)` on it is a full scan. */
function isVirtual(sql: string | null): boolean {
  return sql !== null && /^\s*create\s+virtual\s+table\b/i.test(sql)
}

/** The caller excludes virtual tables (FTS5 shadow tables are ordinary tables, so they are counted). */
function countRows(db: Database, name: string): number | null {
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n)
  } catch {
    return null
  }
}

/**
 * `yieldToLoop` is called between the per-table stages (it yields the index process's event loop to other RPCs).
 * One synchronous piece of work is at most "dbstat of one table" or "count(*) of one table".
 */
export async function measureDb(
  db: Database,
  top = 30,
  yieldToLoop: () => Promise<void> = () => Promise.resolve()
): Promise<DbBreakdown> {
  const started = Date.now()
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  const pageCount = Number(db.pragma('page_count', { simple: true }))
  const freelistPages = Number(db.pragma('freelist_count', { simple: true }))

  let walBytes = 0
  try {
    if (db.name !== '' && db.name !== ':memory:') walBytes = statSync(`${db.name}-wal`).size
  } catch {
    walBytes = 0
  }

  const kinds = new Map<string, 'table' | 'index'>()
  const virtual = new Set<string>()
  for (const row of db
    .prepare(`SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table','index')`)
    .all() as { type: 'table' | 'index'; name: string; sql: string | null }[]) {
    kinds.set(row.name, row.type)
    if (row.type === 'table' && isVirtual(row.sql)) virtual.add(row.name)
  }

  // Per-table stage: dbstat, when filtered by name, reads only that table's pages.
  const names = new Set<string>([...kinds.keys(), 'sqlite_schema'])
  const bytes = new Map<string, number>()
  let dbstatAvailable = true
  let sizeStmt: ReturnType<Database['prepare']> | null = null
  try {
    sizeStmt = db.prepare(`SELECT sum(pgsize) AS bytes FROM dbstat WHERE name = ?`)
  } catch {
    dbstatAvailable = false
  }
  if (sizeStmt !== null) {
    for (const name of names) {
      try {
        const row = sizeStmt.get(name) as { bytes: number | null }
        bytes.set(name, Number(row.bytes ?? 0))
      } catch {
        dbstatAvailable = false
        bytes.clear()
        break
      }
      await yieldToLoop()
    }
  }

  const all: DbBreakdownEntry[] = [...names].map((name) => ({
    name,
    kind: kinds.get(name) ?? 'other',
    bytes: dbstatAvailable ? (bytes.get(name) ?? 0) : null,
    rows: null
  }))
  all.sort((a, b) =>
    dbstatAvailable ? (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)
  )
  const entries: DbBreakdownEntry[] = []
  for (const entry of all.slice(0, Math.max(1, top))) {
    const counted = entry.kind === 'table' && !virtual.has(entry.name)
    entries.push({ ...entry, rows: counted ? countRows(db, entry.name) : null })
    if (counted) await yieldToLoop()
  }

  return {
    fileBytes: pageCount * pageSize,
    walBytes,
    pageSize,
    freelistPages,
    reclaimableBytes: freelistPages * pageSize,
    dbstatAvailable,
    entries,
    totalEntries: all.length,
    tookMs: Date.now() - started
  }
}
