/**
 * The pure part of the change history (Release Notes, TODO 1186, 5. of `docs/notes/public-repo.md`) shared by main and the renderer.
 *
 * The canonical copy is `CHANGELOG.md` directly under the repo (English only, in Keep a Changelog form). It is bundled with the app, and main reads it and returns the body
 * (no network is used). It is displayed in the standard Markdown viewer's temporary view (7.4.6).
 * It uses neither electron nor the DOM (vitest reads it directly).
 */
import { isNewerVersion } from './update.js'

/** File name of the bundled change history (directly under appPath). */
export const CHANGELOG_FILE = 'CHANGELOG.md'

/** Upper limit of the bundled change history (bytes). */
export const MAX_CHANGELOG_BYTES = 1024 * 1024

/** The change history main returns to the renderer (`releaseNotes.open` / `takeAuto`). */
export interface ReleaseNotesDocument {
  /** Name of the temporary view (the extension selects the Markdown viewer). */
  readonly name: string
  /** The Markdown body. */
  readonly text: string
}

/** The heading `## [0.78.0] - 2026-11-08`. */
const SECTION_HEADING = /^## \[([^\]\n]+)\][^\n]*$/gm

/**
 * Cuts out the section of version `version` from `CHANGELOG.md` (from its heading up to just before the next version's heading). null if absent.
 * The reference definitions `[link]: …` at the end (the Keep a Changelog custom) may stay attached to the last section.
 */
export function extractVersionSection(markdown: string, version: string): string | null {
  const headings = [...markdown.matchAll(SECTION_HEADING)]
  const index = headings.findIndex((match) => match[1] === version)
  if (index < 0) return null
  const start = headings[index]?.index ?? 0
  const end = headings[index + 1]?.index ?? markdown.length
  return markdown.slice(start, end).trimEnd() + '\n'
}

export interface AutoShowInput {
  /** The setting "open the change history after an update". */
  readonly enabled: boolean
  /** The version last shown automatically (null if none). */
  readonly lastShown: string | null
  /** The current version. */
  readonly current: string
  /** Whether the auto-update mechanism sees "the version went up in this launch" (`UpdateStatus.justUpdated`). */
  readonly justUpdated: boolean
}

/**
 * Whether to show the new version's section automatically at launch.
 * - Not shown if the setting is off or the current version was already shown.
 * - If there is a record of showing, only when the current version is newer than it.
 * - When there is no record (the first launch, or an update to the version that introduced this feature), only when the update mechanism saw the version go up
 *   (not shown for a fresh install).
 */
export function shouldAutoShowReleaseNotes(input: AutoShowInput): boolean {
  if (!input.enabled || input.lastShown === input.current) return false
  if (input.lastShown !== null) return isNewerVersion(input.current, input.lastShown)
  return input.justUpdated
}
