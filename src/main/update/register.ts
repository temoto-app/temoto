/**
 * TODO 1245 (wave 89): make an aios installed from the DMG into `/Applications/Temoto.app` a target of auto-update without asking (ARCHITECTURE 8.5).
 *
 * If a distributed version (not a development shell, dev, or duplicate) is running from `/Applications/Temoto.app` and there is no `install.json`,
 * write `install.json` on the spot (`link` = `/Applications/Temoto.app`, `releaseRepo` is the default). From then on `detectInstall` picks it up
 * as the "real-copy form" of 1050, and the swap stays the existing mechanism (rename at the `link` location on quit).
 *
 * - It does not register outside `/Applications` (run directly from Downloads, or the DMG mount point `/Volumes/…`).
 * - If `install.json` already exists (even if it points at a different `link` or is broken) it is left alone — the way `install-temoto.sh` installed takes priority.
 *   **The one exception (TODO 1263):** a manifest whose `link` is an .app of the name before the rename (`aios.app`, written by install-aios.sh of
 *   0.80–0.91) is replaced. On a machine that keeps the legacy data name, the install root is still `~/.local/share/aios`, so that old manifest would
 *   otherwise keep a DMG reinstall of Temoto out of auto-update for good. Its `hold` is about the old versions and is dropped.
 * - If `/Applications` cannot be written (permissions, or installed by another user), it writes nothing and just returns the reason (`applications-readonly`).
 *   Writability is checked by actually creating a temporary file (permission bits are not guessed. The swap is a rename in the same place, so what must be writable is the parent dir).
 */
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { APPLICATIONS_DIR } from '../../common/os/macos-paths.js'
import type { UpdateUnsupportedReason } from '@shared/update.js'
import { LEGACY_DATA_NAME } from '@shared/product.js'
import {
  APP_BUNDLE_NAME,
  DEFAULT_RELEASE_REPO,
  INSTALL_MANIFEST_NAME,
  INSTALL_MANIFEST_REPO_KEY,
  bundleOfExecutable,
  parseInstallManifest,
  resolveInstallRoot,
  detectInstall,
  nodeLayoutFs,
  type DetectInput,
  type InstallDetection,
  type LayoutFs
} from './layout.js'

/** The write entry point used for registration (replaced in tests). Throws whenever anything fails. */
export interface RegisterFs {
  /** Create a temporary file in `dir` and delete it. Throws if it cannot be created. */
  probeWritable(dir: string): void
  mkdirp(dir: string): void
  /** Write via a temporary file + rename. */
  writeAtomic(path: string, text: string): void
}

export const nodeRegisterFs: RegisterFs = {
  probeWritable(dir) {
    const probe = join(dir, `.aios-write-test-${process.pid}-${Date.now()}`)
    // 'wx': fails if it already exists (never delete someone else's file)
    closeSync(openSync(probe, 'wx'))
    unlinkSync(probe)
  },
  mkdirp(dir) {
    mkdirSync(dir, { recursive: true })
  },
  writeAtomic(path, text) {
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, text, { flag: 'w' })
    renameSync(tmp, path)
  }
}

export type RegisterOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'registered'; readonly root: string }
  | { readonly kind: 'unwritable'; readonly reason: UpdateUnsupportedReason; readonly detail: string }

export interface RegisterOptions {
  readonly applicationsDir?: string
  readonly fs?: LayoutFs
  readonly writer?: RegisterFs
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The .app name an install made before the rename points at (`aios.app`). */
export const PRE_RENAME_APP_BUNDLE_NAME = `${LEGACY_DATA_NAME}.app`

/**
 * TODO 1263: whether `install.json` was written for the .app of the name before the rename (`link` ends in `/aios.app`). A broken manifest is not
 * (it is left alone as before). Only reached when the running build is `/Applications/Temoto.app` and `detectInstall` did not accept the manifest.
 */
export function isPreRenameManifest(text: string): boolean {
  const manifest = parseInstallManifest(text)
  return manifest !== null && basename(manifest.link) === PRE_RENAME_APP_BUNDLE_NAME && PRE_RENAME_APP_BUNDLE_NAME !== APP_BUNDLE_NAME
}

/**
 * Check the registration conditions and, if they hold, write `install.json`. Returns `registered` after registering (the caller redoes `detectInstall`).
 * Outside the conditions it returns `skipped` and does nothing. If it cannot write (cannot create a temporary file, or the write fails), `unwritable`.
 */
export function registerApplicationsInstall(input: DetectInput, options: RegisterOptions = {}): RegisterOutcome {
  const fs = options.fs ?? nodeLayoutFs
  const writer = options.writer ?? nodeRegisterFs
  const applicationsDir = options.applicationsDir ?? APPLICATIONS_DIR
  const skipped: RegisterOutcome = { kind: 'skipped' }
  // Things that are not a distributed version (dev, shell, duplicate) are skipped under the same condition detectInstall rejects first
  if (input.devServer || !input.isPackaged || !input.defaultUserData) return skipped
  if (fs.isSymlink(input.appPath) !== false) return skipped
  const bundle = bundleOfExecutable(input.execPath)
  const realBundle = bundle === null ? null : fs.realpath(bundle)
  // Only `/Applications/Temoto.app` itself. Downloads, `/Volumes/…` (DMG mount point), and an .app with a different name are out of scope
  const link = join(applicationsDir, APP_BUNDLE_NAME)
  if (realBundle === null || realBundle !== (fs.realpath(link) ?? link)) return skipped
  // If link is a symlink (to somewhere else) it is not the real-copy form
  if (fs.isSymlink(link) !== false) return skipped
  // The link's real copy must be directly under applicationsDir (rejects a symlink whose realpath leaves Applications)
  if (realBundle !== join(fs.realpath(applicationsDir) ?? applicationsDir, APP_BUNDLE_NAME)) return skipped

  const root = resolveInstallRoot(input.home, fs)
  const manifestPath = join(root, INSTALL_MANIFEST_NAME)
  // If one already exists (a different link, or a broken one included) leave it alone. TODO 1263: except a manifest of the name before the rename
  const existing = fs.readText(manifestPath)
  if (existing !== null && !isPreRenameManifest(existing)) return skipped

  try {
    writer.probeWritable(applicationsDir)
    writer.mkdirp(root)
    writer.writeAtomic(manifestPath, `${JSON.stringify({ link, [INSTALL_MANIFEST_REPO_KEY]: DEFAULT_RELEASE_REPO })}\n`)
  } catch (error) {
    return { kind: 'unwritable', reason: 'applications-readonly', detail: message(error) }
  }
  return { kind: 'registered', root }
}

/** `detectInstall` with the `/Applications` registration inserted. The reason it could not register is returned as `unsupported`. */
export function detectInstallWithRegistration(input: DetectInput, options: RegisterOptions = {}): InstallDetection {
  const fs = options.fs ?? nodeLayoutFs
  const first = detectInstall(input, fs)
  if (first.kind === 'versioned' || first.reason !== 'not-installed') return first
  const outcome = registerApplicationsInstall(input, options)
  if (outcome.kind === 'registered') return detectInstall(input, fs)
  if (outcome.kind === 'unwritable') return { kind: 'unsupported', reason: outcome.reason }
  return first
}
