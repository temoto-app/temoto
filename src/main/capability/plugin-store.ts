/**
 * The canonical copy of body text that comes from plugins (ARCHITECTURE.md 6.5 / chapter 8, the decision of 12.9).
 *
 * The skeleton's chapter 8 assumed a `cache/<plugin>/` directory,
 * but a plaintext file there would conflict with constraint 11 (the whole DB is encrypted).
 * **A table inside the encrypted DB is the canonical copy.** Just as the canonical copy of conversations is `thread_events`,
 * `documents` keeps holding no body (constraint 9).
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import { BUILTIN_INDEX_SOURCES, PLUGIN_ID_RE, indexSourceOwnedBy, type PluginDocumentInput } from '@shared/plugin.js'

/**
 * Since P1, **the index process only reads this over reverse RPC** (3.4).
 * Writes and deletes are done by this implementation in main, and the index follows (6.5).
 */
export class PluginDocumentStore {
  private readonly upsert: Statement
  private readonly select: Statement
  private readonly delete: Statement
  private readonly sources: Statement
  private readonly deleteSource: Statement

  constructor(db: Database) {
    this.upsert = db.prepare(`
      INSERT INTO plugin_documents (source, source_id, title, uri, body, updated_at)
      VALUES (@source, @source_id, @title, @uri, @body, @updated_at)
      ON CONFLICT(source, source_id) DO UPDATE SET
        title = excluded.title, uri = excluded.uri,
        body = excluded.body, updated_at = excluded.updated_at
    `)
    this.select = db.prepare(`SELECT body FROM plugin_documents WHERE source = ? AND source_id = ?`)
    this.delete = db.prepare(`DELETE FROM plugin_documents WHERE source = ? AND source_id = ?`)
    this.sources = db.prepare(`SELECT DISTINCT source FROM plugin_documents`)
    this.deleteSource = db.prepare(`DELETE FROM plugin_documents WHERE source = ?`)
  }

  put(document: PluginDocumentInput): void {
    this.upsert.run({
      source: document.source,
      source_id: document.sourceId,
      title: document.title,
      uri: document.uri,
      body: document.body,
      updated_at: document.updatedAt ?? Date.now()
    })
  }

  read(source: string, sourceId: string): string | null {
    const row = this.select.get(source, sourceId) as { body: string } | undefined
    return row?.body ?? null
  }

  remove(source: string, sourceId: string): void {
    this.delete.run(source, sourceId)
  }

  /**
   * TODO 1237: uninstalling an extension. Deletes every canonical copy in its namespace (`indexSourceOwnedBy`). Call this **after** the index documents are deleted
   * (the reverse of 6.5: index first, canonical copy after). Returns the number deleted.
   */
  removeOwnedBy(pluginId: string): number {
    if (!PLUGIN_ID_RE.test(pluginId) || BUILTIN_INDEX_SOURCES.has(pluginId)) throw new Error('invalid plugin id')
    const sources = this.sources.all() as { source: string }[]
    let removed = 0
    for (const { source } of sources) {
      if (indexSourceOwnedBy(pluginId, source)) removed += this.deleteSource.run(source).changes
    }
    return removed
  }
}
