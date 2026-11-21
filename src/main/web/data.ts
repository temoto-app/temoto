/**
 * The tables for web history and Favorites (migration 22 `web_history` / `web_favorites`, TODO 522, ARCHITECTURE 5.2.1).
 *
 * **Does not depend on electron.** The only writer is this entry point in main (the index process does not touch it, the renderer only asks over IPC).
 * It holds only title, URL, and time (no page body). A URL always goes through `persistableWebUrl` before being written
 * (if it hits the redaction table the query is dropped, and if it still hits, it is not written).
 *
 * History is one row per URL (each open advances the time). The limits (`WEB_HISTORY_MAX_ROWS` / `WEB_HISTORY_MAX_AGE_MS`) are
 * not counted on every write; they are trimmed once every `PRUNE_EVERY` writes and at startup.
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import {
  FAVICON_RETRY_MS,
  MAX_WEB_FAVORITES,
  WEB_HISTORY_MAX_AGE_MS,
  WEB_HISTORY_MAX_ROWS,
  cleanWebTitle,
  persistableWebUrl,
  type WebFavicons,
  type WebFavorite,
  type WebHistoryEntry
} from '@shared/web-tabs.js'
import { webHostOf } from '@shared/web-view.js'

/** How many writes between trims to the limit. */
const PRUNE_EVERY = 50

interface HistoryRow {
  id: number
  url: string
  title: string
  visited_at: number
  host: string | null
}

interface FavoriteRow {
  id: number
  url: string
  title: string
  created_at: number
  host: string | null
}

interface FaviconRow {
  host: string
  icon: string
}

export class WebDataStore {
  private readonly visit: Statement
  private readonly retitleHistory: Statement
  private readonly retitleFavorite: Statement
  private readonly listHistoryStmt: Statement
  private readonly listFavoritesStmt: Statement
  private readonly listFaviconsStmt: Statement
  private readonly upsertFavicon: Statement
  private readonly markFaviconFailedStmt: Statement
  private readonly hostsWithoutFaviconStmt: Statement
  private readonly pruneOrphanFaviconsStmt: Statement
  private writes = 0

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {
    this.visit = db.prepare(
      `INSERT INTO web_history (url, title, host, visited_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET visited_at = excluded.visited_at,
         title = CASE WHEN excluded.title = '' THEN web_history.title ELSE excluded.title END`
    )
    // If the title is the same, do not change it (reporting a change makes all windows re-read the list — code-review 2026-10-08).
    this.retitleHistory = db.prepare('UPDATE web_history SET title = ? WHERE url = ? AND title <> ?')
    this.retitleFavorite = db.prepare('UPDATE web_favorites SET title = ? WHERE url = ? AND title = ?')
    // code-review (TODO 722): the list returns only the host — the favicon data URL is not carried on every row
    // (`listFaviconsStmt` returns a host -> icon map once, and the renderer looks it up just once).
    this.listHistoryStmt = db.prepare(
      `SELECT id, url, title, visited_at, host FROM web_history ORDER BY visited_at DESC, id DESC LIMIT ?`
    )
    this.listFavoritesStmt = db.prepare(
      `SELECT id, url, title, created_at, host FROM web_favorites ORDER BY position ASC, id ASC`
    )
    // TODO 743: rows for hosts with only failures (icon = '') are not shown in the list.
    this.listFaviconsStmt = db.prepare(`SELECT host, icon FROM web_favicons WHERE icon <> ''`)
    this.upsertFavicon = db.prepare(
      `INSERT INTO web_favicons (host, icon, updated_at, failed_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(host) DO UPDATE SET icon = excluded.icon, updated_at = excluded.updated_at, failed_at = NULL
         WHERE icon <> excluded.icon`
    )
    // TODO 743: remember a failure. A row that already has a real icon is not overwritten (icon / updated_at stay as they are, only
    // failed_at is updated). If there is no row, create one with icon = '' (a failure-only row that does not yet have a real icon).
    this.markFaviconFailedStmt = db.prepare(
      `INSERT INTO web_favicons (host, icon, updated_at, failed_at) VALUES (?, '', ?, ?)
       ON CONFLICT(host) DO UPDATE SET failed_at = excluded.failed_at`
    )
    // TODO 743: target only hosts that have not failed within 7 days (this includes ones never tried = no row).
    // `icon <> ''` excludes rows that have a real icon (a previous success, not retried).
    this.hostsWithoutFaviconStmt = db.prepare(
      `SELECT DISTINCT host FROM web_favorites
       WHERE host IS NOT NULL
         AND host NOT IN (SELECT host FROM web_favicons WHERE icon <> '' OR failed_at > ?)
       ORDER BY id DESC LIMIT ?`
    )
    // code-review (TODO 722): delete the favicons of hosts that remain in neither history nor Favorites
    // (called after `clearHistory` / `prune` — even after history was cleared, the visited hosts and times stayed in web_favicons
    // and grew without bound). A different table and mechanism from 697's "clear login data" (not touched).
    this.pruneOrphanFaviconsStmt = db.prepare(
      `DELETE FROM web_favicons WHERE host NOT IN (
         SELECT host FROM web_history WHERE host IS NOT NULL
         UNION
         SELECT host FROM web_favorites WHERE host IS NOT NULL
       )`
    )
  }

  /** code-review (TODO 722): delete favicons of hosts that remain in neither. Returns the number of rows deleted. */
  private pruneOrphanFavicons(): number {
    return this.pruneOrphanFaviconsStmt.run().changes
  }

  /** A page was opened (`did-navigate` of the main frame). If the URL cannot be kept, do nothing and return false. */
  recordVisit(url: string, title: string): boolean {
    const stored = persistableWebUrl(url)
    if (stored === null) return false
    this.visit.run(stored, cleanWebTitle(title), webHostOf(stored), this.now())
    this.writes += 1
    if (this.writes % PRUNE_EVERY === 0) this.prune()
    return true
  }

  /**
   * TODO 722: when a tab gets `page-favicon-updated`, write the favicon to the history and Favorite rows of the same host
   * (per host, shared by history and Favorites). `dataUrl` is the data URL `fetchFavicon` returned.
   * False if nothing changed (the caller uses this to throttle the broadcast to all windows).
   */
  setFaviconForHost(host: string, dataUrl: string): boolean {
    return this.upsertFavicon.run(host, dataUrl, this.now()).changes > 0
  }

  /**
   * TODO 722 / 743: Favorites of hosts that have no favicon (most recently added first). Used when fetching them in the background at startup and when a Favorite is added
   * (by hand with the star, or by importing from Chrome). `limit` is the upper bound to fetch at once.
   * **Hosts that failed within 7 days are excluded** (`FAVICON_RETRY_MS`, so the same hosts are not hit at every launch).
   */
  hostsWithoutFavicon(limit: number, now: number = this.now()): readonly string[] {
    const cutoff = now - FAVICON_RETRY_MS
    return (this.hostsWithoutFaviconStmt.all(cutoff, limit) as { host: string }[]).map((row) => row.host)
  }

  /**
   * TODO 743: remember that fetching a favicon failed (neither `/favicon.ico` nor the HTML `<link rel=icon>` worked).
   * A row that already has a real icon does not lose its icon (see ON CONFLICT of `markFaviconFailedStmt`).
   */
  markFaviconFailed(host: string, at: number = this.now()): void {
    this.markFaviconFailedStmt.run(host, at, at)
  }

  /**
   * The page title became known (`page-title-updated`). Fix the title of the history row. A Favorite is filled in **only when its title is empty**
   * (the name the user is looking at is not changed on our own — the title at the time it was added is authoritative). True if something changed.
   */
  updateTitle(url: string, title: string): boolean {
    const stored = persistableWebUrl(url)
    const clean = cleanWebTitle(title)
    if (stored === null || clean === '') return false
    const a = this.retitleHistory.run(clean, stored, clean).changes
    const b = this.retitleFavorite.run(clean, stored, '').changes
    return a + b > 0
  }

  /** Delete old rows and overflowed rows. Returns the number of rows deleted. */
  prune(): number {
    const cutoff = this.now() - WEB_HISTORY_MAX_AGE_MS
    const old = this.db.prepare('DELETE FROM web_history WHERE visited_at < ?').run(cutoff).changes
    const over = this.db
      .prepare(
        `DELETE FROM web_history WHERE id NOT IN (
           SELECT id FROM web_history ORDER BY visited_at DESC, id DESC LIMIT ?
         )`
      )
      .run(WEB_HISTORY_MAX_ROWS).changes
    if (old + over > 0) this.pruneOrphanFavicons()
    return old + over
  }

  listHistory(limit: number = WEB_HISTORY_MAX_ROWS): readonly WebHistoryEntry[] {
    const rows = this.listHistoryStmt.all(Math.max(1, Math.min(WEB_HISTORY_MAX_ROWS, limit))) as HistoryRow[]
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      visitedAt: row.visited_at,
      host: row.host
    }))
  }

  /**
   * code-review (TODO 722): the host -> favicon data URL map, everything at once (shared by history and Favorites).
   * The rows returned by `listHistory` / `listFavorites` no longer carry a favicon — the renderer looks this up just once, and
   * per row looks up by `webHostOf(url)`.
   */
  webFavicons(): WebFavicons {
    const rows = this.listFaviconsStmt.all() as FaviconRow[]
    const map: Record<string, string> = {}
    for (const row of rows) map[row.host] = row.icon
    return map
  }

  /** Delete one history row. True if deleted. A hole found in the proxy verification of TODO 740: only this entry point did not clean up orphaned favicons. */
  removeHistory(id: unknown): boolean {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false
    const changed = this.db.prepare('DELETE FROM web_history WHERE id = ?').run(id).changes > 0
    if (changed) this.pruneOrphanFavicons()
    return changed
  }

  /** Delete all history (cookies and logins are not deleted — that is a matter of the session, separate). Returns the number of rows deleted. */
  clearHistory(): number {
    const changes = this.db.prepare('DELETE FROM web_history').run().changes
    this.pruneOrphanFavicons()
    return changes
  }

  listFavorites(): readonly WebFavorite[] {
    const rows = this.listFavoritesStmt.all() as FavoriteRow[]
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      createdAt: row.created_at,
      host: row.host
    }))
  }

  /** Add to Favorites (at the end). Does nothing if the same URL exists. False for a URL that cannot be kept or when at the limit. */
  addFavorite(url: unknown, title: unknown): boolean {
    const stored = persistableWebUrl(url)
    if (stored === null) return false
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM web_favorites').get() as { n: number }).n
    if (count >= MAX_WEB_FAVORITES) return false
    const max = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM web_favorites').get() as { p: number })
      .p
    const result = this.db
      .prepare(
        `INSERT INTO web_favorites (url, title, host, position, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO NOTHING`
      )
      .run(stored, cleanWebTitle(title), webHostOf(stored), max + 1, this.now())
    return result.changes > 0
  }

  /**
   * Add several Favorites together in one transaction (such as the Chrome import of TODO 676,
   * a fix from code-review). Whether each is allowed follows the same rules as `addFavorite` (duplicate, limit, a URL that cannot be kept), and
   * the return value is a list of bools in the same order as the input. It holds main's JS thread for a shorter time than autocommitting one at a time,
   * and a crash partway does not leave a half-written state.
   */
  addFavoritesBatch(entries: readonly { readonly url: unknown; readonly title: unknown }[]): boolean[] {
    const run = this.db.transaction((items: typeof entries) =>
      items.map((item) => this.addFavorite(item.url, item.title))
    )
    return run(entries)
  }

  /**
   * Remove from Favorites (by id or URL). True if removed.
   * A hole found in the proxy verification of TODO 740: if history had been cleared first, the moment the last Favorite was removed
   * that host's favicon would be referenced by neither table, yet this entry point did not clean it up.
   */
  removeFavorite(target: unknown): boolean {
    const changed =
      typeof target === 'number' && Number.isSafeInteger(target)
        ? this.db.prepare('DELETE FROM web_favorites WHERE id = ?').run(target).changes > 0
        : (() => {
            const stored = persistableWebUrl(target)
            if (stored === null) return false
            return this.db.prepare('DELETE FROM web_favorites WHERE url = ?').run(stored).changes > 0
          })()
    if (changed) this.pruneOrphanFavicons()
    return changed
  }

  /** Reorder Favorites (drag). Move `id` to position `index` in the order. True if it moved. */
  moveFavorite(id: unknown, index: unknown): boolean {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false
    if (typeof index !== 'number' || !Number.isInteger(index)) return false
    const order = this.listFavorites().map((row) => row.id)
    const from = order.indexOf(id)
    if (from < 0) return false
    const to = Math.max(0, Math.min(order.length - 1, index))
    if (from === to) return false
    order.splice(from, 1)
    order.splice(to, 0, id)
    const update = this.db.prepare('UPDATE web_favorites SET position = ? WHERE id = ?')
    this.db.transaction(() => {
      order.forEach((rowId, position) => update.run(position, rowId))
    })()
    return true
  }
}
