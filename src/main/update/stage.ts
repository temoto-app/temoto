/**
 * Place a new version in a per-version directory, swap it into `~/Applications/Temoto.app`, and tidy old versions (TODO 103 stage 1, ARCHITECTURE.md 8.5).
 *
 * The steps are the same as 4 to 7 of `scripts/install-aios.sh` (fetch -> SHA-256 -> `ditto -x -k` -> signature and identifier -> place -> re-point).
 * **A failure partway breaks nothing**:
 * - Fetching and verifying happen only inside `<versions>/.app-staging-XXXXXX`. After verification it is moved out to `<versions>/<version>` with
 *   a single rename (the half-done version directory is never visible). On failure the whole staging area is deleted.
 * - The swap (`swapApp`) is only renames: the current `~/Applications/Temoto.app` is set aside to `versions/<current version>`, and the verified version is
 *   renamed into its place (TODO 1050. In the 103 symlink form the symlink is removed and the real copy is placed).
 * - The running version's .app is neither moved nor deleted (Helper and plugin-host are launched later from the running .app).
 *   The swap happens only at quit (while it is not running).
 *
 * Does not depend on electron. The child processes (`ditto` / `codesign` / `plutil` / `xattr`) are replaced through `CommandRunner`.
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { OS_TOOLS } from '../../common/os/tools.js'
import { reasonError } from '@shared/reason.js'
import { compareVersions } from '@shared/update.js'
import {
  APP_BUNDLE_NAME,
  BUNDLE_ID,
  STAGING_PREFIX,
  STALE_STAGING_MS,
  bundlePathOf,
  bundleVersion,
  isVersionDirName,
  releaseZipName,
  type InstallLayout
} from './layout.js'
import type { CommandRunner, ReleaseSource } from './release-source.js'

/** Look up the value for `name` in `SHA256SUMS` (lines of a hex digest, two spaces, then a file name). Null if absent. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim())
    if (match !== null && match[2] === name) return (match[1] ?? '').toLowerCase()
  }
  return null
}

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * The Developer ID Team IDs accepted as the signer of a distributed version (TODO 951, the owner's Apple Developer Program).
 * A version signed with Developer ID by `scripts/release.mjs` has this Team ID.
 */
export const DEVELOPER_ID_TEAMS: readonly string[] = ['LVG3JZJZ3U']
/**
 * The name of the accepted self-signed certificate (`DEFAULT_SIGN_NAME` in `scripts/app-shell.mjs`). Versions before Developer ID (up to 0.58), and
 * versions built on machines without a Developer ID certificate. Kept also so that rolling back from a notarized version works (the downgrade safety net, install-aios.sh `--version`).
 */
export const SELF_SIGNED_NAME = 'aios dev'

/** The signer read from the output of `codesign -dvv`. */
export type BundleSigner =
  | { readonly kind: 'developer-id'; readonly teamId: string }
  | { readonly kind: 'self-signed'; readonly name: string }
  | { readonly kind: 'adhoc' }
  | { readonly kind: 'other'; readonly authority: string | null; readonly teamId: string | null }

/**
 * Read `codesign -dvv` (stderr) and classify the signer. The name string alone does not decide — for Developer ID, `verifyBundle` goes on to check
 * Apple's CA chain with `developerIdRequirement`. It reads the same shape as `parseCodesignDetail` in `scripts/release-config.mjs`
 * (test/update.test.ts passes the same output to both).
 */
export function signerOf(detail: string): BundleSigner {
  const authorities = [...detail.matchAll(/^Authority=(.*)$/gm)].map((m) => (m[1] ?? '').trim())
  const team = /^TeamIdentifier=(.*)$/m.exec(detail)?.[1]?.trim() ?? null
  const teamId = team === null || team === 'not set' ? null : team
  const leaf = authorities[0] ?? null
  if (teamId !== null && leaf !== null && leaf.startsWith('Developer ID Application:')) return { kind: 'developer-id', teamId }
  if (teamId === null && leaf !== null && authorities.length === 1) return { kind: 'self-signed', name: leaf }
  if (/^Signature=adhoc$/m.test(detail)) return { kind: 'adhoc' }
  return { kind: 'other', authority: leaf, teamId }
}

/** Whether it is an accepted signer: Developer ID (`DEVELOPER_ID_TEAMS`) or the self-signed `aios dev`. Ad-hoc and other signers are not accepted. */
export function isAcceptedSigner(signer: BundleSigner): boolean {
  if (signer.kind === 'developer-id') return DEVELOPER_ID_TEAMS.includes(signer.teamId)
  if (signer.kind === 'self-signed') return signer.name === SELF_SIGNED_NAME
  return false
}

/**
 * The requirement that only a signature with Team ID `team` under a Developer ID Application certificate satisfies (`codesign --verify -R`).
 * The same statement as `developerIdRequirement` in `scripts/release-config.mjs` (a test compares them).
 */
export function developerIdRequirement(team: string): string {
  return (
    '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
    ` and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`
  )
}

/**
 * Whether `bundle` is the distributed version `version` (contents, signature, identifier, signer, and the version in Info.plist). If not, an exception with reason code `update-invalid-app` (only the signer case is `update-untrusted-signer`).
 * The same check is applied when reusing an already placed version directory. The signer (TODO 951) is Developer ID (Team ID verified against Apple's
 * CA chain) or the self-signed `aios dev`.
 */
export async function verifyBundle(bundle: string, version: string, run: CommandRunner): Promise<void> {
  if (!existsSync(join(bundle, 'Contents', 'Info.plist'))) throw reasonError('update-invalid-app')
  const verify = await run(OS_TOOLS.codesign, ['--verify', '--deep', '--strict', bundle], { timeoutMs: 120_000 })
  if (verify.code !== 0) throw reasonError('update-invalid-app')
  // codesign -d writes its result to stderr. The Authority lines come out with --verbose=2.
  const detail = await run(OS_TOOLS.codesign, ['-dv', '--verbose=2', bundle], { timeoutMs: 30_000 })
  const text = `${detail.stdout}\n${detail.stderr}`
  const identifier = /^Identifier=(.*)$/m.exec(text)?.[1]
  if (identifier !== BUNDLE_ID) throw reasonError('update-invalid-app')
  const signer = signerOf(text)
  if (!isAcceptedSigner(signer)) throw reasonError('update-untrusted-signer')
  if (signer.kind === 'developer-id') {
    const requirement = await run(OS_TOOLS.codesign, ['--verify', '--strict', '-R', developerIdRequirement(signer.teamId), bundle], {
      timeoutMs: 120_000
    })
    if (requirement.code !== 0) throw reasonError('update-untrusted-signer')
  }
  const plist = await run(
    OS_TOOLS.plutil,
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')],
    { timeoutMs: 10_000 }
  )
  if (plist.code !== 0 || plist.stdout.trim() !== version) throw reasonError('update-invalid-app')
}

/**
 * Delete aios's staging areas (`.app-staging-*`) older than `STALE_STAGING_MS`. These are what a previous fetch left when it
 * died partway. install-aios.sh's `.staging-*` and ones in progress (new) are not touched (code-review).
 */
export function removeStaleStaging(versionsDir: string, now: number = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(versionsDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const path = join(versionsDir, name)
    let mtimeMs: number
    try {
      mtimeMs = lstatSync(path).mtimeMs
    } catch {
      continue
    }
    if (now - mtimeMs < STALE_STAGING_MS) continue
    rmSync(path, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export interface StageResult {
  readonly bundle: string
  /** An existing version directory was verified and reused (nothing was fetched). */
  readonly reused: boolean
}

/**
 * Place the Release tag `tag` (version `version`) at `<versions>/<version>/Temoto.app`. The symlink is not re-pointed (`swapLink`).
 * If a version directory that can be verified already exists, it is used without fetching.
 */
export async function stageRelease(
  layout: InstallLayout,
  tag: string,
  version: string,
  source: ReleaseSource,
  run: CommandRunner
): Promise<StageResult> {
  if (!isVersionDirName(version)) throw reasonError('update-invalid-app')
  const target = bundlePathOf(layout, version)
  if (existsSync(target)) {
    try {
      await verifyBundle(target, version, run)
      return { bundle: target, reused: true }
    } catch {
      // Broken (left over from a previous version, or touched by hand). Fetch again below and replace it.
    }
  }

  mkdirSync(layout.versionsDir, { recursive: true })
  removeStaleStaging(layout.versionsDir)
  const staging = mkdtempSync(join(layout.versionsDir, STAGING_PREFIX))
  try {
    const zip = releaseZipName(version)
    await source.download(tag, [zip, 'SHA256SUMS'], staging)
    const zipPath = join(staging, zip)
    const sumsPath = join(staging, 'SHA256SUMS')
    if (!existsSync(zipPath) || !existsSync(sumsPath)) throw reasonError('update-download-failed')
    const expected = checksumFor(readFileSync(sumsPath, 'utf8'), zip)
    if (expected === null || (await sha256OfFile(zipPath)) !== expected) throw reasonError('update-checksum-mismatch')

    // The zip is extracted with ditto (an Electron .app has symlinks inside Framework. Same as install-aios.sh).
    const extracted = join(staging, 'x')
    mkdirSync(extracted)
    const ditto = await run(OS_TOOLS.ditto, ['-x', '-k', zipPath, extracted], { timeoutMs: 10 * 60_000 })
    if (ditto.code !== 0) throw reasonError('update-invalid-app')
    const app = join(extracted, APP_BUNDLE_NAME)
    await verifyBundle(app, version, run)
    // gh does not set the quarantine mark, but if one is present it is removed (so no Gatekeeper prompt appears. Same as install-aios.sh).
    await run(OS_TOOLS.xattr, ['-dr', 'com.apple.quarantine', app], { timeoutMs: 60_000 }).catch(() => undefined)

    // Verification is done. Build `<staging>/out/Temoto.app`, then move it to the version directory with a single rename.
    const out = join(staging, 'out')
    mkdirSync(out)
    renameSync(app, join(out, APP_BUNDLE_NAME))
    const versionDir = join(layout.versionsDir, version)
    if (existsSync(versionDir)) renameSync(versionDir, join(staging, 'replaced'))
    try {
      renameSync(out, versionDir)
    } catch {
      throw reasonError('update-install-failed')
    }
    return { bundle: target, reused: false }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Swap `~/Applications/Temoto.app` (`layout.link`) to the version at `<versions>/<version>/Temoto.app` (TODO 1050).
 * **Renames only** (same volume; otherwise `update-install-failed`):
 * - `link` is a real .app: set the current real copy aside to `<versions>/<current version>/Temoto.app` (so it can be restored) and rename the new version to `link`.
 *   If the second rename fails, undo the first. **Never call it while running** (the caller waits until quit — Helper and
 *   plugin-host are launched later from the running .app).
 * - `link` is a symlink in the 103 form: remove it and place the new version's real copy (one step to the real-copy form). On failure restore the symlink.
 * - `link` is missing (a previous swap died between its two renames): just place the new version.
 * If `link` is something whose version cannot be read (something else the user put there), refuse without moving anything. The empty `<versions>/<version>` left after placing is deleted.
 */
export function swapApp(layout: InstallLayout, version: string): void {
  const { link, versionsDir } = layout
  const incoming = bundlePathOf(layout, version)
  const fail = (): never => {
    throw reasonError('update-install-failed')
  }
  try {
    if (!statSync(incoming).isDirectory()) fail()
  } catch {
    return fail()
  }
  let kind: 'symlink' | 'bundle' | 'missing'
  try {
    kind = lstatSync(link).isSymbolicLink() ? 'symlink' : 'bundle'
  } catch {
    kind = 'missing'
  }
  // Where it is set aside (real-copy form). If it is the same version, set it aside to a temporary name next to `link` and delete it on success.
  let retiredTo: string | null = null
  let trash: string | null = null
  let undoLink: string | null = null
  try {
    if (kind === 'symlink') {
      undoLink = readlinkSync(link)
      rmSync(link, { force: true })
    } else if (kind === 'bundle') {
      const current = bundleVersion(link)
      // Something whose version cannot be read (something else the user put there, or a broken .app) is not moved. There would be no copy to restore even if set aside.
      if (current === null) return fail()
      if (current !== version) {
        const dir = join(versionsDir, current)
        // If the same version was already set aside earlier (a copy with the same signature), replace it.
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir)
        retiredTo = join(dir, APP_BUNDLE_NAME)
        renameSync(link, retiredTo)
      } else {
        trash = `${link}.aios-old-${process.pid}`
        rmSync(trash, { recursive: true, force: true })
        renameSync(link, trash)
      }
    }
    renameSync(incoming, link)
  } catch {
    // Restore: the real copy that was set aside / the symlink that was removed.
    try {
      if (!existsSync(link)) {
        if (retiredTo !== null && existsSync(retiredTo)) renameSync(retiredTo, link)
        else if (trash !== null && existsSync(trash)) renameSync(trash, link)
        else if (undoLink !== null) symlinkSync(undoLink, link)
      }
    } catch {
      // Could not restore: install-aios.sh can reinstall (if `link` is missing it is clear that aios cannot run).
    }
    return fail()
  }
  if (trash !== null) rmSync(trash, { recursive: true, force: true })
  // The version directory after placing is empty. Delete it only when empty.
  try {
    rmdirSync(join(versionsDir, version))
  } catch {
    // Not empty (it holds a half-fetched copy, etc.) or absent: leave it as is.
  }
}

/** The version directories, newest first. */
export function listVersions(versionsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(versionsDir)
  } catch {
    return []
  }
  return names
    .filter((name) => isVersionDirName(name) && existsSync(join(versionsDir, name, APP_BUNDLE_NAME)))
    .sort((a, b) => compareVersions(b, a) ?? 0)
}

/** The number of versions to keep (newest first. The running one and the symlink's target are kept regardless of the count). Same as `KEEP_VERSIONS` in install-aios.sh. */
export const KEEP_VERSIONS = 3

/**
 * Delete old version directories. `keep` (the running version, the symlink's target, the just-installed version) is always kept, and of the rest
 * the newest `KEEP_VERSIONS` are kept. Returns the versions deleted.
 */
export function pruneVersions(versionsDir: string, keep: readonly string[], max = KEEP_VERSIONS): string[] {
  const all = listVersions(versionsDir)
  const kept = new Set(keep.filter((version) => all.includes(version)))
  for (const version of all) {
    if (kept.size >= Math.max(max, keep.length)) break
    kept.add(version)
  }
  const removed: string[] = []
  for (const version of all) {
    if (kept.has(version)) continue
    rmSync(join(versionsDir, version), { recursive: true, force: true })
    removed.push(version)
  }
  return removed
}
