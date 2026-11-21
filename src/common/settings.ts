/**
 * Reading and writing `app_settings` (migration 2). A one-to-one mapping of key to string;
 * the value's shape (JSON or integer) is decided by the caller.
 *
 * ThreadStore (session settings, the feature-table cache) and FsService (scan thinning) use the
 * same table, so the SQL is placed in this one place. Each may create this class separately -
 * it only means two sets of prepared statements, and write contention cannot occur because it is the same connection.
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type { SettingKey } from './settings-keys.js'

export class AppSettingsStore {
  private readonly getStatement: Statement
  private readonly setStatement: Statement
  private readonly deleteStatement: Statement

  constructor(db: Database) {
    this.getStatement = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    this.setStatement = db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    this.deleteStatement = db.prepare(`DELETE FROM app_settings WHERE key = ?`)
  }

  read(key: string): string | null {
    const row = this.getStatement.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  write(key: string, value: string): void {
    this.setStatement.run(key, value)
  }

  remove(key: string): void {
    this.deleteStatement.run(key)
  }

  /** A value stored as JSON. null if broken (settings still work with defaults when missing). */
  readJson<T>(key: string): T | null {
    const raw = this.read(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  writeJson(key: string, value: unknown): void {
    this.write(key, JSON.stringify(value))
  }

  /** A value stored as an integer. null if it cannot be read as an integer. */
  readInteger(key: string): number | null {
    const raw = this.read(key)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  /**
   * Read / write through the table in `src/common/settings-keys.ts` (TODO 85). Do not write key string literals
   * here; pass the table's `SettingKey` - a broken value is made to fall to the default by `parse`.
   */
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.read(def.key))
  }

  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.write(def.key, def.serialize(value))
  }

  removeTyped<T>(def: SettingKey<T>): void {
    this.remove(def.key)
  }
}
