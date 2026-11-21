/**
 * The shape of the install location for distributed versions, and the check of whether the running aios is operating on it (TODO 103 stage 1, ARCHITECTURE.md 8.5).
 *
 * **The shape is the same as `scripts/install-temoto.sh`** (`test/update-layout.test.ts` compares the two literally):
 *
 *     ~/Applications/Temoto.app          the real copy of the version currently installed (TODO 1050. The path the Dock remembers always points at the latest)
 *     <root>/versions/<version>/Temoto.app    old versions set aside, and fetched-and-verified versions before installing (the default root is ~/.local/share/<data name>)
 *     <root>/install.json               { "link": "<~/Applications/Temoto.app>", "releaseRepo": "<owner/name>", "hold"?: "<version>" } (written by install-temoto.sh)
 *                                       `hold` is the ceiling "do not install this version or below" set when `--version` rolled back to an older version (code-review)
 *                                       `releaseRepo` was renamed from `repo` in TODO 1185. The old key `repo` holds the default from before the switch,
 *                                       so it is not read (reading it would keep looking at the old location even after the default changed)
 *
 * The swap is only renames (`swapApp` in `stage.ts`): the current real copy is set aside to `versions/<current version>/` and the new version is renamed into the real copy's place.
 * Rolling back is the same. The shape from stage 1 of 103 (`~/Applications/Temoto.app` is a symlink to `versions/<version>/Temoto.app`) is also accepted, and
 * is replaced by the real copy at the first swap (either works).
 * TODO 1254 renamed the .app from `aios.app` to `Temoto.app` (`APP_BUNDLE_NAME`). TODO 1263: the install root follows the machine's data name
 * (`~/.local/share/Temoto` on a new machine, `~/.local/share/aios` where the legacy userData exists; `src/common/app-identity.ts`).
 *
 * Auto-update runs only when this check returns `versioned`. **It does not run in a development shell (`npm run app` / dogfood `aios-stable`,
 * where `Contents/Resources/app` is a symlink to the repo), under `npm run dev`, or in a `--user-data-dir` duplicate** (owner decision).
 * Does not depend on electron (the caller passes the inputs from `app`). The fs is replaced in tests.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { APP_BUNDLE_NAME, bundleExecutablePath, bundleInfoPlistPath, bundleOfExecutable, updateHostSupported } from '../../common/os/app-bundle.js'
export { APP_BUNDLE_NAME, bundleOfExecutable }
import { normalizeVersion, PLAIN_VERSION_RE, type UpdateUnsupportedReason } from '@shared/update.js'
import { PRODUCT_NAME, PUBLIC_RELEASE_REPO, RELEASE_BUNDLE_ID } from '@shared/product.js'
import { defaultInstallRootFor } from '../../common/app-identity.js'

/**
 * Root of the default install location (same as the default of `AIOS_INSTALL_ROOT` in install-temoto.sh).
 * TODO 1263: `~/.local/share/<name>`, where the name is this machine's data name (`appIdentity()`; `aios` on a machine that already had the legacy userData).
 */
export function defaultInstallRoot(home: string = homedir(), dataName?: string): string {
  return defaultInstallRootFor(home, dataName)
}

/** Name of the place where the per-version directories sit (`<root>/versions`). */
export const VERSIONS_DIR_NAME = 'versions'
/** What install-temoto.sh writes: the symlink's location and a note of the Release repo. */
export const INSTALL_MANIFEST_NAME = 'install.json'
/**
 * One line holding the absolute path of the relocated root (`AIOS_INSTALL_ROOT`), placed in the default root (written by install-temoto.sh). An aios in the real-copy form
 * cannot trace the root from its own location, so it looks it up here (review 57-10). Absent for the default root.
 */
export const INSTALL_ROOT_POINTER_NAME = 'install-root'
/**
 * aios's staging area for a fetch in progress (`<versions>/.app-staging-XXXXXX`). Before the next fetch, only sufficiently old ones are deleted.
 * **A different prefix from install-temoto.sh's `.staging-`** (code-review): if they were the same, the extraction of a running script could be deleted.
 */
export const STAGING_PREFIX = '.app-staging-'
/** How old (mtime) a staging area must be to count as "left over from a previous attempt". So that a fetch in progress is not deleted. */
export const STALE_STAGING_MS = 60 * 60_000
/** The signing identifier of the distributed build (TODO 1263: `RELEASE_BUNDLE_ID` in `scripts/app-shell.mjs`; a test compares them). The development shell's `local.aios` never auto-updates. */
export const BUNDLE_ID: string = RELEASE_BUNDLE_ID
/**
 * Default Release repo (`RELEASE_REPO` in `scripts/release-config.mjs`; a test compares them).
 * TODO 1254: the public repo `temoto-app/temoto` (`src/shared/product.json`).
 */
export const DEFAULT_RELEASE_REPO = PUBLIC_RELEASE_REPO
/** The key of the Release repo in install.json (written by install-temoto.sh; a test compares them). */
export const INSTALL_MANIFEST_REPO_KEY = 'releaseRepo'

/** Name of the Release zip (same as `zipName` in `scripts/release-config.mjs`; a test compares them). */
export function releaseZipName(version: string): string {
  return `${PRODUCT_NAME}-${version}-arm64-mac.zip`
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isVersionDirName(name: string): boolean {
  // The shape accepted as a version directory name (`0.28.0`).
  return PLAIN_VERSION_RE.test(name)
}

export interface InstallLayout {
  /** Root of the install location (realpath). */
  readonly root: string
  readonly versionsDir: string
  /** `~/Applications/Temoto.app` (the real .app; a symlink in the 103 form. `link` in install.json). */
  readonly link: string
  /** The Release repo (`owner/name`). */
  readonly repo: string
  /** The version currently running (the name of the version directory). */
  readonly runningVersion: string
}

export type InstallDetection =
  | { readonly kind: 'versioned'; readonly layout: InstallLayout }
  | { readonly kind: 'unsupported'; readonly reason: UpdateUnsupportedReason }

export interface DetectInput {
  readonly platform: string
  readonly arch: string
  /** `app.isPackaged` (false for the default app of `electron .`). */
  readonly isPackaged: boolean
  /** `ELECTRON_RENDERER_URL` is set (`npm run dev`). */
  readonly devServer: boolean
  /** Whether userData is the default (false means a `--user-data-dir` duplicate). */
  readonly defaultUserData: boolean
  /**
   * The home used to look up the root in the real-copy form (default `os.homedir()`; for tests). The root cannot be traced from the real copy, so the default location is checked,
   * and for a location relocated with `AIOS_INSTALL_ROOT`, the `install-root` there (INSTALL_ROOT_POINTER_NAME) points to it.
   */
  readonly home?: string
  /** `process.execPath` (`…/Temoto.app/Contents/MacOS/Temoto`). */
  readonly execPath: string
  /** `app.getAppPath()` (`…/Temoto.app/Contents/Resources/app`). */
  readonly appPath: string
}

/** The fs entry point used for the check (replaced in tests). Returns null whenever anything fails. */
export interface LayoutFs {
  realpath(path: string): string | null
  isSymlink(path: string): boolean | null
  readText(path: string): string | null
}

export const nodeLayoutFs: LayoutFs = {
  realpath(path) {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  },
  isSymlink(path) {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return null
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
}

export interface InstallManifest {
  readonly link: string
  readonly repo: string
  /** Do not install this version or below via auto-update (rolled back with `--version` in install-temoto.sh). If absent, the field is absent too. */
  readonly hold?: string
}

/** Read install.json. Null if broken. `hold` is ignored (nothing is held) if it is not shaped like a version. */
export function parseInstallManifest(text: string | null): InstallManifest | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const link = record['link']
  // The old key `repo` is not read (see the note above. TODO 1185)
  const repo = record[INSTALL_MANIFEST_REPO_KEY] ?? DEFAULT_RELEASE_REPO
  if (typeof link !== 'string' || !isAbsolute(link) || !link.endsWith('.app')) return null
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return null
  const rawHold = record['hold']
  const hold = typeof rawHold === 'string' ? versionDirName(rawHold) : null
  return hold === null ? { link, repo } : { link, repo, hold }
}

/** The current `hold` in install.json (re-read on every check — install-temoto.sh may rewrite it). Null if absent. */
export function heldVersion(layout: InstallLayout, fs: LayoutFs = nodeLayoutFs): string | null {
  return parseInstallManifest(fs.readText(join(layout.root, INSTALL_MANIFEST_NAME)))?.hold ?? null
}

/**
 * Extract the version from the real path of `<versions>/<version>/Temoto.app`. Null if it is not shaped like a version directory.
 */
export function versionOfBundle(bundle: string, versionsDir: string): string | null {
  if (basename(bundle) !== APP_BUNDLE_NAME) return null
  const versionDir = dirname(bundle)
  if (dirname(versionDir) !== versionsDir) return null
  const name = basename(versionDir)
  return isVersionDirName(name) ? name : null
}

/** Extract `CFBundleShortVersionString` from `Info.plist` (XML). Null if unreadable or not shaped like a version. */
export function plistVersion(text: string | null): string | null {
  if (text === null) return null
  const raw = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
  return raw === undefined ? null : versionDirName(raw.trim())
}

/** The version of the .app at `link` (the target's version if it is a symlink). */
export function bundleVersion(bundle: string, fs: LayoutFs = nodeLayoutFs): string | null {
  return plistVersion(fs.readText(bundleInfoPlistPath(bundle)))
}

/** Whether `link` is a real .app (present, not a symlink). In the real-copy form, the swap waits until quit (the running version's .app is never moved). */
export function linkIsBundle(layout: InstallLayout, fs: LayoutFs = nodeLayoutFs): boolean {
  return fs.isSymlink(layout.link) === false
}

/** Root of the real-copy form (1050): the default root, or the absolute path the `install-root` there points to. Shared by `detectInstall` and the registration (`register.ts`). */
export function resolveInstallRoot(home: string | undefined, fs: LayoutFs = nodeLayoutFs): string {
  const defaultRoot = defaultInstallRoot(home)
  const pointed = fs.readText(join(defaultRoot, INSTALL_ROOT_POINTER_NAME))?.trim() ?? ''
  return pointed !== '' && isAbsolute(pointed) ? pointed : defaultRoot
}

/** Whether the running aios is on top of the per-version directories (the 103 form) or on the real copy in `~/Applications` (the 1050 form). */
export function detectInstall(input: DetectInput, fs: LayoutFs = nodeLayoutFs): InstallDetection {
  const unsupported = (reason: UpdateUnsupportedReason): InstallDetection => ({ kind: 'unsupported', reason })
  if (!updateHostSupported(input.platform, input.arch)) return unsupported('platform')
  // Only `npm run dev` (the electron-vite dev server) counts as the reason "under development". A built app launched directly
  // with `electron .` has no dev server, so it is aligned with the reason "not installed as a distributed version" (`not-installed`)
  // (TODO 623; before, both said "because of npm run dev").
  if (input.devServer) return unsupported('dev')
  if (!input.isPackaged) return unsupported('not-installed')
  // A development shell has Resources/app as a symlink to the repo (scripts/make-app.mjs). install-temoto.sh stops on the same marker.
  if (fs.isSymlink(input.appPath) !== false) return unsupported('dev-shell')
  if (!input.defaultUserData) return unsupported('instance')

  const bundle = bundleOfExecutable(input.execPath)
  const realBundle = bundle === null ? null : fs.realpath(bundle)
  if (realBundle === null) return unsupported('not-installed')
  const versionsDir = dirname(dirname(realBundle))
  // TODO 1050: the real-copy form. Running from `~/Applications/Temoto.app` itself (the root is the default location).
  if (basename(versionsDir) !== VERSIONS_DIR_NAME) {
    const root = resolveInstallRoot(input.home, fs)
    const manifest = parseInstallManifest(fs.readText(join(root, INSTALL_MANIFEST_NAME)))
    if (manifest === null || fs.isSymlink(manifest.link) !== false) return unsupported('not-installed')
    if (fs.realpath(manifest.link) !== realBundle) return unsupported('not-installed')
    const runningVersion = bundleVersion(manifest.link, fs)
    if (runningVersion === null) return unsupported('not-installed')
    return {
      kind: 'versioned',
      layout: { root, versionsDir: join(root, VERSIONS_DIR_NAME), link: manifest.link, repo: manifest.repo, runningVersion }
    }
  }
  const runningVersion = versionOfBundle(realBundle, versionsDir)
  if (runningVersion === null) return unsupported('not-installed')
  const root = dirname(versionsDir)

  const manifest = parseInstallManifest(fs.readText(join(root, INSTALL_MANIFEST_NAME)))
  if (manifest === null) return unsupported('not-installed')
  // ~/Applications/Temoto.app must be a symlink pointing at one of the per-version directories.
  if (fs.isSymlink(manifest.link) !== true) return unsupported('not-installed')
  const target = fs.realpath(manifest.link)
  if (target === null || versionOfBundle(target, versionsDir) === null) return unsupported('not-installed')

  return {
    kind: 'versioned',
    layout: { root, versionsDir, link: manifest.link, repo: manifest.repo, runningVersion }
  }
}

/** The version `link` currently points at (symlink form) / the version of the real copy (real-copy form). Null if unreadable or outside the version directories. */
export function linkedVersion(layout: InstallLayout, fs: LayoutFs = nodeLayoutFs): string | null {
  if (linkIsBundle(layout, fs)) return bundleVersion(layout.link, fs)
  const target = fs.realpath(layout.link)
  return target === null ? null : versionOfBundle(target, layout.versionsDir)
}

export function bundlePathOf(layout: InstallLayout, version: string): string {
  return join(layout.versionsDir, version, APP_BUNDLE_NAME)
}

/** The executable to launch after the swap (`execPath` of `app.relaunch`). After the swap `link` is the real copy in every form, so it comes from `link`. */
export function executableOf(layout: InstallLayout): string {
  return bundleExecutablePath(layout.link)
}

/** The version directory name in canonical form (`v0.28.0` -> `0.28.0`). */
export function versionDirName(version: string): string | null {
  const normalized = normalizeVersion(version)
  return normalized !== null && isVersionDirName(normalized) ? normalized : null
}
