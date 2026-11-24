/**
 * FsAccess - the "file entry point" that remained on the main side (P1, ARCHITECTURE.md chapter 3 / 4.4).
 *
 * In P1, scanning, the index, listing and file-name search moved to the index process. What remains in main is
 * **only the work that does not read a single byte of the DB**:
 *
 * ```
 * assertAllowed   the only choke point that validates a URI from the renderer (12.3)
 * stat            metadata for one item (looks at the file system, not the index)
 * roots           the sidebar roots
 * defaultReferenceDirs / isReferenceable   a thread's default reference ranges (4.4)
 * ```
 *
 * **The viewer's save (`writeTextFile`) was removed in the 2026-10-01 review** - it had no production caller
 * (saving has been `ViewerBroker.write` since Phase 4 = Broker permission + realpath + O_NOFOLLOW + audit), and
 * this was a weak entry point that wrote to a logical path without O_NOFOLLOW. The save checks are in the
 * "ViewerBroker.write" section of `test/capability-resource.test.ts`.
 *
 * **`readResource` was removed in item 160 (2026-09-28)**. It had no production caller (in review D-5
 * `protocol.ts` stopped reading the body, and the viewer's reading moved to `ViewerBroker.read` = via the Broker),
 * and only `test/fsservice.test.ts` called it directly. The same checks
 * (text / binary detection, refusing OS areas and excluded paths) are already in `test/capability-resource.test.ts`
 * (the C-2 section, text/binary detection) and `test/capability-fs.test.ts` (refusing excluded paths; `resolvePath`
 * / `classify` are the same pure functions shared with `assertAllowed`).
 *
 * It is also **the only holder of the exclusion rules on the main side** (3.5). The Broker / ViewerBroker read
 * `exclusionRules` through a getter each time, so when the allowed volumes change it takes effect on
 * all 3 paths (the app itself / the Broker / the viewer) at once. The rules are built from the **same pure function** as in the index process,
 * `createMacosExclusions(home, { allowedVolumes })`, and from the index process only
 * the material (`allowedVolumes`) arrives via `ntf rules` - no copy of the rules is passed.
 *
 * This is a move from the old `FsService`, so the decisions and the return shapes are unchanged.
 * Only two things changed:
 *  - `stat` looks at `lstat`, not the index (main does not read the index tables).
 *  - `defaultReferenceDirs` reads directly under the home with `readdir` (same reason).
 *    Both are a few dozen entries and give the same answer whether or not a scan has run.
 */
import { lstatSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { FOLDER_SHORTCUTS, type FileEntry, type FolderShortcut } from '@shared/types.js'
import { pathToUri } from '../../common/uri.js'
import { APPLICATIONS_DIR, ICLOUD_DRIVE_REL } from '../../common/os/macos-paths.js'
import { log, errorFields } from '../../common/logger.js'
import { pathFromUri, resolvePath, type PathAccess } from '../../common/fs-policy.js'
import { classifyAccessOnDisk, classifyOnDisk, classifyReferenceOnDisk } from '../../common/project-marker.js'
import {
  DEFAULT_VOLUMES_DIR,
  classifyAccess,
  createMacosExclusions,
  type ExclusionRules
} from '../../common/exclusions.js'

/**
 * Where the shortcuts at the top of the Files tree live (TODO 520). `~/` is relative to the home, anything else is an absolute path.
 * The order is `FOLDER_SHORTCUTS`. `/Applications` is outside the exclusions (4.4.2 `user-installed`),
 * and the Trash is an exception that stays excluded (temporary area) but can be viewed (`READ_ONLY_DIRS` in `exclusions.ts`).
 */
const SHORTCUT_PATHS: Readonly<Record<FolderShortcut, string>> = {
  downloads: '~/Downloads',
  desktop: '~/Desktop',
  applications: APPLICATIONS_DIR,
  movies: '~/Movies',
  documents: '~/Documents',
  trash: '~/.Trash',
  // TODO 561: not indexed but can be opened (`OPENABLE_DIRS` in `exclusions.ts`). A symlink to `/private/tmp`.
  tmp: '/tmp'
}

/** Cap when reading directly under the home. Do not collect reference-range candidates without limit. */
const MAX_HOME_ENTRIES = 5000

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

export class FsAccess {
  private rules: ExclusionRules
  private allowedVolumes: readonly string[] = []
  private volumesDir: string = DEFAULT_VOLUMES_DIR

  constructor(
    private readonly home: string = homedir(),
    /** Explicit scan roots (for tests). If null, the whole PC. */
    private readonly explicitRoots: readonly string[] | null = null,
    /** Where the "Applications" shortcut points (for tests, TODO 520). */
    private readonly applicationsDir: string = APPLICATIONS_DIR,
    /** Where the `/tmp` shortcut points (for tests, TODO 561). */
    private readonly tmpDir: string = '/tmp'
  ) {
    // Right after launch the allowed volumes are empty = every volume is excluded. Rebuilt when the index process's
    // `ntf rules` arrives. Start from the safe side (4.4.2).
    this.rules = this.buildRules()
  }

  private buildRules(): ExclusionRules {
    return createMacosExclusions(this.home, {
      allowedVolumes: this.allowedVolumes,
      volumesDir: this.volumesDir
    })
  }

  /**
   * Rebuilds the rules from the allowed volumes that came from the index process (3.5).
   * **Same input + same pure function**, so the rules of the two processes match structurally.
   */
  rebuildRules(allowedVolumes: readonly string[], volumesDir: string): void {
    this.allowedVolumes = [...allowedVolumes]
    this.volumesDir = volumesDir
    this.rules = this.buildRules()
  }

  /** The Broker / ViewerBroker read this each time (the scope in `index.ts` wraps it in a getter). */
  get exclusionRules(): ExclusionRules {
    return this.rules
  }

  get homePath(): string {
    return this.home
  }

  get homeUri(): string {
    return pathToUri(this.home)
  }

  /**
   * The sidebar roots. First, shortcuts to macOS's standard folders (TODO 520, marked with `shortcut`,
   * ones that do not exist are not shown), then the home, then `/` as the entrance to the whole PC (the index now covers the whole PC, so
   * make it reachable from the list too - 12.7). A shortcut appears twice with the same folder inside `~/` (owner decision).
   * When the scan roots are given explicitly (tests), no shortcuts are shown.
   */
  roots(): readonly FileEntry[] {
    const entries: FileEntry[] = this.explicitRoots === null ? this.shortcutRoots() : []
    for (const path of this.explicitRoots ?? [this.home, '/']) {
      entries.push({
        uri: pathToUri(path),
        parentUri: null,
        name: path === '/' ? '/' : basename(path),
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        ext: ''
      })
    }
    return entries
  }

  /**
   * The shortcut roots (TODO 520). Only directories that really exist (symlinks are not followed - a shortcut whose contents point elsewhere is
   * not shown). The list's gate is applied as read (`'read'`), so the excluded Trash is also put through the same check here, and
   * shortcuts that cannot be opened are not listed.
   */
  private shortcutRoots(): FileEntry[] {
    const entries: FileEntry[] = []
    for (const kind of FOLDER_SHORTCUTS) {
      const raw = SHORTCUT_PATHS[kind]
      const path =
        kind === 'applications'
          ? this.applicationsDir
          : kind === 'tmp'
            ? this.tmpDir
            : raw.startsWith('~/')
              ? resolve(this.home, raw.slice(2))
              : raw
      try {
        // `/tmp` is a symlink the OS places to `/private/tmp`, so follow it (TODO 561). The URI stays `/tmp` -
        // so that revealing an answer's link (`/tmp/…`) hits the shortcut side. Other shortcuts are not followed.
        const stats = kind === 'tmp' ? statSync(path) : lstatSync(path)
        if (!stats.isDirectory()) continue
      } catch {
        continue
      }
      if (classifyAccessOnDisk(path, basename(path), true, this.rules, 'read').excluded) continue
      entries.push({
        uri: pathToUri(path),
        parentUri: null,
        name: basename(path),
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        ext: '',
        shortcut: kind
      })
    }
    return entries
  }

  /**
   * A thread's default reference ranges (ARCHITECTURE.md 4.4 table "user area under the home").
   *
   * **Putting something here is equivalent to "letting it be read in full without approval"** (spike 9d).
   * Even after the index was widened to the whole PC, the default of `--add-dir` stays under the home (12.7).
   *
   * Since P1 this looks at a `readdir` directly under the home rather than the index. It is a few dozen entries of
   * synchronous reading, and simpler for no longer depending on whether the scan has reached it.
   */
  defaultReferenceDirs(): readonly string[] {
    const dirs: string[] = []
    try {
      let seen = 0
      for (const entry of readdirSync(this.home, { withFileTypes: true })) {
        if (seen >= MAX_HOME_ENTRIES) break
        seen += 1
        // Dot directories are not passed by default. We do not want the places where settings and credentials gather
        // to be on the "readable without approval" side.
        if (entry.name.startsWith('.')) continue
        const full = resolve(this.home, entry.name)
        // A symlink is not followed even if its target is a real directory (the range would become unreadable).
        if (!entry.isDirectory()) continue
        if (classifyOnDisk(full, entry.name, true, this.rules).excluded) continue
        dirs.push(full)
      }
    } catch (err) {
      log.warn('fs.referenceDirs.failed', errorFields(err))
    }
    // 4.4.2: iCloud Drive is the real home of user documents, so include it.
    const iCloud = resolve(this.home, ICLOUD_DRIVE_REL)
    try {
      if (statSync(iCloud).isDirectory()) dirs.push(iCloud)
    } catch {
      // It does not exist in an environment where it is unused.
    }
    dirs.sort()
    return dirs
  }

  /**
   * Whether a directory may be used as a reference range (handling of files dropped by drag and drop, 4.5).
   * A path that hits the exclusion list is not put into the reference ranges even if the user approves. But `/tmp` can be added
   * (TODO 584, `referenceableDirs` of `classifyReference`). It is not put into the default reference ranges (`classify` above).
   */
  isReferenceable(path: string): boolean {
    return !classifyReferenceOnDisk(path, basename(path), true, this.rules).excluded
  }

  /**
   * Whether a file may be shown in the viewer **for reading** (item 254). Used by the thread's ViewerPane memory
   * (item 63, `setViewerState`). Unlike `isReferenceable`, the read exception
   * (`readOnlyIncludes` = the auto memory `.md`) applies. It is not used for reference ranges (`--add-dir`).
   */
  isViewable(path: string): boolean {
    return !classifyAccess(path, basename(path), false, this.rules, 'read').excluded
  }

  /**
   * The only choke point that validates a URI from the renderer (12.3).
   *
   * The decision is "it is an absolute path" and "it does not hit the exclusion list" (in Phase 3 the
   * "inside the scan roots" precondition was removed). The canonical path (realpath) is also re-checked,
   * so a symlink placed inside the allowed range that points outside it is refused (Phase 4).
   * It shares **the same single implementation** (`common/fs-policy.ts`) with `CapabilityBroker.fs`.
   *
   * The return value is the **logical path** (not the canonical one), because the list and the tree
   * must show the path the user walked. The paths that actually open it (the protocol handler / Broker /
   * `ViewerBroker`) use canonical and O_NOFOLLOW.
   */
  assertAllowed(uri: string, asDirectory: boolean, access: PathAccess = 'write'): string {
    const path = pathFromUri(uri)
    // The default of `access` is no exceptions (`'write'`). Only read-only callers (resolving links and validating selection ranges,
    // item 254) pass `'read'`, which lets the auto memory `.md` through (the exception in 4.4.1).
    resolvePath(path, { rules: this.rules }, asDirectory, access)
    return path
  }

  /** Metadata for one item. Looks at the file system, not the index (main does not read the index tables). */
  stat(uri: string): FileEntry | null {
    const path = this.assertAllowed(uri, true)
    let stats
    try {
      stats = lstatSync(path)
    } catch {
      return null
    }
    const isDirectory = stats.isDirectory()
    const parent = path === '/' ? null : dirname(path)
    return {
      uri: pathToUri(path),
      parentUri: parent === null ? null : pathToUri(parent),
      name: path === '/' ? '/' : basename(path),
      isDirectory,
      size: isDirectory ? 0 : stats.size,
      mtimeMs: stats.mtimeMs,
      ext: isDirectory ? '' : extensionOf(basename(path))
    }
  }
}
