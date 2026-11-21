/**
 * Pure functions for the create dialog's "CLI conversations in this folder" list (item 122, ARCHITECTURE.md 4.3.2 / 4.5.9).
 * Independent of the DOM and React; `test/transcript-folder.test.ts` guards against regressions.
 *
 * - Filtering happens in the renderer: main's `threads.transcriptSessions()` returns the list for all folders
 *   (item 111). A folder matches when **`cwdMatchKey` matches** (item 239, owner decision 2026-09-28):
 *   an exact `cwdUri` match misses when the chosen folder is spelled through a symlink (macOS `/tmp` /
 *   `/var` etc.) or differs only in letter case. `cwdMatchKey` is a value main has already passed through
 *   `realpath` + folding (case, NFC); `toTranscriptSession` computes it once per transcript, and for the
 *   chosen folder it is fetched once with `threads.folderMatchKey(cwdUri)`.
 * - Ordered by last update, newest first. The most recent `FOLDER_TRANSCRIPT_LIMIT` are shown; the rest expand under "Show more".
 * - "No folder (throwaway)" gets a fresh folder every time, so it leaves no trace and shows no list.
 */
import type { TranscriptSession } from '@shared/thread.js'

/** How many to show at first (owner decision 2026-09-27). The 6th and later go under "Show more". */
export const FOLDER_TRANSCRIPT_LIMIT = 5

/**
 * Returns only the conversations started in the `matchKey` folder, newest first. Empty when `matchKey` is null (no folder,
 * the chosen folder does not pass the choke point, or not fetched yet) or empty. A transcript with an
 * unknown working folder (`cwdMatchKey === ''`) matches no folder.
 */
export function sessionsInFolder(
  sessions: readonly TranscriptSession[],
  matchKey: string | null
): readonly TranscriptSession[] {
  if (matchKey === null || matchKey === '') return []
  return sessions
    .filter((session) => session.cwdMatchKey === matchKey)
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The rows to show, and how many are hidden behind "Show more". Everything when `expanded`. */
export function visibleSessions<T>(
  sessions: readonly T[],
  expanded: boolean,
  limit = FOLDER_TRANSCRIPT_LIMIT
): { readonly shown: readonly T[]; readonly hidden: number } {
  if (expanded || sessions.length <= limit) return { shown: sessions, hidden: 0 }
  return { shown: sessions.slice(0, limit), hidden: sessions.length - limit }
}

/**
 * How the dialog's "CLI conversations" section is laid out.
 *
 * - `folder`: the chosen folder has conversations. Shows the "+ New conversation" button and lists the folder's conversations below it.
 * - `plain`: no conversations (including when the list has not arrived yet) or no folder. Only the bottom "+ New", as before.
 *
 * Either way an entry point to pick from the conversations of all folders is shown (owner decision; item 153 made it a collapsible ▸ / ▾).
 * The wording is "Continue from a CLI conversation in another folder" when a folder is chosen, and "Continue from a CLI conversation" with no folder.
 */
export function transcriptEntryMode(
  scratch: boolean,
  inFolderCount: number
): { readonly mode: 'folder' | 'plain'; readonly link: 'otherFolders' | 'anyFolder' } {
  return {
    mode: !scratch && inFolderCount > 0 ? 'folder' : 'plain',
    link: scratch ? 'anyFolder' : 'otherFolders'
  }
}
