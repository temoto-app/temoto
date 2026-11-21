/**
 * The main side of the change history (Release Notes, TODO 1186, 5. of `docs/notes/public-repo.md`). Does not import electron
 * (`test/release-notes.test.ts` checks it with a temporary folder). The wiring to ipcMain is in `release-notes-ipc.ts`.
 *
 * - The text is read from **`<appPath>/CHANGELOG.md` bundled with the app** (the same expression in dev, the shell, the distributed build and a version placed by auto-update.
 *   It is added to electron-builder's `files` for the same reason as Help's `resources/help/`). No network is used.
 *   It is not a user's file, so `FsAccess` is not passed. Only this one file is read (the renderer does not even pass a name).
 * - **English only** (owner decision 2026-11-08). English text is shown even if the display language is Japanese.
 * - It is shown automatically once, "at the first launch after the version goes up" (the last version shown is remembered in `releaseNotes.lastShown`).
 *   It can be turned off with the setting `releaseNotes.auto`. Only the section of the current version is shown.
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { insideRoot, readCapped } from './bundled-file.js'
import type { AppSettingsStore } from '../common/settings.js'
import { RELEASE_NOTES_AUTO, RELEASE_NOTES_LAST_SHOWN } from '../common/settings-keys.js'
import {
  CHANGELOG_FILE,
  MAX_CHANGELOG_BYTES,
  extractVersionSection,
  shouldAutoShowReleaseNotes,
  type ReleaseNotesDocument
} from '@shared/release-notes.js'
import { isNewerVersion, normalizeVersion } from '@shared/update.js'
import { PRODUCT_NAME } from '@shared/product.js'

/** The path of the bundled change history. `appPath` is `app.getAppPath()`. */
export function changelogPath(appPath: string): string {
  return join(appPath, CHANGELOG_FILE)
}

/** Read up to the limit. null if missing, not a regular file, over the limit, or a symlink that goes outside appPath. */
export function readChangelog(appPath: string): string | null {
  try {
    const realRoot = realpathSync(appPath)
    const real = realpathSync(changelogPath(appPath))
    if (!insideRoot(realRoot, real)) return null
    return readCapped(real, MAX_CHANGELOG_BYTES)
  } catch {
    return null
  }
}

export interface ReleaseNotesDeps {
  readonly settings: AppSettingsStore
  readonly appPath: string
  /** The current version (`app.getVersion()`). */
  readonly currentVersion: string
  /** Whether the auto-update machinery sees "the version went up at this launch" (`UpdateService.status().justUpdated !== null`). */
  readonly justUpdated: () => boolean
}

/** The only writer of the "show automatically" setting and the record. */
export class ReleaseNotesService {
  constructor(private readonly deps: ReleaseNotesDeps) {}

  /** The full text of the change history (the "Release Notes" menu and the "View change history" in settings). null if the bundled file cannot be read. */
  open(): ReleaseNotesDocument | null {
    const text = readChangelog(this.deps.appPath)
    return text === null ? null : { name: 'Release Notes.md', text }
  }

  /**
   * The automatic display at startup. If the conditions to show are met, return the current version's section and leave a record that it was shown. Even when it is not shown, the record is advanced to the current version
   * (so that the first launch after turning it OFF, updating, and turning it back ON does not show an old section; a fresh install works the same way).
   * From the second window on, the record is already done, so null.
   */
  takeAuto(): ReleaseNotesDocument | null {
    const current = normalizeVersion(this.deps.currentVersion)
    if (current === null) return null
    const { settings } = this.deps
    const lastShown = settings.readTyped(RELEASE_NOTES_LAST_SHOWN)
    const enabled = settings.readTyped(RELEASE_NOTES_AUTO)
    const show = shouldAutoShowReleaseNotes({ enabled, lastShown, current, justUpdated: this.deps.justUpdated() })
    // The record only moves forward. If it were moved back when launching an older version (0.79.0 -> 0.78.0), a section already seen would open again once the version goes up again.
    if (lastShown === null || isNewerVersion(current, lastShown)) settings.writeTyped(RELEASE_NOTES_LAST_SHOWN, current)
    if (!show) return null
    const changelog = readChangelog(this.deps.appPath)
    if (changelog === null) return null
    const section = extractVersionSection(changelog, current)
    return section === null ? null : { name: `Release Notes ${current}.md`, text: `# ${PRODUCT_NAME} ${current}\n\n${section}` }
  }

  getAuto(): boolean {
    return this.deps.settings.readTyped(RELEASE_NOTES_AUTO)
  }

  setAuto(enabled: boolean): boolean {
    this.deps.settings.writeTyped(RELEASE_NOTES_AUTO, enabled)
    return enabled
  }
}
