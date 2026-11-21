/**
 * Auto-update (TODO 103 stage 1, wave 28 bundle G, ARCHITECTURE.md 8.5): the main -> renderer shapes and how versions are compared.
 *
 * Only the distributed build installed by `install-temoto.sh` is updated (`<root>/versions/<version>/aios.app` and the
 * symlink `~/Applications/aios.app` pointing at it). It does not run in the development shell (`npm run app` / the dogfood `aios-stable`), `npm run dev`,
 * or a `--user-data-dir` duplicate (the reason goes into `unsupported`).
 *
 * It holds no wording (main does not know the language, 7.4.4). A failure is a reason code (`update-*` in `reason.ts`), and
 * for why it does not run, the renderer's dictionary (`update.unsupported.<reason>`) turns `UpdateUnsupportedReason` into text.
 */
import type { ReasonCode } from './reason.js'

/** Why auto-update does not run. */
export const UPDATE_UNSUPPORTED_REASONS = [
  /** `npm run dev` / `electron .` (Electron's default app, the dev server) */
  'dev',
  /** The development shell (`Contents/Resources/app` is a symlink to the repo, `npm run app` / dogfood) */
  'dev-shell',
  /** A `--user-data-dir` duplicate (`npm run dev:instance` / proxy verification) */
  'instance',
  /** Outside the per-version directory of `install-temoto.sh` (installed with an old install-temoto.sh, or the zip was placed by hand) */
  'not-installed',
  /** Running from `/Applications/aios.app` but it cannot be written there (permissions, or another user installed it), so auto-update cannot be registered (TODO 1245) */
  'applications-readonly',
  /** Anything other than macOS / Apple Silicon */
  'platform'
] as const

export type UpdateUnsupportedReason = (typeof UPDATE_UNSUPPORTED_REASONS)[number]

/** The current stage. */
export type UpdatePhase =
  /** Doing nothing (not checked yet / auto-update is OFF) */
  | 'idle'
  /** Asking for the latest version */
  | 'checking'
  /** Fetching and verifying the new version */
  | 'downloading'
  /** Using the latest */
  | 'up-to-date'
  /** A new version exists (not fetched because auto-update is OFF) */
  | 'available'
  /** A new version exists but it is not installed because it is `held` or below (reverted with `--version` of install-temoto.sh; code-review) */
  | 'held'
  /** A new version was installed. It takes over on the next quit (or an idle restart) */
  | 'staged'
  /** The last check / fetch failed (the reason is in `failure`) */
  | 'failed'

export interface UpdateStatus {
  /** Whether it can run. If false, the reason is in `unsupportedReason` (other fields are meaningful only for the version). */
  readonly supported: boolean
  readonly unsupportedReason: UpdateUnsupportedReason | null
  /** Auto-update (`update.auto`, default ON). */
  readonly auto: boolean
  /** The running version (the `package.json` version, same as the badge of 316 and About). */
  readonly current: string
  /** The latest version checked last. null if not checked yet. */
  readonly latest: string | null
  /** The version that finished installing and will be used on the next launch. null if none. */
  readonly staged: string | null
  readonly phase: UpdatePhase
  /** Time of the last check (ms). */
  readonly checkedAt: number | null
  /** The reason for `phase === 'failed'`. */
  readonly failure: ReasonCode | null
  /**
   * Hold (reverted to an older version with `--version` of install-temoto.sh): versions up to and including this are not installed. Resumes once a newer
   * Release than this appears. null if not held. `hold` in `install.json`.
   */
  readonly held: string | null
  /** On the first launch after an update, the previous and current versions (an "updated to version X" notice, until it is pressed or closed). */
  readonly justUpdated: { readonly from: string; readonly to: string } | null
  /**
   * TODO 1090: on the first launch after switching to the installed version (`staged`), whether a macOS keychain prompt may appear
   * (the signer changes, unreadable, ad-hoc). Only when true, an explanation is added to the display before the restart. false if there is no `staged`.
   */
  readonly keychainPromptExpected: boolean
}

/**
 * Matches only the canonical version `x.y.z` without `v` (1 to 6 digits per part). Used to check stored versions (`agent.update.*`, `plugins.updated`) and
 * the directory names of the extension storage (wave 73 review). `v0.28.0` does not match; to accept it, use `normalizeVersion`.
 */
export const PLAIN_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

/** `0.28.0` / `v0.28.0` -> [0, 28, 0]. null unless there are three numbers (pre-release markers and the like are not handled). */
export function parseVersion(text: string): readonly [number, number, number] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(text.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Ordering of a and b (-1 / 0 / 1). null if either cannot be read. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) return null
  for (let i = 0; i < 3; i += 1) {
    const left = x[i] ?? 0
    const right = y[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Whether `candidate` is newer than `current`. false if unreadable (neither a downgrade nor a reinstall of the same version is done). */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}

/** Put a version string into the canonical form without `v` (`v0.28.0` -> `0.28.0`). null if unreadable. */
export function normalizeVersion(text: string): string | null {
  const parsed = parseVersion(text)
  return parsed === null ? null : parsed.join('.')
}
