/**
 * The SQL layer of the index (the Index stage of ARCHITECTURE.md 6.2 / 6.3 / 6.4).
 *
 * **This class is the only one that writes to `documents` / `chunks` / `chunk_fts`**, and
 * IndexService calls it serialized through the queue (6.2 "single writer principle").
 *
 * What it does not hold:
 * - `documents.body` (constraint 9). The canonical copy of bodies is the disk / `thread_events` / transcript files.
 * - fs paths. A row holds only `name` and the parent's `id`, and the absolute path is built by walking up through parents
 *   (a homework item from 12.4. In Phase 1, `files` held the path twice and a row was 640 bytes).
 * - Chunk text. FTS is contentless, and only the index of the shadow text remains.
 */
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'
import type { Exposure } from '@shared/search.js'
import type { ScanDenial } from '@shared/types.js'
import type { FileSortOrder } from '@shared/file-sort.js'
import { foldPath, pathToUri } from '../common/uri.js'
import { DERIVED_TEXT_EXTENSIONS, extractorTag, LATE_TEXT_EXTENSIONS } from './extract.js'
import { IMAGE_EXTENSIONS } from './image.js'
import type { StoredImageLabels } from './image.js'

/** Name of the root row of the fs tree. Absolute paths on macOS start with `/`. */
const ROOT_NAME = '/'

/**
 * Number of rows the post-scan cleanup deletes in one transaction (`removeStale`).
 *
 * The larger this is, the fewer transactions there are, but **the main thread stalls
 * in the meantime**. With a 2.9 GB encrypted DB, per-row page decryption matters, so
 * keep it small enough that one batch does not exceed 100 ms.
 */
const STALE_BATCH = 200

/**
 * Threshold of FTS5's "crisis merge" (P3).
 *
 * The default is **16**: when a level accumulates 16 segments, FTS5 merges that whole level
 * *inside the COMMIT* of the next write. Merging level k is 16^k documents' worth, so
 * at 500,000 documents a merge of level 4-5 = a rewrite of the entire index lands in a single COMMIT
 * (the cause of the 2026-09-22 39-second hang and the 1.5 GB WAL).
 *
 * We raise it to 256 so that "unbounded merging inside a COMMIT" does not occur, and instead
 * tick `mergeStep` with a time budget. **Leave `automerge` at its default (4)** —
 * setting it to 0 lets segments grow to 2,000 and hits `SQLITE_FULL` (measured).
 * 256 is also low enough against that limit.
 */
const CRISIS_MERGE = 256

/**
 * Default amount of work for `mergeStep` (in FTS5 "pages").
 *
 * **The N in `merge N` is a guide, not a cap, and one call cannot be bounded by N.** When FTS5 merges all
 * segments of a level, it runs to the end (the non-incremental path of `fts5IndexMergeLevel`). Measured (480,000 chunks, encrypted):
 * 66-258 ms per step at 200 pages, **29 ms at 32 pages**. Smaller steps mean shorter stalls.
 */
const MERGE_PAGES = 32

/**
 * Number of ids per statement of `markSkippedBulk` (item 89). Making the statement fixed-length lets the prepare be reused.
 * The remainder is padded by repeating the last id (duplicates in `IN` do not change the result).
 */
const SKIP_CHUNK = 100
/** Number of parent directories in one statement of `fsNamesByParents` (item 100). */
const PARENT_BATCH = 200

/** `metadata` of an fs row: decoding does not round-trip (TODO 925, `IndexStore.setFsLossy`). */
const LOSSY_METADATA = '{"lossy":true}'

/**
 * Margin for seeding the high-water mark (TODO 965 review, `seedChunkIdSeq`). The old "max + 1" rowid never went above the total number of
 * chunks handed out so far. The current index has about 7.1 million chunks, and even hundreds of re-indexings would not
 * reach 2^32 (about 4.3 billion). rowid is 64 bit, so skipping this much does not exhaust it (and it is far from JS's safe integer 2^53).
 */
export const CHUNK_ID_SEED_MARGIN = 2 ** 32

export type DocumentKind = 'directory' | 'file' | 'message'
export type IndexRowState = 'pending' | 'indexed' | 'skipped' | 'failed'

export interface FsEntryInput {
  readonly parentId: number
  readonly name: string
  readonly isDirectory: boolean
  readonly ext: string
  readonly size: number
  readonly mtimeMs: number
  readonly seenAt: number
  /** A file with no local content (iCloud not yet downloaded, TODO 921). It goes into the version, so when downloaded the body is fetched again. */
  readonly dataless?: boolean
}

/**
 * Version of an fs row (the Deduplicate stage of 6.2). Empty for a directory, `mtime:size` for a file.
 * A file with no local content gets `:dataless` appended (TODO 921) — so that a row that became `skipped` while not downloaded
 * returns to `pending` because its version changes on download, even if mtime and size do not change.
 * The version of a file with local content is the same string as before, so existing rows do not get re-fetched.
 */
export function fsVersion(
  entry: Pick<FsEntryInput, 'isDirectory' | 'mtimeMs' | 'size' | 'dataless'> & { readonly name?: string }
): string {
  if (entry.isDirectory) return ''
  // A file whose extracted text is indexed (Office, TODO 997) gets the extraction version (`:ox1`) appended. If the extractor's output
  // changes, the version changes and it is re-indexed. Placed before `:dataless` (so as not to break the check that looks at a trailing `:dataless`).
  const tag = entry.name === undefined ? '' : extractorTag(entry.name)
  return `${entry.mtimeMs}:${entry.size}${tag}${entry.dataless === true ? ':dataless' : ''}`
}

/**
 * Re-attaches the extraction-version mark (`:oxN`, TODO 997 / `:pkN` / for images `:vlN`, TODO 998) of an existing fs row's version (in the `fsVersion` shape) to the current mark.
 * For a file that needs no mark, the mark is removed. `mtime:size` and `:dataless` are left as they are.
 */
export function retagFsVersion(version: string, name: string): string {
  const dataless = version.endsWith(':dataless')
  const base = (dataless ? version.slice(0, -':dataless'.length) : version).replace(/:(?:ox|pk|vl)\d+$/, '')
  return `${base}${extractorTag(name)}${dataless ? ':dataless' : ''}`
}

export interface UpsertedRow {
  readonly id: number
  /** The version (mtime+size) changed, or it is new, so the body needs to be fetched again. */
  readonly needsContent: boolean
}

export interface DocumentRow {
  readonly id: number
  readonly source: string
  readonly parent_id: number | null
  readonly name: string
  readonly kind: string
  readonly source_id: string | null
  readonly uri: string | null
  readonly ext: string
  readonly size: number
  readonly mtime_ms: number
  readonly updated_at: number
  readonly version: string
  readonly lang: string | null
  readonly exposure: string
  readonly metadata: string | null
  readonly index_state: string
}

export interface ChildRow {
  readonly id: number
  readonly name: string
  readonly kind: string
  readonly ext: string
  readonly size: number
  readonly mtime_ms: number
}

export interface ChunkInput {
  /** Shadow text to put in the index (Japanese is already word-segmented). It is not stored. */
  readonly shadow: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly chars: number
}

export interface SearchRow {
  readonly chunk_id: number
  readonly document_id: number
  readonly byte_start: number
  readonly byte_end: number
  readonly score: number
  readonly source: string
  readonly kind: string
  readonly name: string
  readonly uri: string | null
  readonly parent_id: number | null
  readonly updated_at: number
  readonly metadata: string | null
}

export interface IndexCounters {
  readonly documents: number
  readonly indexed: number
  readonly pending: number
  readonly skipped: number
  readonly failed: number
  readonly chunks: number
}

/** Search from the UI also returns ui-only. The gateway gets only ui+ai (6.3). */
export const UI_EXPOSURES: readonly Exposure[] = ['ui+ai', 'ui-only']
export const AGENT_EXPOSURES: readonly Exposure[] = ['ui+ai']

export class IndexStore {
  private readonly insertFs: Statement
  private readonly selectChild: Statement
  private readonly selectChildren: Statement
  /** Direct children excluding those starting with "." (TODO 261). Narrowed in SQL before cutting at `MAX_ROWS`. */
  private readonly selectVisibleChildren: Statement
  /** The "files newest first by modification time" version of the two above (TODO 872. Directories stay at the top in name order). */
  private readonly selectChildrenModified: Statement
  private readonly selectVisibleChildrenModified: Statement
  /** Looks up one direct child row by name (already folded) (TODO 261 "keep the way open even when hidden"). */
  private readonly selectChildRow: Statement
  private readonly selectDocument: Statement
  private readonly selectParent: Statement
  private readonly scanNames: Statement
  private readonly listDirs: Statement
  private readonly selectEntries: Statement
  private readonly deleteDocument: Statement
  private readonly deleteFtsForDocument: Statement
  private readonly deleteChunks: Statement
  private readonly insertChunk: Statement
  private readonly insertFts: Statement
  private readonly setState: Statement
  private readonly upsertDoc: Statement
  private readonly selectBySource: Statement
  /** TODO 1235: documents of one non-fs source whose `uri` is exactly the given string (`source` is the leading column of `documents_source`). */
  private readonly selectNonFsByUri: Statement
  private readonly selectPending: Statement
  private readonly recordFailure: Statement
  private readonly clearFailure: Statement
  private readonly selectStale: Statement
  private readonly insertDir: Statement
  private readonly selectChildMeta: Statement
  private readonly selectChildNames: Statement
  private readonly mergeFts: Statement
  private readonly totalChanges: Statement
  // Item 89: statements that used to call `db.prepare` on every call.
  private readonly selectSubtree: Statement
  /** Ids of the direct children of the batch's parents (a json array) (`withDescendants`, wave 49 review). */
  private readonly selectChildIdsIn: Statement
  private readonly selectBySourcePrefix: Statement
  private readonly selectIdsBySource: Statement
  private readonly selectSourcesInRange: Statement
  private readonly selectConversationsBefore: Statement
  private readonly selectTranscriptFileIds: Statement
  private readonly selectConversationThreadIds: Statement
  private readonly selectChunksOf: Statement
  private readonly selectChunkById: Statement
  private readonly countStates: Statement
  private readonly countChunks: Statement
  private readonly countSegments: Statement
  private readonly skipFts: Statement
  private readonly skipChunks: Statement
  private readonly skipDocuments: Statement
  private readonly selectDenials: Statement
  /** Search statements. The SQL changes when the number of `IN` items changes, so the key is `(operator, number of sources, number of exposures)`. */
  private readonly searchStatements = new Map<string, Statement>()
  /** Statement that walks the cwd subtree of item 100. Not prepared until used. */
  private namesByParents: Statement | null = null
  /** Statement that resets a directory row's mtime to 0 after the cut-off of item 246. Not prepared until used. */
  private forgetMtime: Statement | null = null
  /** Pending bodies of a subtree (item 249). Not created until used. */
  private selectPendingInSubtree: Statement | null = null
  private selectPendingAmong: Statement | null = null
  private selectVersion: Statement | null = null
  private updateFsLossy: Statement | null = null
  /** Cleanup of orphan FTS rows (TODO 945). Not created until used. */
  private selectFtsRowids: Statement | null = null
  private selectMissingChunks: Statement | null = null
  private deleteFtsRows: Statement | null = null
  /** Retroactive `lossy` marking (TODO 946). Not created until used. */
  private selectLossyCandidates: Statement | null = null
  /** Re-attaching the extraction version (TODO 997). Not created until used. */
  private selectDerivedCandidates: Statement | null = null
  private updateDerivedVersion: Statement | null = null
  private updateRequeueSkipped: Statement | null = null
  private selectMaxDocumentId: Statement | null = null
  private selectContentHash: Statement | null = null
  private updateLossyIfUnchanged: Statement | null = null
  /** High-water mark of chunk ids (TODO 965, migration 30). Not created until used. */
  private selectChunkBase: Statement | null = null
  private upsertChunkHighWater: Statement | null = null
  /** Rebuild of FTS that may be dirty (TODO 965). Not created until used. */
  private selectRebuildBelow: Statement | null = null
  private selectRebuildCandidates: Statement | null = null
  private requeueDocument: Statement | null = null
  /** Statements for in-thread search (TODO 496). One per number of exposures. Not prepared until used. */
  private readonly threadSearchStatements = new Map<number, Statement>()

  /** Folded directory path → documents.id. Effective for both the scan and the watcher. */
  private readonly dirCache = new Map<string, number>()
  /** documents.id → directory path before folding. A memo for path reconstruction. */
  private readonly pathCache = new Map<number, string>()
  private rootId: number | null = null
  /**
   * Incremented every time the fs directory tree changes (6.6). Used to decide when to rebuild the
   * "directory id → path" table held by file name search. It is not
   * incremented by file-row upserts — they do not affect paths, and it would force a rebuild on every row during a scan.
   */
  private revision = 0

  get treeRevision(): number {
    return this.revision
  }

  /**
   * Performs one write atomically (P5).
   *
   * **If already inside a transaction, it does not open its own.** better-sqlite3's
   * `db.transaction()` issues a `SAVEPOINT` when nested, but
   * **FTS5 flushes and merges pending index data on the spot at every SAVEPOINT**
   * (`sqlite3VtabSavepoint` → `fts5SavepointMethod` → `fts5IndexMerge`).
   * 28 of the 41 samples of the 2026-09-22 39-second hang were this path.
   *
   * `FsService.applyChanges` and the scan's `writeBatch` call `removeSubtree` / `ensureDirectory` / `upsertFsEntry`
   * while holding an outer transaction, so without going through here a SAVEPOINT would be issued per item.
   *
   * P2's batch write (N documents = 1 transaction) also rides on this.
   */
  atomically(fn: () => void): void {
    if (this.db.inTransaction) {
      fn()
      return
    }
    this.db.transaction(fn)()
  }

  constructor(private readonly db: Database) {
    this.insertFs = db.prepare(`
      INSERT INTO documents
        (source, parent_id, name, name_folded, kind, ext, size, mtime_ms, updated_at,
         version, index_state, seen_at)
      VALUES
        ('fs', @parent_id, @name, @name_folded, @kind, @ext, @size, @mtime_ms, @mtime_ms,
         @version, @index_state, @seen_at)
      ON CONFLICT(parent_id, name_folded) WHERE source = 'fs' DO UPDATE SET
        name = excluded.name, kind = excluded.kind, ext = excluded.ext,
        size = excluded.size, mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at, seen_at = excluded.seen_at,
        -- 版が変わったものだけ本文を取り直す (6.2 の Deduplicate 段)。
        -- 読み取りの失敗 (failed: 開けない・読めない・親の realpath の失敗) は一時的なことがあるので、
        -- 走査・監視が行を書き直したとき (深い走査・監視の差分) に取り直す (TODO 921)。
        -- 増分走査は変わらない行を書かないので、取り直しの間隔は深い走査 (既定 7 日) で縛られる。
        index_state = CASE
          WHEN documents.version = excluded.version AND documents.index_state <> 'failed'
            THEN documents.index_state
          ELSE excluded.index_state END,
        version = excluded.version
      RETURNING id, index_state
    `)
    this.selectChild = db.prepare(
      `SELECT id FROM documents WHERE source = 'fs' AND parent_id IS ? AND name_folded = ?`
    )
    // An entry point that only "declares a directory row to exist" (`ensureDirectory`).
    // The point is **not to touch mtime / size / version** — touching them resets a scanned directory's
    // mtime to 0, and the incremental scan's pruning (6.2.2) would never match again.
    this.insertDir = db.prepare(`
      INSERT INTO documents
        (source, parent_id, name, name_folded, kind, ext, size, mtime_ms, updated_at,
         version, index_state, seen_at)
      VALUES ('fs', @parent_id, @name, @name_folded, 'directory', '', 0, 0, 0, '', 'skipped', @seen_at)
      ON CONFLICT(parent_id, name_folded) WHERE source = 'fs' DO UPDATE SET
        kind = 'directory', seen_at = excluded.seen_at
      RETURNING id
    `)
    // For comparison in the incremental scan (6.2.2). An entry point only for reading "did it change" before writing.
    this.selectChildMeta = db.prepare(
      `SELECT id, kind, mtime_ms, size, version FROM documents
       WHERE source = 'fs' AND parent_id IS ? AND name_folded = ?`
    )
    this.selectChildNames = db.prepare(
      `SELECT id, name_folded FROM documents WHERE source = 'fs' AND parent_id = ?`
    )
    this.selectChildren = db.prepare(`
      SELECT id, name, kind, ext, size, mtime_ms FROM documents
      WHERE source = 'fs' AND parent_id = ?
      ORDER BY kind = 'directory' DESC, name_folded LIMIT ?
    `)
    this.selectVisibleChildren = db.prepare(`
      SELECT id, name, kind, ext, size, mtime_ms FROM documents
      WHERE source = 'fs' AND parent_id = ? AND substr(name, 1, 1) <> '.'
      ORDER BY kind = 'directory' DESC, name_folded LIMIT ?
    `)
    // TODO 872: a directory's mtime may go back to 0 after a cut-off (item 246), so do not sort by time.
    // Sorting happens before `LIMIT`, so in a large folder it is the older files that get cut off.
    this.selectChildrenModified = db.prepare(`
      SELECT id, name, kind, ext, size, mtime_ms FROM documents
      WHERE source = 'fs' AND parent_id = ?
      ORDER BY kind = 'directory' DESC, CASE WHEN kind = 'directory' THEN 0 ELSE -mtime_ms END, name_folded LIMIT ?
    `)
    this.selectVisibleChildrenModified = db.prepare(`
      SELECT id, name, kind, ext, size, mtime_ms FROM documents
      WHERE source = 'fs' AND parent_id = ? AND substr(name, 1, 1) <> '.'
      ORDER BY kind = 'directory' DESC, CASE WHEN kind = 'directory' THEN 0 ELSE -mtime_ms END, name_folded LIMIT ?
    `)
    this.selectChildRow = db.prepare(`
      SELECT id, name, kind, ext, size, mtime_ms FROM documents
      WHERE source = 'fs' AND parent_id = ? AND name_folded = ?
    `)
    this.selectDocument = db.prepare(`SELECT * FROM documents WHERE id = ?`)
    this.selectParent = db.prepare(`SELECT id, parent_id, name FROM documents WHERE id = ?`)
    // Candidate supply for file name search (6.6). **Reads only the covering partial index of migration 8**:
    // the 3 `SELECT` columns and `WHERE` / `ORDER BY` are all in the index, so
    // not a single table page is decrypted. It uses `id > ?` keyset paging
    // so that no `await` happens with an iterator open (writes on the same connection would stall).
    //
    // **`INDEXED BY` is enforced, not advisory**, and is required here. Without it SQLite sees only the
    // equality condition `source = 'fs'`, picks `documents_seen`, and also builds a temporary B-tree
    // for `ORDER BY`. Measured at 1.08 million rows: 3,100 ms → 178 ms.
    this.scanNames = db
      .prepare(
        `SELECT id, name, parent_id FROM documents INDEXED BY documents_name_scan
         WHERE source = 'fs' AND id > ? ORDER BY id LIMIT ?`
      )
      .raw()
    // Directory tree for path matching (tier 2). This too needs only the covering partial index.
    this.listDirs = db
      .prepare(
        `SELECT id, parent_id, name FROM documents INDEXED BY documents_dir_tree
         WHERE source = 'fs' AND kind = 'directory' ORDER BY id`
      )
      .raw()
    this.selectEntries = db.prepare(
      `SELECT id, name, kind, ext, size, mtime_ms, parent_id FROM documents WHERE id = ?`
    )
    this.deleteDocument = db.prepare(`DELETE FROM documents WHERE id = ?`)
    // FTS is a virtual table, so foreign key CASCADE does not apply. **Delete before chunks.**
    this.deleteFtsForDocument = db.prepare(
      `DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)`
    )
    this.deleteChunks = db.prepare(`DELETE FROM chunks WHERE document_id = ?`)
    // The id is assigned by us (TODO 965, the high-water mark of migration 30). Leaving it to "max + 1" would reuse FTS rowids.
    this.insertChunk = db.prepare(`
      INSERT INTO chunks (id, document_id, seq, byte_start, byte_end, chars)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.insertFts = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
    this.setState = db.prepare(`
      UPDATE documents SET index_state = ?, indexed_at = ?, content_hash = ?, lang = ?
      WHERE id = ?
    `)
    this.upsertDoc = db.prepare(`
      INSERT INTO documents
        (source, parent_id, name, name_folded, kind, source_id, uri, updated_at, version,
         exposure, metadata, index_state, seen_at)
      VALUES
        (@source, NULL, @name, @name_folded, @kind, @source_id, @uri, @updated_at, @version,
         @exposure, @metadata, 'pending', @seen_at)
      ON CONFLICT(source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
        name = excluded.name, name_folded = excluded.name_folded, uri = excluded.uri,
        updated_at = excluded.updated_at, exposure = excluded.exposure,
        metadata = excluded.metadata, seen_at = excluded.seen_at,
        -- 一時的な失敗 (本文を聞く逆向きの RPC が 1 回落ちた等) は、行が書き直されたときに取り直す。
        -- fs と同じ扱い (TODO 921 / 1136)。
        index_state = CASE
          WHEN documents.version = excluded.version AND documents.index_state <> 'failed'
            THEN documents.index_state
          ELSE 'pending' END,
        version = excluded.version
      RETURNING id, index_state
    `)
    this.selectBySource = db.prepare(`SELECT * FROM documents WHERE source = ? AND source_id = ?`)
    this.selectNonFsByUri = db.prepare(`SELECT * FROM documents WHERE source = ? AND uri = ? AND source <> 'fs' LIMIT 50`)
    this.selectPending = db.prepare(`
      SELECT id, source, parent_id, name, kind, source_id, uri, ext, size, mtime_ms,
             updated_at, version, lang, exposure, metadata, index_state
      FROM documents WHERE index_state = 'pending' ORDER BY id LIMIT ?
    `)
    this.recordFailure = db.prepare(`
      INSERT INTO index_failures (document_id, reason, at) VALUES (?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET reason = excluded.reason, at = excluded.at
    `)
    this.clearFailure = db.prepare(`DELETE FROM index_failures WHERE document_id = ?`)
    // Keep the shape that lets migration 6's documents_seen apply (source equality + seen_at range).
    // Adding ORDER BY would create a temporary B-tree, so do not add it. The order is not used.
    this.selectStale = db
      .prepare(
        `SELECT id FROM documents
         WHERE source = 'fs' AND seen_at < ? AND parent_id IS NOT NULL`
      )
      .pluck()

    // Seed of the chunk id high-water mark (TODO 965; migration 30 only creates the table). Inserted just once, the first time it is opened.
    this.seedChunkIdSeq()
    // Partial index for "recent files" (TODO 999). Created here, not by a migration (constraint 8.1 — migrations run in main).
    this.ensureRecentIndex()
    // Queue for image OCR (TODO 998 stage 2). Created here rather than by a migration, for the same reason.
    this.ensureImageOcrQueue()

    // Tick the merge (P3). The setting stays in `chunk_fts_config`, so writing it on every connection is cheap.
    db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('crisismerge', ${CRISIS_MERGE})`)
    this.mergeFts = db.prepare(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('merge', ?)`)
    this.totalChanges = db.prepare(`SELECT total_changes() AS t`).pluck()

    // ---- Item 89: statements that used to call `db.prepare` on every call ----
    // A row and the ids of its descendants (the `parent_id` index = migration 6 applies).
    this.selectSubtree = db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM documents WHERE id = ?
           UNION ALL
           SELECT d.id FROM documents d JOIN sub ON d.parent_id = sub.id
         )
         SELECT id FROM sub`
      )
      .pluck()
    this.selectChildIdsIn = db
      .prepare(`SELECT id FROM documents WHERE parent_id IN (SELECT value FROM json_each(?))`)
      .pluck()
    this.selectBySourcePrefix = db
      .prepare(`SELECT id FROM documents WHERE source = ? AND source_id >= ? AND source_id < ?`)
      .pluck()
    this.selectIdsBySource = db.prepare(`SELECT id FROM documents WHERE source = ?`).pluck()
    this.selectSourcesInRange = db
      .prepare(`SELECT DISTINCT source FROM documents WHERE source >= ? AND source < ?`)
      .pluck()
    // TODO 860: conversation documents older than the retention boundary (`updated_at` is the event's `ts`).
    this.selectConversationsBefore = db
      .prepare(
        `SELECT id FROM documents WHERE source = 'conversation' AND source_id >= ? AND source_id < ? AND updated_at < ?`
      )
      .pluck()
    // Item 241: the list of transcript file ids currently in the index, so that launch-time ingestion can drop rows of
    // "files not in the list" (`source_id` is `<fileId>#<messageId>` — only the part before `#` is picked up).
    this.selectTranscriptFileIds = db
      .prepare(
        `SELECT DISTINCT substr(source_id, 1, instr(source_id, '#') - 1) AS fileId
         FROM documents WHERE source = 'transcript' AND source_id IS NOT NULL`
      )
      .pluck()
    // TODO 863: the list of thread ids that currently have conversation documents in the index, so that launch-time cleanup can drop the conversation
    // documents of "threads that are no longer alive" (`source_id` is `<threadId>:<eventId>` — only the part before `:` is picked up).
    this.selectConversationThreadIds = db
      .prepare(
        `SELECT DISTINCT substr(source_id, 1, instr(source_id, ':') - 1) AS threadId
         FROM documents WHERE source = 'conversation' AND instr(source_id, ':') > 1`
      )
      .pluck()
    this.selectChunksOf = db.prepare(
      `SELECT id, seq, byte_start, byte_end FROM chunks WHERE document_id = ? ORDER BY seq`
    )
    this.selectChunkById = db.prepare(`SELECT id, document_id, seq FROM chunks WHERE id = ?`)
    this.countStates = db.prepare(
      `SELECT index_state AS state, COUNT(*) AS n FROM documents GROUP BY index_state`
    )
    this.countChunks = db.prepare(`SELECT COUNT(*) AS c FROM chunks`)
    this.countSegments = db.prepare(
      `SELECT COUNT(DISTINCT id >> 37) AS n FROM chunk_fts_data WHERE id > 100`
    )
    const skipIn = Array.from({ length: SKIP_CHUNK }, () => '?').join(',')
    this.skipFts = db.prepare(
      `DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id IN (${skipIn}))`
    )
    this.skipChunks = db.prepare(`DELETE FROM chunks WHERE document_id IN (${skipIn})`)
    this.skipDocuments = db.prepare(
      `UPDATE documents SET index_state = 'skipped', indexed_at = ? WHERE id IN (${skipIn})`
    )
    // Directories rejected by the scan (item 84). The cap of 1,000 rows is guarded by migration 15's trigger.
    this.selectDenials = db.prepare(
      `SELECT path, code, seen_at FROM scan_denials ORDER BY seen_at DESC LIMIT ?`
    )
  }

  // ---- fs tree ----

  /** The root (`/`) row. Created if absent. */
  ensureRoot(): number {
    if (this.rootId !== null) return this.rootId
    const existing = this.selectChild.get(null, ROOT_NAME) as { id: number } | undefined
    if (existing !== undefined) {
      this.rootId = existing.id
      this.dirCache.set(ROOT_NAME, existing.id)
      return existing.id
    }
    const info = this.db
      .prepare(
        `INSERT INTO documents (source, parent_id, name, name_folded, kind, index_state, seen_at)
         VALUES ('fs', NULL, ?, ?, 'directory', 'skipped', 0) RETURNING id`
      )
      .get(ROOT_NAME, ROOT_NAME) as { id: number }
    this.rootId = info.id
    this.dirCache.set(ROOT_NAME, info.id)
    this.revision += 1
    return info.id
  }

  /**
   * Returns the directory row for an absolute path. Creates it together with its ancestors if absent.
   * The scan comes in order from the parent, so most lookups hit the cache.
   */
  ensureDirectory(absolutePath: string, seenAt: number): number {
    const folded = foldPath(absolutePath)
    const cached = this.dirCache.get(folded)
    if (cached !== undefined) return cached

    let id = this.ensureRoot()
    let current = ''
    for (const segment of absolutePath.split('/')) {
      if (segment === '') continue
      current = `${current}/${segment}`
      const key = foldPath(current)
      const hit = this.dirCache.get(key)
      if (hit !== undefined) {
        id = hit
        continue
      }
      const row = this.insertDir.get({
        parent_id: id,
        name: segment,
        name_folded: foldPath(segment),
        seen_at: seenAt
      }) as { id: number }
      id = row.id
      this.dirCache.set(key, id)
      this.pathCache.set(id, current)
      this.revision += 1
    }
    this.dirCache.set(folded, id)
    this.pathCache.set(id, absolutePath)
    return id
  }

  /** One scan entry. A directory has no body, so it is `skipped` from the start. */
  upsertFsEntry(entry: FsEntryInput): UpsertedRow {
    const version = fsVersion(entry)
    const row = this.insertFs.get({
      parent_id: entry.parentId,
      name: entry.name,
      name_folded: foldPath(entry.name),
      kind: entry.isDirectory ? 'directory' : 'file',
      ext: entry.ext,
      size: entry.size,
      mtime_ms: Math.round(entry.mtimeMs),
      version,
      index_state: entry.isDirectory ? 'skipped' : 'pending',
      seen_at: entry.seenAt
    }) as { id: number; index_state: string }
    if (entry.isDirectory) this.revision += 1
    return { id: row.id, needsContent: row.index_state === 'pending' }
  }

  /**
   * Handles one scan entry **without writing if nothing changed** (incremental scan, 6.2.2).
   *
   * Writes to the encrypted DB cost +77% over plaintext, so if one read can
   * save one write, it is a win. `seen_at` is **not updated** — the incremental scan's cleanup is decided by
   * "the direct children of directories whose mtime changed", not by `seen_at`, so there is no need to mark every row.
   */
  upsertFsEntryIncremental(entry: FsEntryInput): UpsertedRow & {
    readonly existed: boolean
    /** Whether it wrote (differed from last time / is new). */
    readonly changed: boolean
  } {
    const kind = entry.isDirectory ? 'directory' : 'file'
    const previous = this.selectChildMeta.get(entry.parentId, foldPath(entry.name)) as
      | { id: number; kind: string; mtime_ms: number; size: number; version: string }
      | undefined
    if (
      previous !== undefined &&
      previous.kind === kind &&
      previous.mtime_ms === Math.round(entry.mtimeMs) &&
      previous.size === (entry.isDirectory ? 0 : entry.size) &&
      // Whether the file has local content (iCloud download) does not show in mtime / size, so look at the version (TODO 921).
      (entry.isDirectory || previous.version.endsWith(':dataless') === (entry.dataless === true)) &&
      // The extraction version (TODO 997) does not show in mtime / size either. Only for files that get a mark, compare the whole version.
      (entry.isDirectory || extractorTag(entry.name) === '' || previous.version === fsVersion(entry))
    ) {
      return { id: previous.id, needsContent: false, existed: true, changed: false }
    }
    const row = this.upsertFsEntry(entry)
    return { ...row, existed: previous !== undefined, changed: true }
  }

  /**
   * Looks up an fs row by path (null if absent). It walks **caching the ancestors**, so
   * a use like the scan, which looks up in order from the parent, needs only one query per path.
   */
  fsRowAt(absolutePath: string): { id: number; kind: string; mtimeMs: number } | null {
    let id = this.ensureRoot()
    let current = ''
    let row: { id: number; kind: string; mtime_ms: number } | undefined
    for (const segment of absolutePath.split('/')) {
      if (segment === '') continue
      current = `${current}/${segment}`
      const key = foldPath(current)
      const cached = this.dirCache.get(key)
      if (cached !== undefined) {
        id = cached
        row = undefined
        continue
      }
      row = this.selectChildMeta.get(id, foldPath(segment)) as
        | { id: number; kind: string; mtime_ms: number }
        | undefined
      if (row === undefined) return null
      id = row.id
      if (row.kind === 'directory') {
        this.dirCache.set(key, id)
        this.pathCache.set(id, current)
      }
    }
    if (row !== undefined) return { id: row.id, kind: row.kind, mtimeMs: row.mtime_ms }
    // Reached using only the cache (a directory). Read the mtime again.
    const meta = this.selectDocument.get(id) as DocumentRow | undefined
    if (meta === undefined) return null
    return { id: meta.id, kind: meta.kind, mtimeMs: meta.mtime_ms }
  }

  /** The rows directly under a parent (id and folded name). Used by the incremental scan's cleanup. */
  childNames(parentId: number): readonly { id: number; folded: string }[] {
    const rows = this.selectChildNames.all(parentId) as { id: number; name_folded: string }[]
    return rows.map((row) => ({ id: row.id, folded: row.name_folded }))
  }

  /**
   * Resets a directory row's mtime to 0 (= "we do not know the last time") (item 246).
   *
   * When a subtree scan is cut off at its limit, directories remain whose row was recorded but which were **not opened**.
   * If such a row has the real mtime, the next incremental scan's pruning (6.2.2) judges it "same as before",
   * does not open it, and its contents do not enter the index until the deep scan (default 7 days). Reset to 0, it
   * always differs, so the next incremental scan opens it and picks it up, and also cleans up its direct children.
   * It is split into transactions of `STALE_BATCH` rows, yielding in between.
   */
  async forgetDirectoryMtimes(
    ids: readonly number[],
    yieldToLoop: () => Promise<void>
  ): Promise<void> {
    this.forgetMtime ??= this.db.prepare(
      `UPDATE documents SET mtime_ms = 0 WHERE id = ? AND source = 'fs' AND kind = 'directory'`
    )
    const statement = this.forgetMtime
    for (let i = 0; i < ids.length; i += STALE_BATCH) {
      if (i > 0) await yieldToLoop()
      const batch = ids.slice(i, i + STALE_BATCH)
      this.atomically(() => {
        for (const id of batch) statement.run(id)
      })
    }
  }

  /** Remembers a directory row (used as the children's parent id during the scan). */
  rememberDirectory(path: string, id: number): void {
    this.dirCache.set(foldPath(path), id)
    this.pathCache.set(id, path)
  }

  /** Looks up a row id by path. null if absent (does not create). */
  findByPath(absolutePath: string): number | null {
    const folded = foldPath(absolutePath)
    const cached = this.dirCache.get(folded)
    if (cached !== undefined) return cached
    let id = this.ensureRoot()
    for (const segment of absolutePath.split('/')) {
      if (segment === '') continue
      const row = this.selectChild.get(id, foldPath(segment)) as { id: number } | undefined
      if (row === undefined) return null
      id = row.id
    }
    return id
  }

  /** Builds the absolute path from a row id (reconstruction in place of storing the path. 12.4). */
  pathOf(id: number): string | null {
    const cached = this.pathCache.get(id)
    if (cached !== undefined) return cached
    const parts: string[] = []
    let current: number | null = id
    for (let depth = 0; depth < 64 && current !== null; depth += 1) {
      const row = this.selectParent.get(current) as
        | { id: number; parent_id: number | null; name: string }
        | undefined
      if (row === undefined) return null
      if (row.parent_id === null) {
        const path = `/${parts.reverse().join('/')}`
        this.pathCache.set(id, path)
        return path
      }
      parts.push(row.name)
      current = row.parent_id
    }
    return null
  }

  /**
   * The direct children (directories first, in name order. With `sortOrder: 'modified'`, files are newest first by modification time, TODO 872). With `hideDotFiles`, those starting with "." are excluded in SQL
   * (TODO 261. If not narrowed before being cut by `limit`, the hidden ones eat the slots).
   */
  children(
    parentId: number,
    limit: number,
    hideDotFiles = false,
    sortOrder: FileSortOrder = 'name'
  ): readonly ChildRow[] {
    const modified = sortOrder === 'modified'
    const statement = hideDotFiles
      ? modified
        ? this.selectVisibleChildrenModified
        : this.selectVisibleChildren
      : modified
        ? this.selectChildrenModified
        : this.selectChildren
    return statement.all(parentId, limit) as ChildRow[]
  }

  /** Looks up one direct child by its folded name. null if absent. */
  childRow(parentId: number, foldedName: string): ChildRow | null {
    return (this.selectChildRow.get(parentId, foldedName) as ChildRow | undefined) ?? null
  }

  /**
   * One page of file name search (6.6). Returned as raw arrays of `[id, name, parent_id]`
   * — a million rows are read per query, so creating an object per row would matter.
   */
  scanFsNames(afterId: number, limit: number): readonly (readonly [number, string, number | null])[] {
    return this.scanNames.all(afterId, limit) as (readonly [number, string, number | null])[]
  }

  /**
   * The fs rows `[id, name, parent_id]` directly under the given directories (item 100, walks the cwd subtree first).
   * The statement is a single one with `PARENT_BATCH` `?` placeholders, and any shortfall is padded by repeating the last id
   * (duplicates in `IN` do not change the result. The same shape as `markSkippedBulk`, item 89).
   * It looks up via `documents_tree (parent_id, name_folded) WHERE source = 'fs'` and reads only the name from the table.
   */
  fsNamesByParents(
    parentIds: readonly number[]
  ): readonly (readonly [number, string, number | null])[] {
    const out: (readonly [number, string, number | null])[] = []
    for (let start = 0; start < parentIds.length; start += PARENT_BATCH) {
      const slice = parentIds.slice(start, start + PARENT_BATCH)
      const last = slice[slice.length - 1]
      if (last === undefined) break
      while (slice.length < PARENT_BATCH) slice.push(last)
      // **`INDEXED BY` is required** (the same pitfall as T8). Without it SQLite sees only the equality
      // condition `source = 'fs'`, picks `documents_seen`, and scans all fs rows for every statement
      // (EQP `SEARCH documents USING INDEX documents_seen (source=?)`).
      this.namesByParents ??= this.db
        .prepare(
          `SELECT id, name, parent_id FROM documents INDEXED BY documents_tree
           WHERE source = 'fs'
             AND parent_id IN (${Array.from({ length: PARENT_BATCH }, () => '?').join(',')})`
        )
        .raw()
      const rows = this.namesByParents.all(...slice) as (readonly [number, string, number | null])[]
      for (const row of rows) out.push(row)
    }
    return out
  }

  /** All fs directory rows `[id, parent_id, name]` (material for the path table, 6.6). */
  fsDirectories(): readonly (readonly [number, number | null, string])[] {
    return this.listDirs.all() as (readonly [number, number | null, string])[]
  }

  /** Looks up by id as is (used only for the top N search results). */
  entriesByIds(ids: readonly number[]): readonly (ChildRow & { parent_id: number | null })[] {
    const rows: (ChildRow & { parent_id: number | null })[] = []
    for (const id of ids) {
      const row = this.selectEntries.get(id) as (ChildRow & { parent_id: number | null }) | undefined
      if (row !== undefined) rows.push(row)
    }
    return rows
  }

  getDocument(id: number): DocumentRow | null {
    return (this.selectDocument.get(id) as DocumentRow | undefined) ?? null
  }

  getBySourceId(source: string, sourceId: string): DocumentRow | null {
    return (this.selectBySource.get(source, sourceId) as DocumentRow | undefined) ?? null
  }

  /**
   * TODO 1235: exact-string uri match inside ONE non-fs source (the SQL filters on `source` too, so there is no
   * post-filtering in JS that a LIMIT could starve). A bare uri scan over every source is deliberately not offered.
   */
  findNonFsByUri(source: string, uri: string): DocumentRow[] {
    return this.selectNonFsByUri.all(source, uri) as DocumentRow[]
  }

  // ---- Sources other than fs (conversations, transcripts, future plugins) ----

  upsertDocument(input: {
    source: string
    sourceId: string
    uri: string
    name: string
    kind: DocumentKind
    updatedAt: number
    version: string
    exposure: Exposure
    metadata: Record<string, unknown>
    seenAt: number
  }): UpsertedRow {
    const row = this.upsertDoc.get({
      source: input.source,
      source_id: input.sourceId,
      uri: input.uri,
      name: input.name,
      name_folded: foldPath(input.name),
      kind: input.kind,
      updated_at: input.updatedAt,
      version: input.version,
      exposure: input.exposure,
      metadata: JSON.stringify(input.metadata),
      seen_at: input.seenAt
    }) as { id: number; index_state: string }
    return { id: row.id, needsContent: row.index_state === 'pending' }
  }

  // ---- Chunks and FTS ----

  /**
   * Replaces a document's chunks. **Delete → insert happens in one transaction**.
   * It is contentless FTS5 (`contentless_delete=1`), so DELETE works as is.
   */
  replaceChunks(
    documentId: number,
    chunks: readonly ChunkInput[],
    meta: { state: IndexRowState; contentHash: string | null; lang: string | null }
  ): void {
    this.atomically(() => {
      this.deleteFtsForDocument.run(documentId)
      this.deleteChunks.run(documentId)
      if (chunks.length > 0) {
        // Assign ids above the high-water mark (TODO 965). A rowid that has been handed out is never handed out again.
        let id = this.nextChunkBase()
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]
          if (chunk === undefined) continue
          id += 1
          this.insertChunk.run(id, documentId, i, chunk.byteStart, chunk.byteEnd, chunk.chars)
          this.insertFts.run(id, chunk.shadow)
        }
        this.saveChunkHighWater(id)
      }
      this.setState.run(meta.state, Date.now(), meta.contentHash, meta.lang, documentId)
      this.clearFailure.run(documentId)
    })
  }

  /**
   * The value just before the next chunk id to assign (TODO 965). The largest of the high-water mark (`chunk_id_seq.last_id`), the max of `chunks`, and the max of
   * `chunk_fts` (`chunk_fts_docsize`). The latter two only read the end of the primary key, so they are cheap, and they are insurance so that
   * even if something got in above the high-water mark (an old version, a row a test inserted directly), that rowid is not handed out.
   */
  private nextChunkBase(): number {
    this.selectChunkBase ??= this.db
      .prepare(
        `SELECT max(
           COALESCE((SELECT last_id FROM chunk_id_seq WHERE id = 1), 0),
           COALESCE((SELECT max(id) FROM chunks), 0),
           COALESCE((SELECT max(id) FROM chunk_fts_docsize), 0)
         )`
      )
      .pluck()
    return this.selectChunkBase.get() as number
  }

  /**
   * Seed of `chunk_id_seq` (TODO 965). Inserted only when there is no row (every launch costs just one `NOT EXISTS`).
   *
   * - `rebuild_below` = the max id of `chunks` and `chunk_fts_docsize` (the contentless FTS's per-row table). The rebuild range
   *   (all existing chunks are below it). Both only read the end of the primary key, so it is cheap.
   * - `last_id` = that plus `CHUNK_ID_SEED_MARGIN`. **The true max of rowids that remain in FTS only as terms cannot be found cheaply**:
   *   the top rowid that was reused by the old "max + 1" and then deleted is in neither `chunks` nor the per-row table, and its terms exist only inside a segment's
   *   doclist (found only by scanning everything). So we start handing out ids well away from the current max. A DB where FTS has
   *   no segment at all (= no terms at all) takes no margin.
   */
  private seedChunkIdSeq(): void {
    // `exec` (no prepare): a one-off statement at build time. The margin is a constant, so it is filled in as is.
    this.db.exec(`
      INSERT INTO chunk_id_seq (id, last_id, rebuild_below)
        SELECT 1, m + (CASE WHEN EXISTS (SELECT 1 FROM chunk_fts_data WHERE id > 10) THEN ${CHUNK_ID_SEED_MARGIN} ELSE 0 END), m
        FROM (
          SELECT max(
            COALESCE((SELECT max(id) FROM chunks), 0),
            COALESCE((SELECT max(id) FROM chunk_fts_docsize), 0)
          ) AS m
        )
        WHERE NOT EXISTS (SELECT 1 FROM chunk_id_seq)
    `)
  }

  /**
   * Creates `documents_recent` (TODO 999) if absent. A partial index that `IndexStore.recentFsFiles` uses to walk fs file rows in newest `mtime_ms` order
   * (id = rowid is appended at the end of the index, so the second sort key works too). In wave 53 it was originally created by migration 31, but
   * migrations run on main's JS thread (constraint 8.1), so it is created when the index process opens. Every launch only passes through
   * `IF NOT EXISTS`, and the creation happens only once, on a DB that has not yet had 31's contents applied (a few seconds at 1 million rows; it only delays the index process's startup and
   * does not stall the window). If it cannot be created (out of space, etc.), it falls back to queries that do not name the index, so we do not crash here.
   */
  private ensureRecentIndex(): void {
    try {
      // `exec` (no prepare): a one-off statement at build time.
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS documents_recent ON documents (mtime_ms) WHERE source = 'fs' AND kind = 'file'`
      )
    } catch {
      // recentFsFiles falls back to queries that do not name the index.
    }
  }

  /**
   * Creates `image_ocr_queue` (TODO 998 stage 2) if absent. A small table holding the images (`documents.id`) that finished classification and have no OCR mark yet, together with their
   * `mtime_ms` (an ordering for OCR-ing newest first; it avoids scanning `documents` fully via JSON). Rows are removed together with the document on deletion (ON DELETE CASCADE). Its contents are added by `setFsLossy` when it writes the classification result, and
   * removed when the OCR result (the mark) is written.
   * It only creates an empty table and index, so it is fast. If it cannot be created, only the OCR stage does not run; nothing else changes.
   */
  private ensureImageOcrQueue(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS image_ocr_queue (
          document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
          mtime_ms    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS image_ocr_queue_mtime ON image_ocr_queue (mtime_ms DESC, document_id DESC)
      `)
      this.imageOcrQueueReady = true
    } catch {
      this.imageOcrQueueReady = false
    }
  }

  private imageOcrQueueReady = false
  private upsertOcrQueue: Statement | null = null
  private deleteOcrQueue: Statement | null = null
  private selectOcrQueue: Statement | null = null

  /**
   * Returns up to `limit` images from the head of the OCR queue, newest first (`indexed`, and images that stay `skipped` with empty terms waiting for a mark).
   * **Read-only** (the only write is `dequeueOcr`, inside the sole writer's column — `IndexService.enqueue`). Rows that should be removed
   * (gone, `failed`) are returned in `stale`, and the caller removes them inside the column (leaving them would block the head). `pending` rows are kept
   * (once re-indexing finishes, `setFsLossy` adds them again). `exclude` is rows not to take now (those waiting for a retry after a timeout).
   */
  ocrCandidates(
    limit: number,
    exclude: ReadonlySet<number> = new Set()
  ): {
    readonly rows: readonly { readonly id: number; readonly version: string; readonly metadata: string | null; readonly content_hash: string | null }[]
    readonly stale: readonly number[]
  } {
    if (!this.imageOcrQueueReady) return { rows: [], stale: [] }
    this.selectOcrQueue ??= this.db.prepare(`
      SELECT q.document_id AS id, d.id AS doc, d.index_state AS state, d.version, d.metadata, d.content_hash
      FROM image_ocr_queue q LEFT JOIN documents d ON d.id = q.document_id
      ORDER BY q.mtime_ms DESC, q.document_id DESC LIMIT ?
    `)
    const rows = this.selectOcrQueue.all(Math.max(limit * 8, 16) + exclude.size) as {
      id: number
      doc: number | null
      state: string | null
      version: string
      metadata: string | null
      content_hash: string | null
    }[]
    const out: { id: number; version: string; metadata: string | null; content_hash: string | null }[] = []
    const stale: number[] = []
    for (const row of rows) {
      if (row.doc === null || row.state === 'failed') {
        stale.push(row.id)
        continue
      }
      // `skipped` is an image with empty terms (a screenshot of only text) or one that became out of scope. The latter leaves after one OCR.
      if (row.state !== 'indexed' && row.state !== 'skipped') continue
      if (exclude.has(row.id)) continue
      if (out.length < limit) out.push({ id: row.id, version: row.version, metadata: row.metadata, content_hash: row.content_hash })
    }
    return { rows: out, stale }
  }

  /** Removes from the OCR queue (images whose OCR finished, or that cannot be read). */
  dequeueOcr(documentId: number): void {
    if (!this.imageOcrQueueReady) return
    this.deleteOcrQueue ??= this.db.prepare(`DELETE FROM image_ocr_queue WHERE document_id = ?`)
    this.deleteOcrQueue.run(documentId)
  }

  /** Number of entries in the OCR queue (for tests and logs). */
  ocrQueueSize(): number {
    if (!this.imageOcrQueueReady) return 0
    return (this.db.prepare(`SELECT count(*) FROM image_ocr_queue`).pluck().get() as number) ?? 0
  }

  private enqueueOcr(documentId: number): void {
    if (!this.imageOcrQueueReady) return
    this.upsertOcrQueue ??= this.db.prepare(
      `INSERT OR REPLACE INTO image_ocr_queue (document_id, mtime_ms) SELECT id, mtime_ms FROM documents WHERE id = ?`
    )
    this.upsertOcrQueue.run(documentId)
  }

  private saveChunkHighWater(lastId: number): void {
    this.upsertChunkHighWater ??= this.db.prepare(
      `INSERT INTO chunk_id_seq (id, last_id, rebuild_below) VALUES (1, ?, 0)
         ON CONFLICT (id) DO UPDATE SET last_id = max(last_id, excluded.last_id)`
    )
    this.upsertChunkHighWater.run(lastId)
  }

  /**
   * The high-water mark as of migration 30 (TODO 965). Chunks with ids at or below it may have earlier terms mixed into FTS because of
   * rowid reuse. 0 if the table is absent or empty (nothing to rebuild).
   */
  ftsRebuildBelow(): number {
    this.selectRebuildBelow ??= this.db
      .prepare(`SELECT COALESCE((SELECT rebuild_below FROM chunk_id_seq WHERE id = 1), 0)`)
      .pluck()
    return this.selectRebuildBelow.get() as number
  }

  /**
   * Widens the rebuild range up to the current high-water mark (TODO 1152). When the way the shadow text is made changes, documents that have chunks put in before then are
   * re-indexed through 965's rebuild entry point. A DB with no chunks at all (first launch) stays at 0.
   * The return value is the new `rebuild_below`.
   */
  raiseFtsRebuildBelow(): number {
    const high = this.nextChunkBase()
    this.db
      .prepare(
        `INSERT INTO chunk_id_seq (id, last_id, rebuild_below) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET rebuild_below = max(rebuild_below, excluded.rebuild_below)`
      )
      .run(high, high)
    return this.ftsRebuildBelow()
  }

  /**
   * Rebuild candidates (TODO 965): within `(after, after + window]` of `documents.id`, indexed documents that have chunks with ids at or below `below`,
   * in ascending id order, up to `limit`. The rowid is in the leaf of the `chunks_document` (document_id, seq) index,
   * so `EXISTS` does not need to look up the table.
   */
  ftsRebuildCandidates(
    after: number,
    window: number,
    below: number,
    limit: number
  ): readonly { readonly id: number; readonly source: string }[] {
    this.selectRebuildCandidates ??= this.db.prepare(`
      SELECT d.id, d.source FROM documents d
      WHERE d.id > ? AND d.id <= ? AND d.index_state = 'indexed'
        AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id AND c.id <= ?)
      ORDER BY d.id
      LIMIT ?
    `)
    return this.selectRebuildCandidates.all(after, after + window, below, limit) as {
      id: number
      source: string
    }[]
  }

  /**
   * Puts an indexed document back to `pending` (TODO 965's rebuild). The normal build (`runBuild`) re-reads the canonical copy, and
   * `replaceChunks` deletes the old chunks and re-inserts them with new ids above the high-water mark. **The old terms cannot be removed from FTS**
   * (a contentless_delete DELETE places a tombstone only on the last inserted version), but no chunk holds that rowid any more and it is never handed out again,
   * so search (the JOIN with `chunks`) no longer matches it.
   * The chunks remain until the build rewrites them, so they can still be matched by search in the meantime.
   */
  requeueIndexed(documentId: number): boolean {
    this.requeueDocument ??= this.db.prepare(
      `UPDATE documents SET index_state = 'pending' WHERE id = ? AND index_state = 'indexed'`
    )
    return this.requeueDocument.run(documentId).changes > 0
  }

  /**
   * Marks a document that gets no body. **It is not put in the dead letter** — files with
   * out-of-scope extensions and binaries are not "failures", so `index_failures` is used only for real failures.
   */
  markSkipped(documentId: number): void {
    this.atomically(() => {
      this.deleteFtsForDocument.run(documentId)
      this.deleteChunks.run(documentId)
      this.setState.run('skipped', Date.now(), null, null, documentId)
    })
  }

  /**
   * Drops in bulk documents known to be out of scope from the extension alone.
   *
   * In a whole-PC scan **more are out of scope** (over 130,000 on the real machine). Opening
   * a transaction for each makes the marking cost more than the indexing itself (measured in Phase 3).
   */
  markSkippedBulk(documentIds: readonly number[]): void {
    if (documentIds.length === 0) return
    const now = Date.now()
    this.atomically(() => {
      // Fixed-length statements of `SKIP_CHUNK` ids (item 89). The remainder is padded by repeating the last id.
      for (let start = 0; start < documentIds.length; start += SKIP_CHUNK) {
        const ids = documentIds.slice(start, start + SKIP_CHUNK)
        const last = ids[ids.length - 1] as number
        while (ids.length < SKIP_CHUNK) ids.push(last)
        // What was already indexed may change to out of scope, so drop the derived data too.
        this.skipFts.run(...ids)
        this.skipChunks.run(...ids)
        this.skipDocuments.run(now, ...ids)
      }
    })
  }

  markFailed(documentId: number, reason: string): void {
    this.atomically(() => {
      // If the old version's chunks and FTS rows remain, it would match on the previous terms and read the new file with the old byte ranges,
      // producing an unrelated excerpt (TODO 1128). Delete them the same as `markSkipped`.
      this.deleteFtsForDocument.run(documentId)
      this.deleteChunks.run(documentId)
      this.setState.run('failed', Date.now(), null, null, documentId)
      this.recordFailure.run(documentId, reason, Date.now())
    })
  }

  /**
   * Sets / clears the "decoding does not round-trip to the original bytes" mark on an fs row (TODO 925). Puts
   * `{"lossy":true}` in `metadata` (fs rows use `metadata` for nothing else. It holds no body — constraint 9).
   * It does not write when nothing changes (`IS NOT`).
   */
  setFsLossy(
    documentId: number,
    lossy: boolean,
    pdfPages?: readonly number[],
    /** Image classification labels (TODO 998, `StoredImageLabels`). An attribute of the image, not a body (the constraint 9 reasoning is in ARCHITECTURE 6.2.7). */
    image?: StoredImageLabels
  ): void {
    this.updateFsLossy ??= this.db.prepare(
      `UPDATE documents SET metadata = ? WHERE id = ? AND source = 'fs' AND metadata IS NOT ?`
    )
    // PDF page boundaries (TODO 1009 stage 2): the byte position of the start of each page. No body is held (constraint 9).
    // A PDF never becomes a row where decoding does not round-trip (`lossy` is false), so the two never coexist.
    // Images likewise never coexist with the others (an image has neither decoding nor pages).
    const value =
      pdfPages !== undefined && pdfPages.length > 0
        ? JSON.stringify({ pdfPages })
        : image !== undefined
          ? JSON.stringify({ image })
          : lossy
          ? LOSSY_METADATA
          : null
    this.updateFsLossy.run(value, documentId, value)
    // Image: if there is no OCR mark, put it in the queue (OCR newest first). If there is a mark (done / none / failed), take it out.
    if (image !== undefined) {
      if (image.ocr === undefined) this.enqueueOcr(documentId)
      else this.dequeueOcr(documentId)
    }
  }

  /**
   * Looks at `limit` rowids of `chunk_fts` after `after`, and deletes those not in `chunks` (orphans) (TODO 945).
   * The caller calls it inside the sole writer's column (`IndexService.enqueue`).
   *
   * - A full scan of a contentless table reads `chunk_fts_docsize` (`rowid > ?` is `INDEX 64:>` = a range scan).
   *   Neither the body nor the shadow text is needed.
   * - It is `contentless_delete = 1` (migration 3), so the original terms are not needed to delete (an ordinary `DELETE` leaves a tombstone).
   *
   * @returns The last rowid seen (null if there are no more) and the number deleted.
   */
  sweepOrphanFts(after: number, limit: number): { readonly last: number | null; readonly removed: number } {
    this.selectFtsRowids ??= this.db
      .prepare(`SELECT rowid FROM chunk_fts WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .pluck()
    this.selectMissingChunks ??= this.db
      .prepare(
        `SELECT value FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.id = json_each.value)`
      )
      .pluck()
    this.deleteFtsRows ??= this.db.prepare(
      `DELETE FROM chunk_fts WHERE rowid IN (SELECT value FROM json_each(?))`
    )
    const rowids = this.selectFtsRowids.all(after, limit) as number[]
    if (rowids.length === 0) return { last: null, removed: 0 }
    const orphans = this.selectMissingChunks.all(JSON.stringify(rowids)) as number[]
    if (orphans.length > 0) this.deleteFtsRows.run(JSON.stringify(orphans))
    return { last: rowids[rowids.length - 1] as number, removed: orphans.length }
  }

  /**
   * Candidates for retroactively attaching the mark (`lossy` of TODO 925) (TODO 946): fs files in the id range `(after, after + window]` that are
   * indexed and have no mark. We cut by range so that one query's work is bounded even in a stretch with few candidates.
   */
  lossyCandidates(
    after: number,
    window: number
  ): readonly { readonly id: number; readonly parent_id: number; readonly name: string; readonly version: string }[] {
    this.selectLossyCandidates ??= this.db.prepare(`
      SELECT id, parent_id, name, version FROM documents
      WHERE id > ? AND id <= ? AND source = 'fs' AND kind = 'file' AND index_state = 'indexed'
        AND metadata IS NULL AND parent_id IS NOT NULL
      ORDER BY id
    `)
    return this.selectLossyCandidates.all(after, after + window) as {
      id: number
      parent_id: number
      name: string
      version: string
    }[]
  }

  /**
   * Candidates for re-attaching the extraction version (TODO 997): fs files in the id range `(after, after + window]` whose extension is one
   * whose extracted text is indexed. Whether the version matches the current mark is checked by the caller (`retagFsVersion`).
   */
  derivedRequeueCandidates(
    after: number,
    window: number
  ): readonly {
    readonly id: number
    readonly name: string
    readonly ext: string
    readonly version: string
    readonly index_state: string
  }[] {
    // The extensions are fixed constants (not user input), so they are embedded in the statement. For text extensions added later (TODO 1089),
    // only `skipped` rows (they have no version mark, so the caller decides by `index_state` whether to put them back).
    const list = (exts: readonly string[]): string => exts.map((ext) => `'${ext}'`).join(', ')
    this.selectDerivedCandidates ??= this.db.prepare(`
      SELECT id, name, ext, version, index_state FROM documents
      WHERE id > ? AND id <= ? AND source = 'fs' AND kind = 'file'
        AND (ext IN (${list(DERIVED_TEXT_EXTENSIONS)})
          OR (ext IN (${list(LATE_TEXT_EXTENSIONS)}) AND index_state = 'skipped'))
      ORDER BY id
    `)
    return this.selectDerivedCandidates.all(after, after + window) as {
      id: number
      name: string
      ext: string
      version: string
      index_state: string
    }[]
  }

  /**
   * Puts back to `pending` the `skipped` rows of kinds added later to the extension table (TODO 1089). The version is not changed. Only rows that are still `skipped`
   * with the version as read (if a scan or the watcher rewrote it in between, that one decides the state). Returns true if put back.
   */
  requeueSkippedFs(documentId: number, version: string): boolean {
    this.updateRequeueSkipped ??= this.db.prepare(
      `UPDATE documents SET index_state = 'pending' WHERE id = ? AND source = 'fs' AND version = ? AND index_state = 'skipped'`
    )
    return this.updateRequeueSkipped.run(documentId, version).changes > 0
  }

  /**
   * Re-attaches the version of an fs row and puts it back to `pending` (TODO 997). Only rows still at the version as read (if a scan or the
   * watcher rewrote it in between, that one wrote the current version). Returns true if put back.
   */
  retagFsDocument(documentId: number, previous: string, next: string): boolean {
    this.updateDerivedVersion ??= this.db.prepare(
      `UPDATE documents SET version = ?, index_state = 'pending' WHERE id = ? AND source = 'fs' AND version = ?`
    )
    return this.updateDerivedVersion.run(next, documentId, previous).changes > 0
  }

  /** sha256 of the text as indexed (`content_hash`). null if absent (not indexed, or no row) (TODO 1009). */
  contentHashOf(documentId: number): string | null {
    this.selectContentHash ??= this.db.prepare(`SELECT content_hash FROM documents WHERE id = ?`).pluck()
    return (this.selectContentHash.get(documentId) as string | null | undefined) ?? null
  }

  /** The max id of `documents` (the end of TODO 946's retroactive pass). 0 if empty. */
  maxDocumentId(): number {
    this.selectMaxDocumentId ??= this.db.prepare(`SELECT COALESCE(MAX(id), 0) FROM documents`).pluck()
    return this.selectMaxDocumentId.get() as number
  }

  /**
   * The retroactive mark (TODO 946). Written only to rows that are still at the version as read, indexed, and without a mark
   * (a row that changed while being read gets its mark again through re-indexing). Returns true if written.
   */
  markFsLossyIfUnchanged(documentId: number, version: string): boolean {
    this.updateLossyIfUnchanged ??= this.db.prepare(
      `UPDATE documents SET metadata = ? WHERE id = ? AND source = 'fs' AND version = ?
         AND index_state = 'indexed' AND metadata IS NULL`
    )
    return this.updateLossyIfUnchanged.run(LOSSY_METADATA, documentId, version).changes > 0
  }

  /** The row's current version (TODO 922). null if there is no row. */
  versionOf(documentId: number): string | null {
    this.selectVersion ??= this.db.prepare(`SELECT version FROM documents WHERE id = ?`).pluck()
    return (this.selectVersion.get(documentId) as string | undefined) ?? null
  }

  /** Takes documents awaiting a body, oldest first (the restart position of the index build is held by this state). */
  pending(limit: number): readonly DocumentRow[] {
    return this.selectPending.all(limit) as DocumentRow[]
  }

  /**
   * Up to `limit` ids of documents awaiting a body in the subtree of `rootId` (including the root) (item 249).
   * The recursive CTE's `UNION ALL` takes from the head of the queue, so the order is **shallowest first** (breadth-first) —
   * when cut at the limit, the direct children of the working folder go in first. Children are looked up by `documents_parent`.
   */
  pendingInSubtree(rootId: number, limit: number): readonly number[] {
    this.selectPendingInSubtree ??= this.db
      .prepare(
        `WITH RECURSIVE sub(id, state) AS (
           SELECT id, index_state FROM documents WHERE id = ?
           UNION ALL
           SELECT d.id, d.index_state FROM documents d JOIN sub ON d.parent_id = sub.id
         )
         SELECT id FROM sub WHERE state = 'pending' LIMIT ?`
      )
      .pluck()
    return this.selectPendingInSubtree.all(rootId, limit) as number[]
  }

  /** Of `ids`, the rows still awaiting a body (item 249. Built or gone rows drop out). In id order. */
  pendingAmong(ids: readonly number[]): readonly DocumentRow[] {
    if (ids.length === 0) return []
    this.selectPendingAmong ??= this.db.prepare(`
      SELECT id, source, parent_id, name, kind, source_id, uri, ext, size, mtime_ms,
             updated_at, version, lang, exposure, metadata, index_state
      FROM documents
      WHERE id IN (SELECT value FROM json_each(?)) AND index_state = 'pending'
      ORDER BY id
    `)
    return this.selectPendingAmong.all(JSON.stringify(ids)) as DocumentRow[]
  }

  // ---- Deletion (tombstone, 6.2) ----

  /** Deletes one document and its derived data (chunks, FTS rows). */
  removeDocument(id: number): void {
    this.atomically(() => {
      this.deleteFtsForDocument.run(id)
      this.deleteChunks.run(id)
      this.deleteDocument.run(id)
    })
    this.pathCache.delete(id)
    this.revision += 1
  }

  /** Deletes an fs subtree (a directory deleted or moved). */
  removeSubtree(id: number): void {
    const ids = this.selectSubtree.all(id) as number[]
    this.atomically(() => {
      for (const rowId of ids) {
        this.deleteFtsForDocument.run(rowId)
        this.deleteChunks.run(rowId)
      }
      // Children are deleted by ON DELETE CASCADE.
      this.deleteDocument.run(id)
    })
    for (const rowId of ids) {
      this.pathCache.delete(rowId)
    }
    this.dirCache.clear()
    this.rootId = null
    this.revision += 1
  }

  /**
   * Drops fs rows that the scan did not see (reflecting deletions and moves).
   *
   * **It does not delete with a single DELETE.** It used to, and on a 2.9 GB encrypted DB it
   * stalled the main thread for 100 seconds (the hang report's stacks were all
   * `sqlite3_step → sqlite3BtreeNext → DecryptPageChaCha20Cipher`).
   * What helped was both the index added in migration 6 and the batching here:
   *
   * - Without `documents_parent`, the foreign key CASCADE becomes a full scan per row.
   * - Even with the index, a large count makes one long transaction, so
   *   it is split into `STALE_BATCH` rows with `yieldToLoop` in between.
   *
   * **It is done in two stages.** Deleting a document row removes its children through `ON DELETE CASCADE`,
   * so a row that should have been in a later batch may disappear first. `chunk_fts` is a virtual table and
   * CASCADE does not apply, so **before deleting even one document row**, the FTS rows of all targets are dropped.
   * Otherwise FTS rows pointing at deleted chunks remain as orphans.
   *
   * It does not break if it stops midway: the remaining rows keep their old `seen_at`,
   * so the next scan's cleanup picks them up.
   *
   * Premise: **the children of an old directory row are always old.** When the scan sees a directory it
   * always writes `seen_at` with this run's value, so if the parent is old, the children were not seen either.
   * (If the watcher refreshed only a child during a scan, this premise breaks. Previously that child's FTS rows
   *  remained as orphans and, through reuse of `chunks.id` rowids, matched another document — TODO 923
   *  widened the targets to descendants before deleting.)
   *
   * @param yieldToLoop What to wait on between batches. Inserted to free the main thread.
   * @returns The number of document rows cleaned up. It returns **the number of targets**, not the `changes` of `DELETE`.
   *   Deleting a directory removes its children by `ON DELETE CASCADE`, so the sum of `changes` comes out
   *   smaller than the number actually deleted (on a real machine, one directory + 5,000 children gave a
   *   `changes` total of 2). All targets are deleted, so the count of targets matches reality better.
   */
  async removeStale(
    seenAt: number,
    yieldToLoop: () => Promise<void>,
    keepSubtrees: readonly number[] = []
  ): Promise<number> {
    let ids = this.selectStale.all(seenAt) as number[]
    if (ids.length > 0 && keepSubtrees.length > 0) {
      // A tree not walked this time (an allowed volume that is not mounted) is not "gone" but
      // "absent", so keep it. The premise is that the caller has touched its ancestors with `ensureDirectory`.
      const keep = new Set<number>()
      for (const rootId of keepSubtrees) for (const id of this.subtreeIds(rootId)) keep.add(id)
      ids = ids.filter((id) => !keep.has(id))
    }
    if (ids.length === 0) return 0
    // Even when the watcher refreshed only a child during the scan (a new child under an old parent), that child is deleted by CASCADE.
    // Widen to descendants before deleting so that FTS rows do not become orphans (TODO 923).
    await this.deleteDocuments(await this.withDescendants(ids, yieldToLoop), yieldToLoop)
    return ids.length
  }

  /**
   * The ids of `ids` and their descendants (no duplicates). Deleting a document row removes descendants through `ON DELETE CASCADE`, but
   * `chunk_fts` is a virtual table and CASCADE does not apply, so before deleting we collect the descendants and drop their FTS rows (TODO 923).
   * `chunks.id` is not AUTOINCREMENT, so an orphan FTS row matches another document through rowid reuse.
   *
   * **One level at a time, looking up `STALE_BATCH` parents together, with `yieldToLoop` between batches** (wave 49 review).
   * It used to run a recursive subtree query synchronously for each id, so in a 100,000-item cleanup 100,000 queries piled up
   * before `deleteDocuments`'s first yield, and the index process froze.
   * The number of queries now is (number of targets and descendants / `STALE_BATCH` + tree depth), not proportional to the number of targets.
   */
  private async withDescendants(
    ids: readonly number[],
    yieldToLoop: () => Promise<void>
  ): Promise<number[]> {
    const all = new Set<number>(ids)
    let frontier = [...all]
    while (frontier.length > 0) {
      const next: number[] = []
      for (let i = 0; i < frontier.length; i += STALE_BATCH) {
        const batch = frontier.slice(i, i + STALE_BATCH)
        for (const child of this.selectChildIdsIn.all(JSON.stringify(batch)) as number[]) {
          if (all.has(child)) continue
          all.add(child)
          next.push(child)
        }
        await yieldToLoop()
      }
      frontier = next
    }
    return [...all]
  }

  /**
   * Deletes the given rows a little at a time, together with their derived data (FTS, chunks).
   *
   * It is **done in two stages** because deleting a document row removes children through `ON DELETE CASCADE`.
   * `chunk_fts` is a virtual table and CASCADE does not apply, so **before deleting even one document row**,
   * the FTS rows of all targets are dropped. Otherwise orphan FTS rows remain.
   * It is split into `STALE_BATCH` rows with `yieldToLoop` in between (so that the count
   * does not directly become stall time). Deletions in the watcher's delta application (`FsIndexer.applyChanges`) also
   * go through here (item 87).
   */
  async deleteDocuments(
    ids: readonly number[],
    yieldToLoop: () => Promise<void>
  ): Promise<void> {
    if (ids.length === 0) return
    const dropDerived = (batch: readonly number[]): void => {
      this.atomically(() => {
        for (const id of batch) {
          this.deleteFtsForDocument.run(id)
          this.deleteChunks.run(id)
        }
      })
    }
    for (let i = 0; i < ids.length; i += STALE_BATCH) {
      dropDerived(ids.slice(i, i + STALE_BATCH))
      await yieldToLoop()
    }

    const dropDocuments = (batch: readonly number[]): void => {
      this.atomically(() => {
        for (const id of batch) this.deleteDocument.run(id)
      })
      // Discard the cache right where the rows are deleted (in the synchronous section) (TODO 1113). If done only once after the wait,
      // another writer's `ensureDirectory` in between would return a deleted id, and with id reuse a row could end up with itself as its parent.
      this.dirCache.clear()
      this.pathCache.clear()
      this.rootId = null
    }
    for (let i = 0; i < ids.length; i += STALE_BATCH) {
      dropDocuments(ids.slice(i, i + STALE_BATCH))
      await yieldToLoop()
    }

    this.revision += 1
  }

  /**
   * **Scoped cleanup** (incremental scan, 6.2.2). Deletes only "rows that are directly under this directory and
   * do not exist now". It does not look at `seen_at`, so
   * **it never touches roots not walked this time or trees that were pruned**.
   *
   * The caller (`FsService`) passes only directories whose mtime changed.
   * A directory's mtime always changes when entries directly under it are added or removed,
   * so "what disappeared" always shows up as a change in its parent's mtime.
   *
   * @param entries The parent's row id and the names directly under it that exist now (already folded)
   */
  async removeMissingChildren(
    entries: readonly { parentId: number; present: ReadonlySet<string> }[],
    yieldToLoop: () => Promise<void>,
    keepIds: readonly number[] = []
  ): Promise<number> {
    const keep = new Set(keepIds)
    const ids: number[] = []
    for (const entry of entries) {
      for (const child of this.childNames(entry.parentId)) {
        if (entry.present.has(child.folded)) continue
        if (keep.has(child.id)) continue
        ids.push(child.id)
      }
    }
    if (ids.length === 0) return 0
    // If a directory was deleted, grandchildren and below are also deleted by CASCADE. Widen to descendants so FTS rows do not become orphans (TODO 923).
    await this.deleteDocuments(await this.withDescendants(ids, yieldToLoop), yieldToLoop)
    return ids.length
  }

  /** The ids of a row and its descendants (the `parent_id` index = migration 6 applies). */
  subtreeIds(rootId: number): readonly number[] {
    return this.selectSubtree.all(rootId) as number[]
  }

  /** List of transcript file ids currently in the index (item 241, no duplicates). */
  transcriptFileIds(): readonly string[] {
    return this.selectTranscriptFileIds.all() as string[]
  }

  /** List of thread ids that currently have conversation documents in the index (TODO 863, no duplicates). */
  conversationThreadIds(): readonly string[] {
    return this.selectConversationThreadIds.all() as string[]
  }

  /**
   * Deletion per source (such as the conversation documents when a thread is deleted).
   *
   * The prefix match is made a range condition (`source_id >= prefix AND source_id < upper bound`). A case-insensitive
   * `LIKE` cannot use the BINARY `documents_source` index and became a full scan of documents every time (wave 42 code-review).
   */
  removeBySourcePrefix(source: string, prefix: string): number {
    const range = prefixRange(prefix)
    const ids = (
      range === null
        ? this.selectIdsBySource.all(source)
        : this.selectBySourcePrefix.all(source, range.from, range.to)
    ) as number[]
    return this.deleteDocumentsByIds(ids)
  }

  /**
   * TODO 1237: the list of document sources in the namespace of extension `pluginId` (`<id>` itself, `<id>:…`, `<id>/…`) (no duplicates).
   * The final namespace decision (`indexSourceOwnedBy`) is applied by the caller — this only narrows by range (`LIKE` cannot use the index).
   */
  pluginSourcesOf(pluginId: string): string[] {
    const out = new Set<string>([pluginId])
    const found: string[] = []
    for (const lead of [`${pluginId}:`, `${pluginId}/`]) {
      const range = prefixRange(lead)
      if (range === null) continue
      found.push(
        ...(this.selectSourcesInRange.all(range.from, range.to) as string[])
      )
    }
    for (const source of found) out.add(source)
    return [...out]
  }

  /** TODO 1237: deletes all documents of that source (FTS rows, chunks, documents; one transaction). Returns the number deleted. */
  removeAllOfSource(source: string): number {
    const removed = this.removeBySourcePrefix(source, '')
    if (removed > 0) this.revision += 1
    return removed
  }

  /**
   * Deletes, among the conversation documents of thread `threadId`, those whose `updated_at` (= the event's `ts`) is before `before`
   * (TODO 860, retention `days`). Deleted the same way as `removeBySourcePrefix` (FTS rows, chunks, documents).
   */
  removeConversationsBefore(threadId: string, before: number): number {
    const range = prefixRange(`${threadId}:`)
    if (range === null) return 0
    const ids = this.selectConversationsBefore.all(range.from, range.to, before) as number[]
    return this.deleteDocumentsByIds(ids)
  }

  /** Deletes a list of document ids in one transaction, in the order FTS rows, chunks, documents (the procedure shared by the two deletions). */
  private deleteDocumentsByIds(ids: readonly number[]): number {
    if (ids.length === 0) return 0
    this.atomically(() => {
      for (const rowId of ids) {
        this.deleteFtsForDocument.run(rowId)
        this.deleteChunks.run(rowId)
        this.deleteDocument.run(rowId)
      }
    })
    return ids.length
  }

  // ---- Merge (P3) ----

  /**
   * Advances the FTS5 merge **by one step only** (P3). The caller repeats it
   * "until 0 is returned, within a time budget".
   *
   * **`run().changes` cannot be used.** An `INSERT` into a virtual table always returns 1,
   * so we cannot tell whether there was work (measured). The signal FTS5 exposes is the increase in
   * `total_changes()`, which **is 1 only when no work was done, and larger
   * when work was done**. Here we subtract 1 from that increase and return it, so **0 = nothing left
   * to merge**.
   *
   * @param pages Amount of work per step (FTS5 internal pages). Measured: 200 pages ≈ 30 ms.
   * @returns Number of rows rewritten by the merge. 0 means it has run out of work.
   */
  mergeStep(pages: number = MERGE_PAGES): number {
    let delta = 0
    this.atomically(() => {
      const before = this.totalChanges.get() as number
      this.mergeFts.run(pages)
      delta = (this.totalChanges.get() as number) - before
    })
    return Math.max(0, delta - 1)
  }

  /**
   * Total number of FTS5 segments (the upper bits of `chunk_fts_data` are the segment id).
   * Above 2,000 it hits `SQLITE_FULL`, so this is a read entry point for monitoring (P3).
   */
  ftsSegments(): number {
    const row = this.countSegments.get() as { n: number } | undefined
    return row?.n ?? 0
  }

  // ---- Search (6.4) ----

  /**
   * Queries FTS. It returns **chunk-level hits**, so the caller folds them
   * to document level (6.4 "fold chunk scores into the document").
   *
   * `sources` is given in one of two ways.
   *
   * - `{ include }`: look only at those sources (in-conversation search = conversation / transcript)
   * - `{ exclude }`: look at everything else (File search = fs **+ plugin-derived documents**)
   *
   * If File search used `include: ['fs']`, the "plugin-derived documents (mail, tickets)"
   * that the table in 6.1 requires would not show up in the window.
   * Phase 4 opened the `index.put` entry point, so the exclusion form is the correct one.
   */
  search(
    match: string | null,
    sources: { include?: readonly string[]; exclude?: readonly string[] },
    exposures: readonly Exposure[],
    limit: number,
    /**
     * JSON array of the directory ids of the cwd subtree (item 100, `CwdSubtree.json`).
     * When passed, only documents whose parent is inside it are queried (SQLite turns the result of `json_each` into
     * a temporary index just once — EQP shows `LIST SUBQUERY` + `CREATE BLOOM FILTER`).
     */
    withinDirs?: string,
    /** File name filter (TODO 813). `exts` are lowercase without dots (OR), and `likes` are `likeContains` needles (AND, against `name_folded`). */
    fileFilter?: { readonly exts: readonly string[]; readonly likes: readonly string[] },
    /**
     * Narrows conversation documents by thread (TODO 1096, the "this working folder" section of conversation search). A JSON array of thread ids;
     * only documents whose `source_id` (`<threadId>:<eventId>`) part before the `:` is in it are queried. Non-conversation documents do not match.
     */
    withinThreads?: string
  ): readonly SearchRow[] {
    const list = sources.include ?? sources.exclude ?? []
    const operator = sources.include !== undefined ? 'IN' : 'NOT IN'
    const within = withinDirs !== undefined
    const threads = withinThreads !== undefined
    const exts = fileFilter?.exts ?? []
    const likes = fileFilter?.likes ?? []
    // The statement is built only once per `(operator, number of sources, number of exposures, cwd filter)` (item 89).
    // There are really only a few combinations (conversation / File search × UI / AI × with or without cwd).
    const key = `${match === null ? 'filter' : 'fts'}:${operator}:${list.length}:${exposures.length}:${within ? 'cwd' : ''}:${threads ? 'threads' : ''}:${exts.length}:${likes.length}`
    let statement = this.searchStatements.get(key)
    if (statement === undefined) {
      statement = this.db.prepare(
        searchSql(operator, list.length, exposures.length, within, exts.length, likes.length, match === null, threads)
      )
      this.searchStatements.set(key, statement)
    }
    // `match` null = filter only (no body terms, TODO 813 code-review). FTS is not queried and documents are listed newest first.
    const head = match === null ? [] : [match]
    const scopes = [...(within ? [withinDirs] : []), ...(threads ? [withinThreads] : [])]
    return statement.all(...head, ...list, ...exposures, ...scopes, ...exts, ...likes, limit) as SearchRow[]
  }

  /**
   * In-thread search (TODO 496, ARCHITECTURE 6.1.1). Returns conversation documents (`source = 'conversation'`) whose
   * `source_id` starts with `<threadId>:`, per document, in **oldest-first order** (`updated_at` = the event's `ts`).
   * Not in BM25 order — the box's "n / N" follows timeline order.
   */
  searchThreadEvents(
    match: string,
    threadId: string,
    exposures: readonly Exposure[],
    limit: number
  ): readonly { readonly document_id: number; readonly source_id: string; readonly updated_at: number }[] {
    let statement = this.threadSearchStatements.get(exposures.length)
    if (statement === undefined) {
      const placeholders = Array.from({ length: exposures.length }, () => '?').join(',')
      statement = this.db.prepare(`
        SELECT d.id AS document_id, d.source_id, d.updated_at
        FROM chunk_fts
        JOIN chunks c ON c.id = chunk_fts.rowid
        JOIN documents d ON d.id = c.document_id
        WHERE chunk_fts MATCH ?
          AND d.source = 'conversation'
          AND d.source_id LIKE ? ESCAPE '\\'
          AND d.exposure IN (${placeholders})
        GROUP BY d.id
        ORDER BY d.updated_at, d.id
        LIMIT ?
      `)
      this.threadSearchStatements.set(exposures.length, statement)
    }
    const prefix = `${threadId.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`
    return statement.all(match, prefix, ...exposures, limit) as {
      document_id: number
      source_id: string
      updated_at: number
    }[]
  }

  /** The list of a document's chunks (used to fetch the neighbors in `getChunk`). */
  chunksOf(documentId: number): readonly { id: number; seq: number; byte_start: number; byte_end: number }[] {
    return this.selectChunksOf.all(documentId) as {
      id: number
      seq: number
      byte_start: number
      byte_end: number
    }[]
  }

  chunkById(chunkId: number): { id: number; document_id: number; seq: number } | null {
    return (
      (this.selectChunkById.get(chunkId) as
        | { id: number; document_id: number; seq: number }
        | undefined) ?? null
    )
  }

  /**
   * Progress counters. **Do not make it a full scan of `documents`** — it is called many times during the index build, and
   * scanning a 250,000-row table each time costs more than the indexing itself (measured on a real machine in Phase 3).
   * It is a `GROUP BY` that needs only the `index_state` index, and the caller (IndexService)
   * thins the calls further.
   */
  counters(): IndexCounters {
    const rows = this.countStates.all() as { state: string; n: number }[]
    const by = new Map(rows.map((row) => [row.state, row.n]))
    const chunks = this.countChunks.get() as { c: number }
    let documents = 0
    for (const row of rows) documents += row.n
    return {
      documents,
      indexed: by.get('indexed') ?? 0,
      pending: by.get('pending') ?? 0,
      skipped: by.get('skipped') ?? 0,
      failed: by.get('failed') ?? 0,
      chunks: chunks.c
    }
  }

  // ---- Directories rejected by the scan (`scan_denials`, item 84) ----

  /**
   * The latest `limit` entries (material for the persistent TCC banner 12.8). One row per path,
   * and the only writer is `FsIndexer`. The table cap (1,000 rows) is guarded by migration 15's trigger.
   * Paths are returned as URIs so they can go to the renderer.
   */
  recentDenials(limit = 100): readonly ScanDenial[] {
    const bounded = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 1000) : 100
    const rows = this.selectDenials.all(bounded) as {
      path: string
      code: string
      seen_at: number
    }[]
    return rows.map((row) => ({ uri: pathToUri(row.path), code: row.code, seenAt: row.seen_at }))
  }

  // ---- Scan history (`scan_runs`, 6.2 "scan thinning") ----
  //
  // One full scan = one row per root, all sharing the same `started_at`.
  // The table is small (the number of roots per launch, normally 3-5 rows), so no index is needed.

  /**
   * Start of a full scan. Creates the rows of all roots at once as `running`.
   * A launch that crashed midway stays `running`, and the next check treats it the same as an abort.
   */
  beginScanRun(roots: readonly string[], startedAt: number): void {
    const insert = this.db.prepare(
      `INSERT INTO scan_runs (root, started_at, state) VALUES (?, ?, 'running')`
    )
    this.atomically(() => {
      for (const root of roots) insert.run(root, startedAt)
    })
  }

  /** The scan of one root finished. The counts are for that root. */
  finishScanRoot(
    root: string,
    startedAt: number,
    finishedAt: number,
    counters: { seen: number; indexed: number; excluded: number; denied: number }
  ): void {
    this.db
      .prepare(
        `UPDATE scan_runs
         SET finished_at = ?, state = 'done', seen = ?, indexed = ?, excluded = ?, denied = ?
         WHERE root = ? AND started_at = ? AND state = 'running'`
      )
      .run(
        finishedAt,
        counters.seen,
        counters.indexed,
        counters.excluded,
        counters.denied,
        root,
        startedAt
      )
  }

  /**
   * Aborts a full scan. **Marks all rows of the same run `aborted`** — including roots that had finished,
   * because the cleanup (`removeStale`) did not run, so that run did not complete.
   * The `finished_at` of roots that finished is kept (it is correct as the time they finished walking).
   */
  abortScanRun(startedAt: number, at: number): void {
    this.db
      .prepare(
        `UPDATE scan_runs
         SET state = 'aborted', finished_at = COALESCE(finished_at, ?)
         WHERE started_at = ? AND state IN ('running', 'done')`
      )
      .run(at, startedAt)
  }

  /** Turns runs left `running` because the previous launch crashed mid-scan into `aborted`. */
  abortDanglingScanRuns(at: number): number {
    const result = this.db
      .prepare(
        `UPDATE scan_runs SET state = 'aborted', finished_at = COALESCE(finished_at, ?)
         WHERE state = 'running'`
      )
      .run(at)
    return result.changes
  }

  /** The latest row per root. Material for the decision (`shouldFullScan`). */
  latestScanRuns(): readonly {
    root: string
    startedAt: number
    finishedAt: number | null
    state: 'running' | 'done' | 'aborted'
  }[] {
    const rows = this.db
      .prepare(
        `SELECT root, started_at, finished_at, state FROM scan_runs s
         WHERE id = (SELECT MAX(id) FROM scan_runs WHERE root = s.root)`
      )
      .all() as {
      root: string
      started_at: number
      finished_at: number | null
      state: 'running' | 'done' | 'aborted'
    }[]
    return rows.map((row) => ({
      root: row.root,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      state: row.state
    }))
  }

  /** Drops old history. Keeps only the latest `keep` rows (rows grow by the number of roots per launch). */
  pruneScanRuns(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM scan_runs
         WHERE id NOT IN (SELECT id FROM scan_runs ORDER BY id DESC LIMIT ?)`
      )
      .run(keep)
  }

  /**
   * Opens a transaction on the same DB connection (for scan batches).
   * Same as `atomically` — does not nest if already in a transaction (P5).
   */
  transaction(fn: () => void): void {
    this.atomically(fn)
  }

  /** Discards caches before a scan (in case ids change on a rescan). */
  resetCaches(): void {
    this.dirCache.clear()
    this.pathCache.clear()
    this.rootId = null
  }

  /** The statement of TODO 999. Lazily prepared outside the constructor to avoid bundle conflicts (the same shape as item 88). */
  private selectRecentFs: Statement | null = null

  /**
   * One page of "recent files" (TODO 999): fs file rows by `mtime_ms`, newest first (ties by larger id first).
   * `limit` rows from the older side of `(beforeMtime, beforeId)`, down to `sinceMs`. It only walks the partial index `documents_recent`
   * (`ensureRecentIndex`) from the end, and reads only as many row bodies as the count.
   */
  recentFsFiles(
    sinceMs: number,
    beforeMtime: number,
    beforeId: number,
    limit: number
  ): readonly (ChildRow & { parent_id: number | null })[] {
    // Name the index: on a DB with no statistics (ANALYZE), the planner picked `documents_seen (source=?)`, read all fs rows,
    // and re-sorted them with a temporary B-tree (hit in a test's EXPLAIN). On a DB where the index could not be created (`ensureRecentIndex`),
    // naming it fails at prepare, so only then do we fall back to not naming it (slow, but the answer is the same).
    const sql = (hint: string): string =>
      `SELECT id, name, kind, ext, size, mtime_ms, parent_id FROM documents ${hint}
       WHERE source = 'fs' AND kind = 'file' AND mtime_ms >= ?
         AND (mtime_ms < ? OR (mtime_ms = ? AND id < ?))
       ORDER BY mtime_ms DESC, id DESC LIMIT ?`
    if (this.selectRecentFs === null) {
      try {
        this.selectRecentFs = this.db.prepare(sql('INDEXED BY documents_recent'))
      } catch {
        this.selectRecentFs = this.db.prepare(sql(''))
      }
    }
    return this.selectRecentFs.all(sinceMs, beforeMtime, beforeMtime, beforeId, limit) as (ChildRow & {
      parent_id: number | null
    })[]
  }
}

/**
 * Weight applied to the bm25 of image OCR text matches (chunk seq 1 and later) (TODO 998 stage 2). bm25 is better when smaller (more negative), so
 * below 1 lowers the rank. This puts label matches (seq 0, terms folded into the vocabulary) above text matches (terms that happen to be in the OCR text).
 * The image's term row repeats high-confidence terms in the shadow text (`storedImageBoost`). An unmeasured default (to be tuned by looking on a real machine).
 */
export const IMAGE_OCR_SCORE_WEIGHT = 0.7
const IMAGE_SCORE_SQL = `CASE WHEN c.seq > 0 AND d.ext IN (${IMAGE_EXTENSIONS.map((ext) => `'${ext}'`).join(', ')}) THEN ${IMAGE_OCR_SCORE_WEIGHT} ELSE 1 END`

/** The SQL of `IndexStore.search`. Only the number of `IN` items varies (item 89 — prepared only once per count). */
function searchSql(
  operator: 'IN' | 'NOT IN',
  sources: number,
  exposures: number,
  within: boolean,
  extCount = 0,
  nameCount = 0,
  filterOnly = false,
  withinThreads = false
): string {
  // Narrowing by conversation thread (TODO 1096). `source_id` is `<threadId>:<eventId>` (`indexConversationEvents`).
  // MATCH drives, and the thread set is looked up through `json_each`'s temporary index (the same shape as the cwd subtree, 6.6.7).
  const threadClause = withinThreads
    ? `AND d.source = 'conversation'
      AND substr(d.source_id, 1, instr(d.source_id, ':') - 1) IN (SELECT value FROM json_each(?))`
    : ''
  const extClause =
    extCount === 0 ? '' : `AND d.ext IN (${Array.from({ length: extCount }, () => '?').join(',')})`
  const nameClause = Array.from({ length: nameCount }, () => "AND d.name_folded LIKE ? ESCAPE '\\'").join(' ')
  const sourcePlaceholders = Array.from({ length: sources }, () => '?').join(',')
  const exposurePlaceholders = Array.from({ length: exposures }, () => '?').join(',')
  if (filterOnly) {
    // A filter with no body terms (only `ext:md` / `*.pdf` / `name:22719`): rows with no chunks, newest first.
    // The excerpt is empty (byte_start = byte_end = 0). Folders are not shown in body search.
    return `
    SELECT 0 AS chunk_id, d.id AS document_id, 0 AS byte_start, 0 AS byte_end,
           0 AS score,
           d.source, d.kind, d.name, d.uri, d.parent_id, d.updated_at, d.metadata
    FROM documents d
    WHERE d.source ${operator} (${sourcePlaceholders})
      AND d.exposure IN (${exposurePlaceholders})
      AND d.kind <> 'directory'
      ${within ? 'AND d.parent_id IN (SELECT value FROM json_each(?))' : ''}
      ${threadClause}
      ${extClause}
      ${nameClause}
    ORDER BY d.updated_at DESC, d.id LIMIT ?
  `
  }
  return `
    SELECT c.id AS chunk_id, c.document_id, c.byte_start, c.byte_end,
           bm25(chunk_fts) * ${IMAGE_SCORE_SQL} AS score,
           d.source, d.kind, d.name, d.uri, d.parent_id, d.updated_at, d.metadata
    FROM chunk_fts
    JOIN chunks c ON c.id = chunk_fts.rowid
    JOIN documents d ON d.id = c.document_id
    WHERE chunk_fts MATCH ?
      AND d.source ${operator} (${sourcePlaceholders})
      AND d.exposure IN (${exposurePlaceholders})
      ${within ? 'AND d.parent_id IN (SELECT value FROM json_each(?))' : ''}
      ${threadClause}
      ${extClause}
      ${nameClause}
    ORDER BY score LIMIT ?
  `
}

/**
 * Makes the prefix match `prefix%` into the range `[from, to)`. `to` is the prefix with its last character replaced by the next one
 * (SQLite's BINARY order is UTF-8 byte order = code point order). An empty prefix matches everything, so null.
 */
export function prefixRange(prefix: string): { from: string; to: string } | null {
  if (prefix === '') return null
  const chars = Array.from(prefix)
  const last = chars.pop() as string
  const next = String.fromCodePoint((last.codePointAt(0) as number) + 1)
  return { from: prefix, to: chars.join('') + next }
}
