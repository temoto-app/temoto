/**
 * "Recent files" (TODO 999, ARCHITECTURE.md 4.5.12). Builds the material for the Composer's "Recent" popup, the candidates of an empty `@`, and the recent-file badge
 * (TODO 1172, a widening of 999's new-screenshot badge). **Independent of electron**
 * (`test/recent-files.test.ts` runs it on plain Node).
 *
 * Flow: candidates from the index process (`fs.recentFiles` - narrowed by extension, exclusion and hidden folders, with bulk updates marked) -> judged from the top
 * (owner decision 2026-10-25):
 *   1. A file the AI wrote in an aios conversation (the target of a `tool_use` write, read by the Adapter) -> keep (`ai: true`).
 *   2. Marked as a bulk update -> drop.
 *   3. Under git -> keep only modified / untracked (`GitChangeIndex`). If it cannot be read, keep.
 *   4. Anything else (outside git) -> keep.
 * Not one SQL statement of the index is run in main (constraint 8.1). The conversation table (`thread_events`) is in main's DB, so it is read in main.
 */
import {
  BULK_WINDOW_MS,
  RECENT_MAX,
  RECENT_OFFER_FETCH,
  RECENT_OFFER_EXTENSIONS,
  RECENT_OFFER_FOLDERS,
  RECENT_OFFER_MS,
  RECENT_WINDOW_MS,
  recentKindOf,
  type RecentCandidate,
  type RecentFile,
  type RecentKind
} from '@shared/recent-files.js'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { foldPath, isSameOrUnderPath, uriToPath } from '../../common/uri.js'
import { log, errorFields } from '../../common/logger.js'
import type { GitFileState } from './git-changes.js'

/** Number of candidates asked of the index. Fetch more than the number shown, allowing for those dropped by the git and bulk checks. */
const CANDIDATE_LIMIT = 1_000
/** How long the list of AI-written files is remembered (the conversation table is not read every time the popup is opened). */
const AI_TTL_MS = 30_000

export interface RecentFilesDeps {
  /** Candidates from the index process (`IndexClient.recentFiles`). */
  readonly candidates: (params: { sinceMs: number; limit: number; parentUri?: string }) => Promise<readonly RecentCandidate[]>
  /** Absolute paths of files the AI wrote in conversations active after `sinceMs` (`SessionManager.recentAiWrittenPaths`). */
  readonly aiWrittenPaths: (sinceMs: number) => readonly string[]
  readonly gitState: (path: string) => Promise<GitFileState>
  /** The setting "Suggest recent files" (the key is still `composer.screenshotOffer` from 999). */
  readonly screenshotOfferEnabled: () => boolean
  readonly now?: () => number
  /** TODO 1180: the home location and realpath (replaced in tests). */
  readonly home?: () => string
  readonly realpath?: (path: string) => Promise<string>
}

export class RecentFilesService {
  private aiCache: { readonly at: number; readonly paths: ReadonlySet<string> } | null = null

  constructor(private readonly deps: RecentFilesDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Files the AI wrote (collapsed paths). Reads the conversation table, so remembered for `AI_TTL_MS`. Empty if it cannot be read. */
  private aiPaths(sinceMs: number): ReadonlySet<string> {
    const now = this.now()
    if (this.aiCache !== null && now - this.aiCache.at < AI_TTL_MS) return this.aiCache.paths
    let paths: ReadonlySet<string>
    try {
      paths = new Set(this.deps.aiWrittenPaths(sinceMs).map((path) => foldPath(path)))
    } catch (err) {
      log.warn('recent.ai.failed', errorFields(err))
      paths = new Set()
    }
    this.aiCache = { at: now, paths }
    return paths
  }

  /** The list (newest first). If `kinds` is null, all kinds. **Never throws** - empty if the index does not answer. */
  async list(kinds: readonly RecentKind[] | null, limit: number = RECENT_MAX): Promise<readonly RecentFile[]> {
    return this.collect(this.now() - RECENT_WINDOW_MS, kinds, limit)
  }

  /**
   * The recent-file badge (TODO 1172): of the popup's list (all kinds, newest first), the first `RECENT_OFFER_FETCH` items that changed within `RECENT_OFFER_MS` (5 minutes).
   * The same narrowing (AI, bulk, git) as the popup is applied again here. Taking the first `RECENT_OFFER_MAX` after removing dismissed and already attached ones is
   * done by the renderer (`visibleOffers`) - if main cut at the limit, no next badge would appear after one is dismissed.
   *
   * The index is asked from `BULK_WINDOW_MS` before the 5-minute window: the bulk mark (`isBulkAt`) counts rows in `[m - BULK_WINDOW_MS, m + BULK_WINDOW_MS]`, but
   * it counts only rows of the queried window, so querying with the 5-minute window would make a build output straddling the boundary miss the bulk judgment.
   * Adding the earlier part puts the whole counting width of every file in the window inside, giving the same judgment as the 7-day list. Then it is narrowed to 5 minutes by mtime.
   * The order is newest first, so after narrowing the head = those within 5 minutes of the head of the 7-day list. Empty if turned off in settings. **Never throws.**
   */
  async offers(): Promise<readonly RecentFile[]> {
    if (!this.deps.screenshotOfferEnabled()) return []
    const offerSince = this.now() - RECENT_OFFER_MS
    const folders = await this.offerFolders()
    const accept = async (path: string, ext: string): Promise<boolean> => {
      if (!RECENT_OFFER_EXTENSIONS.has(ext.toLowerCase())) return false
      let real: string
      try {
        real = await (this.deps.realpath ?? realpath)(path)
      } catch {
        real = path
      }
      return folders.some((folder) => isSameOrUnderPath(real, folder))
    }
    const files = await this.collect(offerSince - BULK_WINDOW_MS, null, RECENT_OFFER_FETCH, accept)
    return files.filter((file) => file.mtimeMs >= offerSince)
  }

  /** TODO 1180: the folders shown in the badge (real paths). Folders that do not exist are dropped. They are compared with `isSameOrUnderPath`. */
  private async offerFolders(): Promise<readonly string[]> {
    const home = (this.deps.home ?? homedir)()
    const out: string[] = []
    for (const name of RECENT_OFFER_FOLDERS) {
      try {
        out.push(await (this.deps.realpath ?? realpath)(`${home}${sep}${name}`))
      } catch {
        // Folders that do not exist or cannot be read are not targets
      }
    }
    return out
  }

  private async collect(
    sinceMs: number,
    kinds: readonly RecentKind[] | null,
    limit: number,
    accept?: (path: string, ext: string) => Promise<boolean>
  ): Promise<readonly RecentFile[]> {
    let candidates: readonly RecentCandidate[]
    try {
      candidates = await this.deps.candidates({ sinceMs, limit: CANDIDATE_LIMIT })
    } catch (err) {
      log.warn('recent.list.failed', errorFields(err))
      return []
    }
    // AI-written files are read with the same 7-day width as the popup (the remembered set is reused even for the badge's 5-minute query).
    const ai = this.aiPaths(this.now() - RECENT_WINDOW_MS)
    const max = Math.min(Math.max(1, Math.trunc(limit)), RECENT_MAX)
    const wanted = kinds === null ? null : new Set(kinds)
    // First separate what is decided by kind and AI, then judge only those that need git, in order (the order is kept).
    const picked: { candidate: RecentCandidate; kind: RecentKind; path: string; ai: boolean }[] = []
    for (const candidate of candidates) {
      const kind = recentKindOf(candidate.ext)
      if (kind === null || (wanted !== null && !wanted.has(kind))) continue
      let path: string
      try {
        path = uriToPath(candidate.uri)
      } catch {
        continue
      }
      const isAi = ai.has(foldPath(path))
      if (!isAi && candidate.bulk) continue
      // An accept that involves realpath is applied only to candidates that passed the free checks.
      if (accept !== undefined && !(await accept(path, candidate.ext))) continue
      picked.push({ candidate, kind, path, ai: isAi })
    }
    const out: RecentFile[] = []
    // git is judged a little at a time (once `max` items from the top are filled, the rest is not read - git is not run for unnecessary repositories).
    const STEP = 32
    for (let start = 0; start < picked.length && out.length < max; start += STEP) {
      const slice = picked.slice(start, start + STEP)
      const states = await Promise.all(
        slice.map((entry) => (entry.ai ? Promise.resolve<GitFileState>('changed') : this.deps.gitState(entry.path)))
      )
      slice.forEach((entry, i) => {
        if (out.length >= max) return
        if (states[i] === 'clean') return
        out.push(toRecentFile(entry.candidate, entry.kind, entry.ai))
      })
    }
    return out
  }
}

function toRecentFile(candidate: RecentCandidate, kind: RecentKind, ai: boolean): RecentFile {
  return {
    uri: candidate.uri,
    parentUri: candidate.parentUri,
    name: candidate.name,
    ext: candidate.ext,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    kind,
    ai
  }
}
