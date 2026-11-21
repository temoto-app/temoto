/**
 * Notice for a first-time folder (item 123, ARCHITECTURE 4.3.2 / 4.6.2 (10)).
 *
 * The plain backend's interactive version asks "do you trust this folder?" for a first-time folder, but the
 * non-interactive launch aios uses has no such confirmation. Spike 25 confirmed that **merely starting the process**
 * launches the project's MCP servers and runs the session-start hooks (later hooks also bypass approval).
 *
 * Owner decision (2026-09-27): **notify only, do not block**, and **only for a first-time folder**.
 *
 * - "First time" = the folder is not in aios's working-folder history (`cwd_history`) and the backend's conversation
 *   transcripts hold no conversation for that folder. Once one is created it is in the history, so it no longer
 *   appears. **The backend's own trust record is neither read nor written** (constraint 2: it is under the credentials location).
 * - What to look for (file names, locations, keys) is known to the Adapter from the compat table. This file has only the order and the choke point.
 * - The choke point (`assertAllowed`) is applied before `stat`, both to the folder and to each file the Adapter looks at.
 * - Cheap checks first: folder choke point -> `stat` -> history -> files -> the transcript list (the first time reads the head and tail of several hundred files).
 */
import { realpath, stat } from 'node:fs/promises'
import type { FolderNotice } from '@shared/thread.js'
import { pathToUri } from '../../common/uri.js'
import type { ProjectAutorunReport } from './types.js'

export interface FolderNoticeDeps {
  /** The one choke point (`FsAccess.assertAllowed`). Throws on an exclusion or an invalid scheme. Returns the path. */
  assertAllowed(uri: string, asDirectory: boolean): string
  /** Whether it is in aios's working-folder history (compared by the folded path). */
  knownCwd(path: string): boolean
  /** Whether the backend's conversation transcripts hold a conversation started in this folder (under any spelling). */
  hasTranscript(paths: readonly string[]): Promise<boolean>
  /** The Adapter's probe. undefined for a backend that has none (= no notice). */
  locate: ((cwd: string, allowed: (path: string) => boolean) => Promise<ProjectAutorunReport>) | undefined
}

/**
 * Returns a notice if there is one. null = say nothing (not a first time / nothing found / an unusable folder /
 * a backend that cannot be searched). **Does not throw** (it is an aid to the create dialog, so a failure silently gives null).
 */
export async function folderNotice(cwdUri: string, deps: FolderNoticeDeps): Promise<FolderNotice | null> {
  if (deps.locate === undefined) return null
  let cwd: string
  try {
    cwd = deps.assertAllowed(cwdUri, true)
  } catch {
    return null
  }
  try {
    if (!(await stat(cwd)).isDirectory()) return null
  } catch {
    return null
  }
  // Treat different spellings (a path through a symlink) as the same folder.
  const spellings = [cwd]
  try {
    const real = await realpath(cwd)
    if (real !== cwd) spellings.push(real)
  } catch {
    // Normally this does not happen, since stat succeeded.
  }
  if (spellings.some((path) => deps.knownCwd(path))) return null

  const allowed = (path: string): boolean => {
    try {
      deps.assertAllowed(pathToUri(path), false)
      return true
    } catch {
      return false
    }
  }
  let report: ProjectAutorunReport
  try {
    report = await deps.locate(cwd, allowed)
  } catch {
    return null
  }
  if (report.hooks.length === 0 && report.mcp.length === 0) return null
  try {
    if (await deps.hasTranscript(spellings)) return null
  } catch {
    // If the transcript cannot be read, err toward "none" (the notifying side).
  }
  const toFile = (file: { path: string; names: readonly string[] }) => ({
    uri: pathToUri(file.path),
    names: [...file.names]
  })
  return { hooks: report.hooks.map(toFile), mcp: report.mcp.map(toFile) }
}
