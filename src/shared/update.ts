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
  /** TODO 1333: when `staged` was installed (ms). Persisted, so a restart of the app does not start counting again. null if nothing is installed. */
  readonly stagedAt: number | null
  /**
   * TODO 1333: why the installed version is not taking over by itself yet (auto-update ON and `staged` set). A reason code of `update-wait-*`; null if
   * nothing is blocking (or auto-update is OFF, or nothing is installed). Refreshed every tick of the decision loop (once a minute).
   */
  readonly waiting: ReasonCode | null
}

/**
 * TODO 1333: the Composer text carried over an idle restart of the app (ARCHITECTURE 8.5). Collected from the windows right before the restart, kept in the encrypted
 * DB (`update.carriedDrafts`) and handed back to the windows of the next launch, then deleted. **Only the Composer text** (owner decision 2026-11-26): the viewer's
 * unsaved drafts are not carried and still hold the idle restart.
 */
export interface CarriedDrafts {
  /** Composer text per thread id (only non-blank text). */
  readonly composer: Readonly<Record<string, string>>
}

/** What a window answers to "collect your drafts": the drafts, or that it holds something that cannot be carried (`carriable: false`). */
export type CarriedDraftsReply =
  | { readonly carriable: true; readonly drafts: CarriedDrafts }
  | { readonly carriable: false }

/** The request main sends to every window. `id` ties the replies to one attempt. */
export interface CarriedDraftsRequest {
  readonly id: string
}

/** Upper limits on what is carried (bytes of UTF-8 text). Over them, the drafts stay where they are and keep blocking the idle restart. */
export const CARRIED_DRAFTS_MAX_BYTES = 1_000_000
export const CARRIED_DRAFTS_MAX_ENTRIES = 200

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

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * TODO 1333: narrow a value that crossed the process boundary (a window's reply, or the stored JSON) to `CarriedDrafts`. Looks at types and sizes only:
 * keys must be non-empty strings of a sane length, texts strings, mtimes finite numbers. null for anything else or over the limits.
 */
export function parseCarriedDrafts(value: unknown): CarriedDrafts | null {
  if (typeof value !== 'object' || value === null) return null
  const composerRaw = (value as Record<string, unknown>)['composer']
  // A stored value from an earlier build may still carry a `viewer` table: it is ignored, not an error.
  if (typeof composerRaw !== 'object' || composerRaw === null || Array.isArray(composerRaw)) return null
  const composer: Record<string, string> = {}
  let bytes = 0
  let entries = 0
  for (const [id, text] of Object.entries(composerRaw)) {
    if (id === '' || id.length > 200 || typeof text !== 'string' || text.trim() === '') return null
    bytes += utf8Bytes(text)
    entries += 1
    composer[id] = text
  }
  if (entries > CARRIED_DRAFTS_MAX_ENTRIES || bytes > CARRIED_DRAFTS_MAX_BYTES) return null
  return { composer }
}

/** Whether there is nothing to carry. */
export function carriedDraftsEmpty(drafts: CarriedDrafts): boolean {
  return Object.keys(drafts.composer).length === 0
}

/** Merge several windows' drafts into one (an earlier window wins when two hold the same thread). */
export function mergeCarriedDrafts(list: readonly CarriedDrafts[]): CarriedDrafts {
  const composer: Record<string, string> = {}
  for (const drafts of list) {
    for (const [id, text] of Object.entries(drafts.composer)) if (!(id in composer)) composer[id] = text
  }
  return { composer }
}
