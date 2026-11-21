/**
 * Types for when the search layer crosses the main / renderer boundary (ARCHITECTURE.md 6.1 / 6.3).
 *
 * **The policy "do not hand paths to the renderer" was withdrawn in item 55 (2026-09-22).**
 * The renderer is not a trust boundary (nodeIntegration disabled, behind contextBridge, our own code).
 * It is withdrawn only toward the renderer; the boundary to plugins (`CapabilityBroker`, constraint 8) and
 * main's re-validation (`FsService.assertAllowed`, 12.7) stay as they are. `SearchHit.uri` was
 * already a full `file://` path, and the renderer already received it to open in the viewer
 * (unrelated to the separate decision of 6.6.2 / 12.7 to make the ID a rowid). Now even the search hit
 * list shows a home-folded relative path on screen with `displayPath(uri, homeUri)`
 * (`src/renderer/src/components/SearchMode.tsx`).
 */

/** `exposure` of 6.3. Separates "searchable" from "may be handed to the AI". */
export type Exposure = 'ui+ai' | 'ui-only' | 'hidden'

/** The 2 search windows of 6.1. There is one index; the difference is the `source` filter. */
export type SearchScope = 'files' | 'conversation'

/**
 * A tag for when the `context` of a conversation / transcript hit is a fixed label (TODO 66 phase 2).
 * **main does not know the language**, so `context` holds the raw value (as before), and when
 * it is a fixed label such as "you / answer / tool / transcript", the same value is also put in `contextCode`
 * as the tag. The renderer's dictionary (`search.role.*`) turns it into wording.
 * Hits from fs / plugins (folder names, plugin names) have no tag (null).
 */
export const SEARCH_ROLE_CODES = ['user', 'assistant', 'tool', 'transcript'] as const
export type SearchRoleCode = (typeof SEARCH_ROLE_CODES)[number]

export function isSearchRoleCode(value: string): value is SearchRoleCode {
  return (SEARCH_ROLE_CODES as readonly string[]).includes(value)
}

export interface SearchHit {
  /** Stable ID of `documents`. Passed to `getDocument` etc. */
  readonly id: string
  /** URI of the viewer / jump target (`file://` `thread://` `transcript://`). */
  readonly uri: string
  readonly title: string
  /** 'fs' | 'conversation' | 'transcript' | a plugin name */
  readonly source: string
  /**
   * 'file' | 'message' | 'directory'. 'directory' is only for folder rows of the file-name search (TODO 436,
   * the renderer's `toNameHit` sets it from `FileEntry.isDirectory`). It does not appear in body search or the gateway's search
   * (a folder has no body). When opening one, the opener selects it in the Files tree instead of opening a viewer.
   */
  readonly kind: string
  readonly updatedAt: number
  /** BM25 score (smaller is better, inverted so that larger is better). */
  readonly score: number
  /** A display snippet **cut out of the canonical copy** (6.5). The shadow column is not used. */
  readonly snippet: string
  /** Jump target of a conversation. null for fs. */
  readonly threadId: string | null
  readonly eventId: string | null
  /** Supplementary display (the parent directory for fs, the thread name for a conversation). */
  readonly context: string
  /** The tag for when `context` is a fixed label. null if none (the raw `context` is shown as is). */
  readonly contextCode: SearchRoleCode | null
  /**
   * The page in which a PDF body-search hit falls (1-based, TODO 1009 stage 2). Set only on hits in the body of a PDF that has page boundaries.
   * When opening, the viewer moves to this page (`select(uri, { page })`).
   */
  readonly page?: number
}

export interface SearchResponse {
  /** Hits from the whole scope. When `cwd` is given, the section **excluding the part inside cwd** (item 100). */
  readonly hits: readonly SearchHit[]
  /** Number of documents hit (an approximation up to the limit). */
  readonly total: number
  readonly truncated: boolean
  /**
   * The section inside the current working folder (item 100). Set only when the in-file search is given a cwd and the index
   * has that directory. The renderer shows this first, under a separate heading.
   * In conversation search (TODO 1096), cwd is the messages of threads in (or under) that folder; it is set if a cwd is given and it passes the
   * choke point (a section of 0 hits if no thread matches). Transcripts go only into the whole-scope side.
   */
  readonly cwd?: SearchSection
  /**
   * There was a term with uppercase letters, and that term was matched case-sensitively (smart case, TODO 291).
   * FTS5 folds case, so the candidates are re-checked against the canonical copy and the non-matching ones are dropped.
   * The renderer shows an `Aa` badge to the right of the search box. Absent is the same as false.
   */
  readonly caseSensitive?: boolean
  readonly tookMs: number
  /**
   * **Returned without executing** (P6). A newer query for the same scope had arrived, so
   * not a single SQL statement was run. The caller **discards** this result - it is not
   * an empty result, so `hits` must not be used for display.
   */
  readonly stale?: boolean
  /**
   * **Not executed because it was too short** (P8 / item 41, 6.4.1 "minimum number of characters"). Like `stale`, it is not
   * an empty result, so it must not be displayed as "0 hits" - the screen shows "N more characters".
   * `missingChars` is that N. Not set for the gateway's (`forAgent`) search.
   */
  readonly tooShort?: boolean
  readonly missingChars?: number
}

/**
 * The index's answer for in-thread search (TODO 496, ARCHITECTURE 6.1.1). It queries the same index as conversation search (⌘K) narrowed to one thread,
 * and returns the ids of the matching messages in **timeline order (oldest first)**. No snippet is made (the on-screen highlighting is applied to the
 * DOM the renderer drew, so it is not needed). The renderer counts the already-loaded messages in the DOM, and from here adds
 * **only the messages not yet loaded (earlier pages)** (so duplicates are not counted).
 */
export interface ThreadSearchResponse {
  readonly eventIds: readonly string[]
  /** Cut off at the limit (`THREAD_SEARCH_LIMIT`) or at the limit of the smart-case re-check. */
  readonly truncated: boolean
  /** Matched case-sensitively by smart case (TODO 291). */
  readonly caseSensitive?: boolean
  /** The same as `SearchResponse.stale` (P6). Discard it. */
  readonly stale?: boolean
  /** The same as `SearchResponse.tooShort` (P8 / item 41). The on-screen DOM highlighting continues. */
  readonly tooShort?: boolean
}

/** Upper limit of messages the index returns for in-thread search. */
export const THREAD_SEARCH_LIMIT = 1000

/**
 * The build result at the time the Search screen's scope (TODO 437) was decided (`search.buildScope`). The number of documents still waiting for a body
 * after the scope's subtree was run through `buildSubtree` (item 249, limit 2,000 documents / 10 seconds).
 * If `pending > 0`, the renderer shows "N unindexed in this folder" next to the badge (it does not leak silently).
 */
export interface ScopeBuildResult {
  /** Number of documents built this time. */
  readonly built: number
  /** Documents still waiting for a body in the subtree after the build (if `pendingCapped`, the value where counting stopped at the limit). */
  readonly pending: number
  readonly pendingCapped: boolean
}

/** One section of the search results (item 100). `uri` is the working folder used as the section's basis. */
export interface SearchSection {
  readonly uri: string
  readonly hits: readonly SearchHit[]
  readonly total: number
  readonly truncated: boolean
}

/**
 * `starting` was added in P1 (3.3). The index process is being started and no
 * real progress has arrived yet. The window opens without waiting for the index, so this value exists only so that
 * the status bar does not lie with "0 items" in the meantime.
 *
 * `waiting` was "waiting for the operation to stop" in P4, but **by TODO 434 (2026-10-04) it became only
 * "stopped because the heat is `serious` or higher / Low Power Mode"** (`message` is
 * `thermal` / `low-power`). During operation it does not wait but proceeds slowly, and then `building` carries
 * `message: 'slow'` (when idle it runs at full speed with `message: null`). It does not change with the power source.
 * "Stopped (`paused`)" is a state the user stopped, and this one does not resume by itself.
 */
export type IndexState =
  | 'starting'
  | 'idle'
  | 'building'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'error'

/** Progress of the index build (shown in the sidebar). It can be stopped and resumed. */
export interface IndexStatus {
  readonly state: IndexState
  /** Number of documents in the index (including directories). */
  readonly documents: number
  /** Number of documents whose body is indexed. */
  readonly indexed: number
  /** Number of documents waiting for a body. */
  readonly pending: number
  /** Documents that get no body (directories, excluded extensions, binaries). */
  readonly skipped: number
  readonly failed: number
  readonly chunks: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  /**
   * Supplement to the state. `slow` of `building` (TODO 434), `thermal` / `low-power` of `waiting`, a reason code of `shared/reason.ts`
   * (such as `index-restarting`), or the raw text of an exception. The renderer turns it into wording (7.4.4).
   */
  readonly message: string | null
}
