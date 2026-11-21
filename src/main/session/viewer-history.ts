/**
 * Saving the viewer's back / forward history (TODO 772, ARCHITECTURE.md 5.3). `SessionManager` holds only the entry points (`viewerHistory` /
 * `setViewerHistory`), and validation and reading / writing are here (the same form as gateway-requests.ts / rewind.ts / attachments.ts).
 *
 * Writes come from the renderer, so **they are re-validated here** (treated the same as `setViewerState`):
 * - `file:` is `isReferenceable || isViewable` (if it hits an exclusion rule, the whole step is dropped).
 * - A web one passes `isWebViewerUrl`, and `persistableWebUrl` drops anything where a secret is visible (re-checked with the query and fragment dropped).
 * - `about:blank` (a blank tab, 522) and other schemes are not saved.
 * - A search term is cut at 200 characters and dropped if it hits the redaction table (a web step has no search term).
 * - The limit is `VIEWER_HISTORY_STORE_LIMIT` (50). The oldest steps are dropped first, and `index` is kept within the steps that remain.
 * - The display position per document (TODO 1146, `positions`) is only for the URIs of the file steps kept, and only those that passed `acceptViewerPosition`.
 * Reading opens nothing (a URL is fetched only when back / forward is pressed - 400).
 */
import { isAbsolute } from 'node:path'
import {
  VIEWER_HISTORY_STORE_LIMIT,
  renameHistoryUrisIn,
  type ViewerHistorySnapshot,
  type ViewerHistoryStep
} from '@shared/viewer-history.js'
import { prunePositions, type ViewerPositionTable } from '@shared/viewer-position.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { persistableWebUrl } from '@shared/web-tabs.js'
import { log } from '../../common/logger.js'
import { pathToUri, uriToPath } from '../../common/uri.js'
import { redactText } from '../../common/redact.js'
import type { FsAccess } from '../fs/access.js'
import type { ThreadStore } from './store.js'
import { MAX_VIEWER_HIGHLIGHT } from './viewer-tools.js'

/** Upper limit on the number of steps the renderer sends (so even broken input is not heavy. A legitimate history is 50 or fewer). */
const MAX_INPUT_STEPS = 500
const MAX_URI_LENGTH = 4096

type FsGate = Pick<FsAccess, 'isReferenceable' | 'isViewable'>

export interface ViewerHistoryDeps {
  readonly store: ThreadStore
  readonly fs: FsGate
}

/** Validates one step and turns it into a form that may be saved. null if it cannot be saved. */
export function sanitizeStep(input: unknown, fs: FsGate): ViewerHistoryStep | null {
  if (typeof input !== 'object' || input === null) return null
  const { uri, highlight } = input as { uri?: unknown; highlight?: unknown }
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI_LENGTH) return null
  if (isWebViewerUrl(uri)) {
    const persistable = persistableWebUrl(uri)
    return persistable === null ? null : { uri: persistable, highlight: null }
  }
  let path: string
  try {
    path = uriToPath(uri)
  } catch {
    return null
  }
  if (!isAbsolute(path) || !(fs.isReferenceable(path) || fs.isViewable(path))) return null
  const trimmed = typeof highlight === 'string' ? highlight.trim() : ''
  const query =
    trimmed === '' || redactText(trimmed).hits.length > 0 ? null : trimmed.slice(0, MAX_VIEWER_HIGHLIGHT)
  return { uri: pathToUri(path), highlight: query }
}

/**
 * Turns the renderer's history into a form that may be saved. null if no step remains (= no history to save).
 * Even if steps were dropped, `index` points to "the current step", or the nearest remaining step before it.
 */
export function sanitizeViewerHistory(input: unknown, fs: FsGate): ViewerHistorySnapshot | null {
  if (typeof input !== 'object' || input === null) return null
  const { entries, index, positions } = input as { entries?: unknown; index?: unknown; positions?: unknown }
  if (!Array.isArray(entries) || entries.length > MAX_INPUT_STEPS) return null
  const wanted = typeof index === 'number' && Number.isInteger(index) ? index : entries.length - 1
  const kept: ViewerHistoryStep[] = []
  /** For each kept step, the URI the renderer sent (the key of the position table) and the re-validated URI. */
  const renames = new Map<string, string>()
  let keptIndex = -1
  entries.forEach((entry: unknown, position) => {
    const step = sanitizeStep(entry, fs)
    if (step === null) return
    kept.push(step)
    // Positions are only for file steps (a web step is not drawn by the viewer plugin).
    if (step.uri.startsWith('file:')) renames.set(step.uri, (entry as { uri: string }).uri)
    if (position <= wanted) keptIndex = kept.length - 1
  })
  if (kept.length === 0) return null
  // If the first step was dropped and the current step is before the start, use the first remaining step.
  const current = Math.max(0, keptIndex)
  const overflow = Math.max(0, kept.length - VIEWER_HISTORY_STORE_LIMIT)
  const steps = overflow === 0 ? kept : kept.slice(overflow)
  const snapshot: ViewerHistorySnapshot = { entries: steps, index: Math.max(0, current - overflow) }
  const table = sanitizePositions(positions, steps, renames)
  return table === undefined ? snapshot : { ...snapshot, positions: table }
}

/**
 * Validates the table of display positions (TODO 1146). The keys are only the URIs of the kept steps (re-pointed to the re-validated URI), and the values are
 * only those that passed `acceptViewerPosition`. undefined if no position remains.
 */
function sanitizePositions(
  raw: unknown,
  steps: readonly ViewerHistoryStep[],
  renames: ReadonlyMap<string, string>
): ViewerPositionTable | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const rekeyed: Record<string, unknown> = {}
  for (const step of steps) {
    const sent = renames.get(step.uri)
    if (sent === undefined || !Object.prototype.hasOwnProperty.call(raw, sent)) continue
    rekeyed[step.uri] = (raw as Record<string, unknown>)[sent]
  }
  return prunePositions(rekeyed, steps.map((step) => step.uri))
}

/** Reads the saved JSON. null if broken (it goes through the same validation as at save time). */
export function parseStoredHistory(json: string | null, fs: FsGate): ViewerHistorySnapshot | null {
  if (json === null) return null
  try {
    return sanitizeViewerHistory(JSON.parse(json) as unknown, fs)
  } catch {
    return null
  }
}

export class ViewerHistoryService {
  constructor(private readonly deps: ViewerHistoryDeps) {}

  /** The conversation's back / forward history. null if none, broken, or the conversation does not exist (was deleted). It only reads and opens nothing. */
  get(threadId: string): ViewerHistorySnapshot | null {
    if (this.deps.store.getThread(threadId) === null) return null
    // Re-validated on read-back too (so steps that remain after exclusion rules were added are not handed to the renderer).
    return parseStoredHistory(this.deps.store.viewerHistoryJson(threadId), this.deps.fs)
  }

  /**
   * Re-points the old URI of a renamed file / folder (TODO 1149) to the new URI in the saved history of all conversations
   * (including what is under it for a folder). Broken rows and unchanged rows are not touched.
   */
  renameUris(fromUri: string, toUri: string, now = Date.now()): void {
    if (fromUri === toUri) return
    for (const row of this.deps.store.allViewerHistoryJson()) {
      let parsed: ViewerHistorySnapshot
      try {
        parsed = JSON.parse(row.history) as ViewerHistorySnapshot
      } catch {
        continue
      }
      if (!Array.isArray(parsed.entries)) continue
      const renamed = renameHistoryUrisIn(parsed, fromUri, toUri)
      if (renamed === parsed) continue
      this.deps.store.setViewerHistoryJson(row.threadId, JSON.stringify(renamed), now)
    }
  }

  /** Validates and saves. If there is no step to save, the row is deleted. If there is no conversation, does nothing. */
  set(threadId: string, input: unknown, now = Date.now()): void {
    if (this.deps.store.getThread(threadId) === null) return
    const snapshot = sanitizeViewerHistory(input, this.deps.fs)
    if (snapshot === null) {
      this.deps.store.setViewerHistoryJson(threadId, null, now)
      return
    }
    // Count only (URIs and search terms are not written).
    log.info('thread.viewerHistory.saved', { threadId, steps: snapshot.entries.length })
    this.deps.store.setViewerHistoryJson(threadId, JSON.stringify(snapshot), now)
  }
}
