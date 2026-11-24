/**
 * The exclusion list for the reference scope (ARCHITECTURE.md 4.4.1 / 4.4.2). macOS part.
 *
 * This list is shared by FsService's scan, the reference scope from Phase 2 on, and the Phase 3 index
 * (4.4: "the index's root set shares the same exclusion list").
 *
 * Order of evaluation:
 *   1. Exclusion by directory name / file name (node_modules etc.; always applies)
 *   2. Exclusion by path suffix (.git/objects)
 *   3. Absolute-path prefix rules (credentials, OS areas, volumes not allowed, other users...).
 *      **The longest match wins**, so `~/Library` can be excluded while `~/Library/Mobile Documents/...` is included.
 *   4. The place for the per-bundle worktrees of parallel AI work (`WORKTREES_PATH_SUFFIX`, TODO 633 stage 1).
 *      **Looked at only when none of the rules in 3 matched**: even if a worktree sits under a credentials
 *      directory (`CREDENTIAL_DIRS`), 3 must exclude it first as `credentials` (wave 29 code review).
 */
import { homedir } from 'node:os'
import { foldPath } from './uri.js'
import { LOG_FILE_NAME_PATTERN } from './log-file.js'
import { LIBRARY_INCLUDE, USER_LIBRARY_DIR, MACOS_CACHE_DIR, SYSTEM_EXCLUDE, SYSTEM_INCLUDE, TCC_DEFERRED_DIRS, TCC_DIRS } from './os/macos-paths.js'
import backendPaths from '../../compat/backend-paths.json' with { type: 'json' }

/**
 * Version of the exclusion rules. **Bump it by one whenever this list (or the verdict of `classify`) changes.**
 *
 * The version at the time the last full scan completed is kept in `app_settings` as `scan.rulesVersion`;
 * if it differs at launch, a full scan runs even within the threshold (`fs/schedule.ts`).
 * When the rules change, rows that "were indexed before but are now excluded" remain in the index,
 * and a time-based thinning check alone would miss them.
 *
 * History:
 *   1 = The rules as of Phase 3 (the version where T3 started recording).
 *   2 = Exclude `/Volumes` by default and include only allowed volumes (T4).
 *       Bumping the version makes the next launch a full scan, and rows from external disks are
 *       removed by `removeStale`.
 *   3 = Exclude `/Users` and include only your own home (T20). Other users' homes and
 *       `/Users/Shared` are out of scope. Bumped so that rows from other users already in the index
 *       are dropped by `removeStale` in the next launch's full scan.
 *   4 = Exclude `~/.aios-test` (the place for tests' temporary folders) (TODO 262).
 *       Bumping makes the next launch a full scan, and the old `~/.aios-*-test-*` rows that tests once
 *       left directly under home are also dropped by `removeStale`.
 *   5 = Exclude the place for the per-bundle worktrees of parallel AI work (`WORKTREES_PATH_SUFFIX`, at any depth
 *       in any repository) (TODO 633 stage 1). Bumping makes the next launch a full scan, and rows from
 *       worktrees already in the index are dropped by `removeStale`.
 *   6 = Add credential locations (gcloud ADC, Azure, Terraform, rclone, `~/.m2/settings.xml`, `~/.yarnrc.yml`, configstore,
 *       wrangler) and ssh key names (`id_ecdsa` etc.) (TODO 855). Bumping makes the next launch a full scan, and rows
 *       for those already in the index are dropped by `removeStale`. The same full scan also drops the symlink rows
 *       that the watch diff had put in before TODO 849 (the scan skips symlinks), so this doubles as 849's cleanup.
 *   7 = `build` / `dist` / `target` / `venv` are excluded only when their parent holds a project marker (`PROJECT_MARKERS`,
 *       TODO 1324). A marker-less `~/Documents/build/` used to vanish from the index; bumping makes the next launch a full
 *       scan so those folders come in (the scan only adds rows for newly visible folders).
 */
export const RULES_VERSION = 7

/**
 * The place for tests' temporary folders (TODO 262). `npm test` creates `<run>/<name>-XXXX` under it and
 * deletes it (`test/helpers/tmp.ts`). The app's scan, watch and listing do not enter it: if they did,
 * the trees that tests create and delete would remain as stale rows in the real index and show up in the
 * file tree and file-name search.
 *
 * Tests' own scans either pass the temporary folder as `home` (the rules are expanded from there, so they
 * are unaffected) or remove only this rule from the rules rooted at the real `homedir()`
 * (`testExclusions` in `test/helpers/tmp.ts`).
 */
export const TEST_FIXTURES_DIR = '~/.aios-test'

/** The reason of the `TEST_FIXTURES_DIR` rule. Test helpers remove the rule by this reason. */
export const TEST_FIXTURES_REASON = 'test-fixtures'

/**
 * The trash (macOS). It is excluded as a temporary area (4.4.1, reason `cache`), but is in the **view-only** exception
 * (`READ_ONLY_DIRS`, TODO 520): it can be listed from the Files tree shortcut and read in the viewer.
 * It does not enter the index, scan, watch, writes, attachments or the reference scope (`classify` ignores the exception).
 */
export const TRASH_DIR = '~/.Trash'

/**
 * Directories made a **view-only** exception (TODO 520, owner decision 2026-10-08).
 * Of what the temporary-area rule (`cache`) excluded, only what is under here (including itself, files and directories)
 * is let through by `classifyAccess(…, 'read')`. Like `readOnlyIncludes` (item 254), `classify` ignores it.
 */
const READ_ONLY_DIRS = [TRASH_DIR]

/**
 * Directories that are **not indexed but may be opened** (TODO 561, owner decision 2026-10-09). Of what the OS-area rule (`system`)
 * excluded, only what is under here (including itself) is let through by `classifyAccess` for **both reading and writing** (`'read'` and `'write'`).
 * `classify` ignores it: they do not enter scan, index, watch, file-name search or the default reference scope (`--add-dir`)
 * (what the user adds is allowed by `REFERENCEABLE_DIRS` / `classifyReference`, TODO 584).
 *
 * `/tmp` is a symlink to `/private/tmp`, so both spellings are listed (the choke point is applied to both the logical path and the real path).
 * A symlink inside `/tmp` that points to `/etc` etc. is excluded by the real path's `system` rule (`symlink-escape`).
 * The table of what remains on the "not even openable" side is in bundle C (561) of `docs/notes/wave27.md`.
 */
export const OPENABLE_DIRS = ['/tmp', '/private/tmp']

/**
 * Directories that **can be added to the reference scope (`--add-dir`)** (TODO 584 / 600, owner decision 2026-10-10). The third axis of exclusion:
 * separate from "not indexed" (`classify`) and "not even openable" (`classifyAccess`), it is whether the user may add the directory with
 * "Add to reference scope" on the attachment band (`classifyReference`). Of what the OS-area rule (`system`) excluded, only what is under here
 * (including itself) is let back. **It is not put in the default reference scope (`defaultReferenceDirs`)**: only a user action adds it.
 * For now it is only `/tmp`, the same as `OPENABLE_DIRS` (to remove the dead end of "can open it but cannot let the CLI read it").
 */
export const REFERENCEABLE_DIRS = ['/tmp', '/private/tmp']

/**
 * The per-bundle worktrees of parallel AI work (TODO 633 stage 1, bundle F of `docs/notes/wave29.md`). The spelling that contains the proper name
 * is kept in `worktreesPathSuffix` of `compat/backend-paths.json` (an area allowed by constraint 6). They are excluded at any depth
 * under any repository, because there is one identical tree per bundle and they would otherwise appear many times over in
 * scan, full-text search and file-name search. This is a path-suffix rule that works wherever it appears, not a list of absolute paths
 * (like `OPENABLE_DIRS`), so `classify` looks at it directly (it does not go through `rules`; it is the same for every
 * `createMacosExclusions`, regardless of home). As with `/tmp`, **opening is allowed** (`classifyAccess` returns reason `worktree` for both read and write).
 * Cleanup (the other half of stage 1: removing worktrees left by `-p` and git locks) and following the cwd are out of scope (only exclusion this time).
 */
export const WORKTREES_PATH_SUFFIX: string = backendPaths.worktreesPathSuffix

/** Mount point of external storage (macOS). Replaced in tests. */
export const DEFAULT_VOLUMES_DIR = '/Volumes'

/**
 * Where users' homes live (macOS). It is excluded wholesale, and only your own home is
 * restored with `include` (T20, 4.4.2.2). `/Users/Shared` is not included either.
 */
export const USERS_DIR = '/Users'

export type RuleAction = 'exclude' | 'include'

export interface PrefixRule {
  /** Absolute path, case-folded. */
  readonly prefix: string
  /** Absolute path before case folding. Used to compute the index roots (Phase 3). */
  readonly raw: string
  readonly action: RuleAction
  readonly reason: string
}

export interface ExclusionRules {
  readonly home: string
  readonly prefixes: readonly PrefixRule[]
  /** Directory names excluded at any depth, whatever surrounds them (case-folded). */
  readonly dirNames: ReadonlySet<string>
  /**
   * Directory names excluded **only when the parent directory holds a project marker** (case-folded, TODO 1324:
   * `build` / `dist` / `target` / `venv`). `classify` takes the answer to "does the parent hold a marker" as an argument.
   */
  readonly projectDirNames: ReadonlySet<string>
  /** Names that make a directory a project root (case-folded, `PROJECT_MARKERS`). Only the name's existence counts, never the content. */
  readonly projectMarkers: ReadonlySet<string>
  /** File names excluded at any depth (case-folded). */
  readonly fileNames: ReadonlySet<string>
  /**
   * Patterns of file names excluded at any depth (applied to the name before case folding). For now only aios's own log
   * `aios-YYYYMMDD-HHMMSS.log` (TODO 376, owner decision 2026-10-04). The reason code is `app-log`.
   */
  readonly fileNamePatterns: readonly RegExp[]
  /** Excluded on a path-suffix match (case-folded, starting with `/`). */
  readonly pathSuffixes: readonly string[]
  /** Mount point of external storage (before case folding). Default `/Volumes`. */
  readonly volumesDir: string
  /**
   * Mount paths of allowed volumes (before case folding). They are in as `include` rules and
   * beat the `volumesDir` exclusion by longest match. **Only volumes that are mounted now and also passed
   * the UUID check can be passed** (the "valid allow" in `fs/volumes.ts`).
   */
  readonly allowedVolumes: readonly string[]
  /**
   * A narrow exception that allows **reading only** (item 254, `readOnlyIncludes` in `compat/backend-paths.json`).
   * A sequence of segments made by splitting a case-folded absolute path on `/`. A segment containing `*` matches exactly one segment.
   * `classify` **ignores** it (it has no effect on scan, index, `--add-dir` or writes). Only
   * `classifyAccess(..., 'read')` looks at it, which is the read path that feeds the viewer (`resolvePath` in `fs-policy.ts`).
   */
  readonly readOnlyIncludes: readonly (readonly string[])[]
  /**
   * The subset of `readOnlyIncludes` that also allows **saving from the viewer** (the user's skill SKILL.md, `writableIncludes` in
   * `compat/backend-paths.json`). Only `classifyAccess(..., 'edit')` looks at it. It has no effect on `classify`, `'write'` (listing, stat, attachments, `--add-dir`)
   * or the index. The shape is the same as `readOnlyIncludes`.
   */
  readonly writableIncludes: readonly (readonly string[])[]
  /**
   * **View-only** directories (TODO 520, the trash). Case-folded absolute paths. Of what the temporary-area rule (`cache`)
   * excluded, only what is under here (including itself) is let through by `classifyAccess(..., 'read')`.
   * It applies to listing (`fs/list`) and viewer reads, and not to scan, index, writes or attachments.
   */
  readonly readOnlyDirs: readonly string[]
  /**
   * Directories that are **not indexed but can be opened** (TODO 561, `/tmp`). Case-folded absolute paths. Of what the OS-area rule (`system`)
   * excluded, only what is under here (including itself) is let through by `classifyAccess` for both read and write. `classify` ignores it.
   * It is not applied to a plugin's declared scope (`fsRead`): the Broker applies it there as empty (a plugin's permissions do not change).
   */
  readonly openableDirs: readonly string[]
  /**
   * Directories that **can be added to the reference scope** (TODO 584, `/tmp`). Case-folded absolute paths. Of what the OS-area rule (`system`)
   * excluded, only what is under here (including itself) is let back by `classifyReference`. `classify` / `classifyAccess` ignore it.
   */
  readonly referenceableDirs: readonly string[]
}

export interface ExclusionOptions {
  /** Valid allowed volumes (mount paths). */
  readonly allowedVolumes?: readonly string[]
  /** For tests: the directory used instead of `/Volumes`. */
  readonly volumesDir?: string
}

/** 4.4.1 generated files: directory names excluded at any depth, whatever surrounds them. */
const GENERATED_DIR_NAMES = [
  'node_modules',
  '.venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.tox',
  '.mypy_cache',
  '.pytest_cache'
]

/**
 * 4.4.1 generated files whose names are also ordinary words (TODO 1324): excluded only when the parent directory holds one of
 * `PROJECT_MARKERS`. A hand-made `~/Documents/build/` (architecture papers) has no marker beside it and stays visible.
 */
const PROJECT_GENERATED_DIR_NAMES = ['build', 'dist', 'target', 'venv']

/**
 * Names whose presence in a directory makes it a project root (TODO 1324, owner decision 2026-11-23: markers only, `.gitignore` is not read).
 * **The one place of the table.** Only the name's existence is looked at: the content is never read and a symlink or FIFO is never opened
 * (`readdir` only). Compared case-insensitively like every other name rule (`foldPath`), so `Package.json` counts.
 */
export const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'pyproject.toml',
  'setup.py',
  'Makefile',
  'CMakeLists.txt',
  '.git'
]

/** 4.4.1 credentials: file names excluded at any depth. */
const CREDENTIAL_FILE_NAMES = [
  '.netrc',
  '.npmrc',
  '.pgpass',
  // Default names of ssh private keys (TODO 855 added ecdsa / dsa / the FIDO `_sk` variants).
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'id_ed25519_sk',
  'id_ecdsa_sk'
]

/** macOS metadata and temporary files. Scanning them only adds noise. */
const NOISE_FILE_NAMES = ['.ds_store', '.localized', 'icon\r']

/** 4.4.1 credentials: absolute paths under home. */
const CREDENTIAL_DIRS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.docker/config.json',
  '~/.kube',
  '~/.gem/credentials',
  '~/.cargo/credentials.toml',
  // TODO 855 (owner decision 2026-10-17): places that hold tokens in plain text. A file can also be excluded by a prefix rule
  // (same as `~/.docker/config.json`).
  '~/.config/gcloud/application_default_credentials.json',
  '~/.config/gcloud/legacy_credentials',
  '~/.azure',
  '~/.terraform.d/credentials.tfrc.json',
  '~/.config/rclone/rclone.conf',
  '~/.m2/settings.xml',
  '~/.yarnrc.yml',
  '~/.config/configstore',
  '~/.wrangler/config',
  ...backendPaths.credentialDirs
]

/** 4.4.1 temporary areas / package caches. */
const CACHE_DIRS = [
  '~/.cache',
  TRASH_DIR,
  '~/.npm',
  '~/.bun/install/cache',
  '~/.cargo/registry',
  '~/.m2/repository',
  '~/.pub-cache',
  '~/.cocoapods',
  '~/go/pkg/mod',
  MACOS_CACHE_DIR
]


/**
 * Places protected by TCC (the macOS privacy protection) (TODO 881). Touching them can bring up the "... would like to access files in a folder"
 * dialog, so even for `'handoff'` (just handing off to an outside app; other places under `~/Library` pass) they are refused **before stat**.
 * The reason is `TCC_REASON` (it is in `HANDOFF_DENIED_REASONS`). Under `~/Library` things are already excluded as `app-internal`,
 * so read/write/index results do not change (only the reason's name changes). The grounds (the kind of TCC) are attached to each row.
 */
export const TCC_REASON = 'tcc-protected'

/**
 * **Places for the user's documents** protected by TCC (TODO 805, owner decision 2026-10-19). Unlike `TCC_DIRS` they are not excluded
 * (they are subject to index, search and reference), but **scan and watch do not touch them for the first 3 days after they are added**, to avoid
 * a row of "would like to access the Desktop / Documents / Downloads folder" dialogs right after the first launch. Only the index process's scan and watch are
 * delayed; the paths where the user opens something or adds it to the reference scope pass as before, and end the deferral at that point
 * (`FsIndexer.releaseTccDeferral`). It does not overlap with `TCC_DIRS` (always excluded) (`test/tcc-deferral.test.ts`).
 */
export { TCC_DEFERRED_DIRS }

/** Length of the deferral (TODO 805, owner decision 2026-10-19: 3 days). */
export const TCC_DEFER_MS = 3 * 24 * 60 * 60 * 1000

export function tccDeferredPaths(home: string): readonly string[] {
  return TCC_DEFERRED_DIRS.map((dir) => expand(home, dir))
}

export function isUnderTccDeferred(path: string, home: string): boolean {
  const folded = foldPath(path)
  return tccDeferredPaths(home).some((dir) => underPrefix(folded, foldPath(dir)))
}

/** Reason for the exclusion of deferred places (appears only in the scan and watch rules). */
export const TCC_DEFERRED_REASON = 'tcc-deferred'

/**
 * Rules applied only to scan and watch (TODO 805). A copy of `rules` plus the exclusion of deferred places (reason `TCC_DEFERRED_REASON`).
 * It rides on `classify`'s longest match as is, so `walk` does not descend (and makes no rows), `watchPlan` passes it to the native `ignore`
 * (so parcel does not `stat` / `open` on an ambiguous FSEvents diff), and watch diffs are dropped too. **It is not given to the choke point (`resolvePath`), listing
 * or the Broker**: the paths for opening are not blocked.
 */
export function withTccDeferred(rules: ExclusionRules): ExclusionRules {
  const extra: PrefixRule[] = tccDeferredPaths(rules.home).map((raw) => ({
    prefix: foldPath(raw),
    raw,
    action: 'exclude',
    reason: TCC_DEFERRED_REASON
  }))
  const prefixes = [...rules.prefixes, ...extra].sort((a, b) => b.prefix.length - a.prefix.length)
  return { ...rules, prefixes }
}

function expand(home: string, value: string): string {
  return value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
}

/**
 * Builds the exclusion rules for macOS.
 *
 * `~/Library/Containers/<app>/Data/Documents` and `~/Library/Application Support/Code/User`
 * are "selectable in settings, excluded by default" in 4.4.2, so they are left to the `~/Library` exclusion
 * and no individual include is placed.
 *
 * **External storage (T4)**: `/Volumes` is excluded by default, and only the mount paths passed in
 * `allowedVolumes` override it with `include` (longest match). Scan, `assertAllowed` and the
 * Broker, the three paths, all apply these rules through `classify`, so the verdict is in this one place.
 * A symlink that goes from outside `/Volumes` to the inside is blocked not by this function but by the caller,
 * which applies `classify` once more after realpath (`fs-policy.ts` / `scanner.ts`).
 *
 * **Other users' homes (T20)**: `/Users` is `exclude` (reason `other-users`) and `home` is
 * `include` (reason `own-home`). With the same longest match only `/Users/<you>` remains, and
 * `/Users/<other>` and `/Users/Shared` are out of scope on all three paths. Credential rules such as `~/.ssh`
 * are expanded only from `~`, so without this 4.4.1 would hold only for your own home.
 * `/Users/Shared` is not included because the cost of triggering TCC dialogs outweighs the value of indexing
 * another user's write location (if needed, add it through an allow list).
 */
export function createMacosExclusions(
  home: string = homedir(),
  options: ExclusionOptions = {}
): ExclusionRules {
  const volumesDir = options.volumesDir ?? DEFAULT_VOLUMES_DIR
  const allowedVolumes = [...(options.allowedVolumes ?? [])]
  const prefixes: PrefixRule[] = []
  const add = (value: string, action: RuleAction, reason: string): void => {
    const raw = expand(home, value)
    prefixes.push({ prefix: foldPath(raw), raw, action, reason })
  }

  for (const dir of SYSTEM_EXCLUDE) add(dir, 'exclude', 'system')
  for (const dir of SYSTEM_INCLUDE) add(dir, 'include', 'user-installed')
  add(volumesDir, 'exclude', 'external-volume')
  for (const mount of allowedVolumes) add(mount, 'include', 'allowed-volume')
  add(USERS_DIR, 'exclude', 'other-users')
  add(home, 'include', 'own-home')
  add(USER_LIBRARY_DIR, 'exclude', 'app-internal')
  for (const dir of LIBRARY_INCLUDE) add(dir, 'include', 'user-documents')
  for (const dir of TCC_DIRS) add(dir, 'exclude', TCC_REASON)
  for (const dir of CREDENTIAL_DIRS) add(dir, 'exclude', 'credentials')
  for (const dir of CACHE_DIRS) add(dir, 'exclude', 'cache')
  add(TEST_FIXTURES_DIR, 'exclude', TEST_FIXTURES_REASON)

  // Check longer prefixes first so that the longest match wins.
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length)

  return {
    home,
    prefixes,
    dirNames: new Set(GENERATED_DIR_NAMES.map(foldPath)),
    projectDirNames: new Set(PROJECT_GENERATED_DIR_NAMES.map(foldPath)),
    projectMarkers: new Set(PROJECT_MARKERS.map(foldPath)),
    fileNames: new Set([...CREDENTIAL_FILE_NAMES, ...NOISE_FILE_NAMES].map(foldPath)),
    // aios's own logs (TODO 376). The real ones are in `~/Library/Logs/aios/` (already excluded by the `~/Library` exclusion), but
    // a `--user-data-dir` copy writes to `<userData>/logs/`, so exclude by name. RULES_VERSION is not bumped
    // (bumping makes the next launch a full scan; rows already in the index are dropped by `removeStale` in the periodic full scan).
    fileNamePatterns: [LOG_FILE_NAME_PATTERN],
    pathSuffixes: ['/.git/objects'],
    volumesDir,
    allowedVolumes,
    readOnlyIncludes: backendPaths.readOnlyIncludes.map((pattern) =>
      foldPath(expand(home, pattern)).split('/')
    ),
    writableIncludes: (backendPaths.writableIncludes ?? []).map((pattern) =>
      foldPath(expand(home, pattern)).split('/')
    ),
    readOnlyDirs: READ_ONLY_DIRS.map((dir) => foldPath(expand(home, dir))),
    openableDirs: OPENABLE_DIRS.map((dir) => foldPath(dir)),
    referenceableDirs: REFERENCEABLE_DIRS.map((dir) => foldPath(dir))
  }
}

/**
 * Whether it is a mount path directly under `volumesDir` (the form `/Volumes/<name>`).
 * Only this form can be the subject of an allow (a directory below it is not allowed individually).
 */
export function isVolumeMountPath(path: string, volumesDir: string = DEFAULT_VOLUMES_DIR): boolean {
  const folded = foldPath(path)
  const dir = foldPath(volumesDir)
  if (!folded.startsWith(`${dir}/`)) return false
  const rest = folded.slice(dir.length + 1)
  return rest.length > 0 && !rest.includes('/') && rest !== '.' && rest !== '..'
}

function underPrefix(folded: string, prefix: string): boolean {
  return folded === prefix || folded.startsWith(`${prefix}/`)
}

export interface ExclusionVerdict {
  readonly excluded: boolean
  readonly reason: string | null
}

/** Whether `name` is one of the generated-folder names that are excluded only beside a project marker (TODO 1324). */
export function isProjectDirName(name: string, rules: ExclusionRules): boolean {
  return rules.projectDirNames.has(foldPath(name))
}

/** Whether any of `names` (the entries of one directory) is a project marker. Pure: the caller supplies the names. */
export function hasProjectMarker(names: Iterable<string>, rules: ExclusionRules): boolean {
  for (const name of names) if (rules.projectMarkers.has(foldPath(name))) return true
  return false
}

/**
 * Decides whether to exclude one entry. `name` is the directory / file name.
 * `absolutePath` is the absolute path before case folding.
 *
 * `parentHasMarker` (TODO 1324): whether the entry's parent directory holds a project marker. It matters only for the
 * names in `projectDirNames` (`build` etc.), and it stays a pure function: the caller reads the parent (the scan already has the
 * names from its readdir; the others use `project-marker.ts`). Omitted means "no marker", so a caller that cannot know errs on the visible side.
 */
export function classify(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules,
  parentHasMarker: boolean = false
): ExclusionVerdict {
  const foldedName = foldPath(name)
  if (isDirectory && rules.dirNames.has(foldedName)) return { excluded: true, reason: 'generated' }
  if (isDirectory && parentHasMarker && rules.projectDirNames.has(foldedName)) {
    return { excluded: true, reason: 'generated' }
  }
  if (!isDirectory && rules.fileNames.has(foldedName)) {
    return { excluded: true, reason: 'credentials-or-noise' }
  }
  if (!isDirectory && rules.fileNamePatterns.some((pattern) => pattern.test(name))) {
    return { excluded: true, reason: 'app-log' }
  }

  const folded = foldPath(absolutePath)
  for (const suffix of rules.pathSuffixes) {
    if (folded.endsWith(suffix) || folded.includes(`${suffix}/`)) {
      return { excluded: true, reason: 'generated' }
    }
  }

  // Prefix rules (credentials, OS areas, volumes not allowed, other users...) come first. `classifyAccess` returns the worktree
  // reason unconditionally for both read and write, so if it were looked at first, a worktree under a credentials directory (`CREDENTIAL_DIRS`)
  // would slip past that exclusion (constraint 2) (wave 29 code review). Worktree only when no exclusion matched.
  for (const rule of rules.prefixes) {
    if (!underPrefix(folded, rule.prefix)) continue
    if (rule.action === 'exclude') return { excluded: true, reason: rule.reason }
    break
  }

  if (folded.endsWith(WORKTREES_PATH_SUFFIX) || folded.includes(`${WORKTREES_PATH_SUFFIX}/`)) {
    return { excluded: true, reason: 'worktree' }
  }
  return { excluded: false, reason: null }
}

/** For when only the boolean of `classify` is needed. */
export function isExcluded(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules
): boolean {
  return classify(absolutePath, name, isDirectory, rules).excluded
}

/**
 * What the path is used for (item 254). `'write'` has no exceptions (the default: writes, listing, reference scope, stat, etc.),
 * `'read'` is passed only by the read path that feeds the viewer, and the `readOnlyIncludes` exception applies.
 * `'edit'` is passed only by the viewer's **save**, and lets through only `writableIncludes` (the user's skill SKILL.md).
 * The only thing that works for either is `openableDirs` (TODO 561, `/tmp`), "not indexed but openable".
 *
 * `'handoff'` (TODO 808) is passed by the paths that **only hand off to an outside app** (open in an external editor, reveal in Finder). aios does not
 * read or write the contents. In addition to what passes under `'write'`, it lets through exclusions other than credentials (`HANDOFF_DENIED_REASONS`) (OS areas,
 * `~/Library`, caches, generated files, other people's homes, volumes not allowed...). The read exception
 * (`readOnlyIncludes` = auto memory `.md`) does not apply: nothing under the backend's credential locations is handed outside either (constraint 2).
 */
export type PathAccess = 'read' | 'write' | 'edit' | 'handoff'

/**
 * Exclusion reasons that are not let through even for `'handoff'` (TODO 808). Credential locations (prefix rules) and credential file names
 * excluded at any depth (`.netrc`, `id_rsa` ...). Owner decision 2026-10-18: "do not loosen the exclusion of secret locations".
 *
 * Also **places that never do I/O** (fix from the wave 44 code review): other users' homes (`other-users`, the TCC
 * dialog) and volumes not allowed (`external-volume`, which would trigger a network mount). Passing the choke point makes
 * `resolvePath`'s realpath / lstat touch them, so even the entry point that hands off outside refuses. The autofs `/net`, `/home` and `/Network`
 * (reason `system`) are refused the same way through `HANDOFF_NO_IO_DIRS`.
 */
export const HANDOFF_DENIED_REASONS: ReadonlySet<string> = new Set([
  'credentials',
  'credentials-or-noise',
  'other-users',
  'external-volume',
  // Places protected by TCC (TODO 881): stat can bring up a privacy dialog.
  TCC_REASON
])

/** OS areas not let through even for `'handoff'` (autofs: touching them triggers a mount; part of `SYSTEM_EXCLUDE`). Case-folded form. */
const HANDOFF_NO_IO_DIRS = ['/net', '/home', '/network']

/** One segment of a pattern and one segment of a path. `*` matches any string that does not start with `.` (empty is not allowed). */
function matchSegment(pattern: string, segment: string): boolean {
  if (!pattern.includes('*')) return pattern === segment
  if (segment === '' || segment.startsWith('.')) return false
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  return new RegExp(`^${body}$`).test(segment)
}

/** Whether any of `readOnlyIncludes` matches (absolute path before case folding). Only entries with the same number of segments. */
export function matchesReadOnlyInclude(absolutePath: string, rules: ExclusionRules): boolean {
  return matchesPatterns(absolutePath, rules.readOnlyIncludes)
}

/** Whether any of `writableIncludes` matches. */
export function matchesWritableInclude(absolutePath: string, rules: ExclusionRules): boolean {
  return matchesPatterns(absolutePath, rules.writableIncludes)
}

function matchesPatterns(absolutePath: string, patterns: readonly (readonly string[])[]): boolean {
  const segments = foldPath(absolutePath).split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) return false
  return patterns.some(
    (pattern) =>
      pattern.length === segments.length &&
      pattern.every((part, i) => matchSegment(part, segments[i] ?? ''))
  )
}

/**
 * `classify` plus the exceptions for paths that open things (item 254 / TODO 520 / TODO 561). Lets through only when `access === 'read'`, the **file** was
 * excluded by the credentials prefix rule (`credentials`), and it matches `readOnlyIncludes`.
 * What was excluded by a file-name rule (`.netrc` etc.), generated files or an OS area is not an exception.
 */
export function classifyAccess(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules,
  access: PathAccess,
  parentHasMarker: boolean = false
): ExclusionVerdict {
  const verdict = classify(absolutePath, name, isDirectory, rules, parentHasMarker)
  // Only handing off to an outside app (TODO 808). Only the credentials exclusion remains.
  if (access === 'handoff') {
    if (verdict.excluded && verdict.reason !== null && HANDOFF_DENIED_REASONS.has(verdict.reason)) return verdict
    if (verdict.excluded && verdict.reason === 'system') {
      const folded = foldPath(absolutePath)
      if (HANDOFF_NO_IO_DIRS.some((dir) => underPrefix(folded, dir))) return verdict
    }
    return { excluded: false, reason: null }
  }
  if (
    access === 'read' &&
    verdict.excluded &&
    verdict.reason === 'credentials' &&
    !isDirectory &&
    matchesReadOnlyInclude(absolutePath, rules)
  ) {
    return { excluded: false, reason: null }
  }
  if (
    access === 'edit' &&
    verdict.excluded &&
    verdict.reason === 'credentials' &&
    !isDirectory &&
    matchesWritableInclude(absolutePath, rules)
  ) {
    return { excluded: false, reason: null }
  }
  // A per-bundle worktree of parallel AI work is allowed to be opened wherever it is (TODO 633 stage 1, same idea as `/tmp`).
  if (verdict.excluded && verdict.reason === 'worktree') {
    return { excluded: false, reason: null }
  }
  // Directories not indexed but openable (TODO 561, `/tmp`). Only what the OS-area rule excluded is let back for both read and write;
  // `node_modules` (generated), `.netrc` (credentials-or-noise) etc. inside are not let back.
  if (verdict.excluded && verdict.reason === 'system' && rules.openableDirs.length > 0) {
    const folded = foldPath(absolutePath)
    if (rules.openableDirs.some((dir) => underPrefix(folded, dir))) {
      return { excluded: false, reason: null }
    }
  }
  // View-only directories (TODO 520, the trash). Only what the temporary-area rule excluded is let back; `node_modules` (generated),
  // `.netrc` (credentials-or-noise) etc. inside are not let back.
  if (access === 'read' && verdict.excluded && verdict.reason === 'cache') {
    const folded = foldPath(absolutePath)
    if (rules.readOnlyDirs.some((dir) => underPrefix(folded, dir))) {
      return { excluded: false, reason: null }
    }
  }
  return verdict
}

/**
 * Whether it may be added to the reference scope (`--add-dir`) (TODO 584, the third axis of exclusion). Adds to `classify` an exception that lets back only
 * what the OS-area rule (`system`) excluded under `referenceableDirs` (`/tmp`). `node_modules` (generated) etc. inside are not let back.
 * It is called only by `FsAccess.isReferenceable` (the user's add action = `SessionManager.allowDir`, and the viewer's memory).
 */
export function classifyReference(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules,
  parentHasMarker: boolean = false
): ExclusionVerdict {
  const verdict = classify(absolutePath, name, isDirectory, rules, parentHasMarker)
  if (verdict.excluded && verdict.reason === 'system' && rules.referenceableDirs.length > 0) {
    const folded = foldPath(absolutePath)
    if (rules.referenceableDirs.some((dir) => underPrefix(folded, dir))) {
      return { excluded: false, reason: null }
    }
  }
  return verdict
}
