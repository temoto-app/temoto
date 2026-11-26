// TODO 103 stage 1 (wave 28 bundle G): automatic updates. Nothing reaches the network or the real ~/Applications: gh / codesign / ditto are replaced,
// and the location is a temporary directory.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { UpdateWiring } from '../src/main/update/ipc.js'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { RELEASE_BUNDLE_ID as SCRIPT_RELEASE_BUNDLE_ID } from '../scripts/app-shell.mjs'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { RELEASE_REPO, developerIdRequirement as releaseDeveloperIdRequirement, parseCodesignDetail, zipName } from '../scripts/release-config.mjs'
import { compareVersions, isNewerVersion, normalizeVersion } from '../src/shared/update.js'
import { parseReason, reasonError } from '../src/shared/reason.js'
import {
  APP_BUNDLE_NAME,
  BUNDLE_ID,
  DEFAULT_RELEASE_REPO,
  bundleOfExecutable,
  defaultInstallRoot,
  detectInstall,
  linkedVersion,
  parseInstallManifest,
  plistVersion as parsePlistVersion,
  releaseZipName,
  INSTALL_MANIFEST_REPO_KEY,
  INSTALL_ROOT_POINTER_NAME,
  STAGING_PREFIX,
  STALE_STAGING_MS,
  type DetectInput,
  type InstallLayout,
  type LayoutFs
} from '../src/main/update/layout.js'
import {
  DEVELOPER_ID_TEAMS,
  KEEP_VERSIONS,
  SELF_SIGNED_NAME,
  checksumFor,
  developerIdRequirement,
  isAcceptedSigner,
  pruneVersions,
  removeStaleStaging,
  signerOf,
  stageRelease,
  swapApp
} from '../src/main/update/stage.js'
import { ghReleaseSource, type CommandRunner } from '../src/main/update/release-source.js'
import {
  BACKGROUND_SHELL_GRACE_MS,
  CHECK_INTERVAL_MS,
  CHECK_RETRY_BASE_MS,
  FIRST_CHECK_DELAY_MS,
  IDLE_RESTART_SECONDS,
  TICK_MS,
  UpdateService,
  type UpdateServiceDeps
} from '../src/main/update/service.js'
import { UPDATE_AUTO, UPDATE_LAST_RUN_VERSION, UPDATE_STAGED_AT, type SettingKey } from '../src/common/settings-keys.js'
import type { UpdateStatus } from '../src/shared/update.js'

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code
  }
  return undefined
}


/** Output of `codesign -dvv` (TODO 951). The Developer ID has the shape of the real VS Code output (2026-10-30), with only the name and Team ID replaced. */
const SIGNED_DEVELOPER_ID = [
  'Executable=/x/Temoto.app/Contents/MacOS/Temoto',
  'Identifier=io.github.temoto-app.temoto',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=640 flags=0x10000(runtime) hashes=9+7 location=embedded',
  'Signature size=9013',
  'Authority=Developer ID Application: Motokimi Kuzume (LVG3JZJZ3U)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Oct 6, 2026 at 18:08:40',
  'Notarization Ticket=stapled',
  'Info.plist entries=39',
  'TeamIdentifier=LVG3JZJZ3U',
  'Runtime Version=26.0.0',
  ''
].join('\n')
/** Self-signed `aios dev` (the real ~/Applications/Temoto.app, 2026-10-30). */
const SIGNED_AIOS_DEV = [
  'Identifier=io.github.temoto-app.temoto',
  'CodeDirectory v=20100 size=187 flags=0x0(none) hashes=1+3 location=embedded',
  'Signature size=1693',
  'Authority=aios dev',
  'Signed Time=Oct 3, 2026 at 19:34:20',
  'TeamIdentifier=not set',
  ''
].join('\n')
const SIGNED_ADHOC = [
  'Identifier=io.github.temoto-app.temoto',
  'CodeDirectory v=20400 size=500 flags=0x2(adhoc) hashes=9+7 location=embedded',
  'Signature=adhoc',
  'TeamIdentifier=not set',
  ''
].join('\n')

describe('how versions are compared', () => {
  it('compares by 3 numbers regardless of a leading v, and gives null / false when unreadable', () => {
    expect(compareVersions('0.28.0', '0.29.0')).toBe(-1)
    expect(compareVersions('v0.30.0', '0.29.9')).toBe(1)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.28.0-beta', '0.28.0')).toBeNull()
    expect(isNewerVersion('0.29.0', '0.28.0')).toBe(true)
    // Neither a downgrade nor reinstalling the same version
    expect(isNewerVersion('0.27.0', '0.28.0')).toBe(false)
    expect(isNewerVersion('0.28.0', '0.28.0')).toBe(false)
    expect(isNewerVersion('garbage', '0.28.0')).toBe(false)
    expect(normalizeVersion('v0.29.0')).toBe('0.29.0')
  })
})

describe('signer (TODO 951)', () => {
  it('separates Developer ID, self-signed, and ad-hoc, and accepts only Team ID LVG3JZJZ3U and aios dev', () => {
    expect(signerOf(SIGNED_DEVELOPER_ID)).toEqual({ kind: 'developer-id', teamId: 'LVG3JZJZ3U' })
    expect(signerOf(SIGNED_AIOS_DEV)).toEqual({ kind: 'self-signed', name: 'aios dev' })
    expect(signerOf(SIGNED_ADHOC)).toEqual({ kind: 'adhoc' })
    expect(isAcceptedSigner(signerOf(SIGNED_DEVELOPER_ID))).toBe(true)
    expect(isAcceptedSigner(signerOf(SIGNED_AIOS_DEV))).toBe(true)
    expect(isAcceptedSigner(signerOf(SIGNED_ADHOC))).toBe(false)
    expect(isAcceptedSigner(signerOf(SIGNED_DEVELOPER_ID.replaceAll('LVG3JZJZ3U', 'UBF8T346G9')))).toBe(false)
    // Apple Development (cannot be notarized) is not accepted
    expect(isAcceptedSigner(signerOf(SIGNED_DEVELOPER_ID.replace('Developer ID Application:', 'Apple Development:')))).toBe(false)
    expect(DEVELOPER_ID_TEAMS).toEqual(['LVG3JZJZ3U'])
    expect(SELF_SIGNED_NAME).toBe('aios dev')
  })

  it('the same as the reading and requirement text of release.mjs (scripts/release-config.mjs)', () => {
    expect(parseCodesignDetail(SIGNED_DEVELOPER_ID)).toMatchObject({
      identifier: 'io.github.temoto-app.temoto',
      teamId: 'LVG3JZJZ3U',
      authorities: ['Developer ID Application: Motokimi Kuzume (LVG3JZJZ3U)', 'Developer ID Certification Authority', 'Apple Root CA'],
      runtime: true,
      stapled: true,
      adhoc: false
    })
    expect(parseCodesignDetail(SIGNED_AIOS_DEV)).toMatchObject({ teamId: null, authorities: ['aios dev'], runtime: false, stapled: false })
    expect(parseCodesignDetail(SIGNED_ADHOC)).toMatchObject({ teamId: null, authorities: [], adhoc: true })
    expect(releaseDeveloperIdRequirement('LVG3JZJZ3U')).toBe(developerIdRequirement('LVG3JZJZ3U'))
  })
})

describe('matching against the distributed build', () => {
  it('the zip name, repo, and identifier are the same as the release / shell scripts', () => {
    expect(releaseZipName('0.29.0')).toBe(zipName('0.29.0'))
    expect(DEFAULT_RELEASE_REPO).toBe(RELEASE_REPO)
    expect(BUNDLE_ID).toBe(SCRIPT_RELEASE_BUNDLE_ID)
  })

  it('the same as install-temoto.sh in layout (root, versions, install.json, number kept)', () => {
    const script = readFileSync(new URL('../scripts/install-temoto.sh', import.meta.url), 'utf8')
    // TODO 1263: the root follows the data name (the tests run under the legacy name; the new name is passed explicitly)
    expect(defaultInstallRoot('/Users/u')).toBe('/Users/u/.local/share/aios')
    expect(defaultInstallRoot('/Users/u', 'Temoto')).toBe('/Users/u/.local/share/Temoto')
    expect(script).toContain('DEFAULT_ROOT="$HOME/.local/share/$DATA_NAME"')
    expect(script).toContain('ROOT="${AIOS_INSTALL_ROOT:-$DEFAULT_ROOT}"')
    expect(script).toContain('VERSIONS="$ROOT/versions"')
    expect(script).toContain('"$ROOT/install.json"')
    // TODO 1185: the repo key in install.json and the default repo for fetching Releases are the same as aios's
    expect(script).toContain(`"link":%s,"${INSTALL_MANIFEST_REPO_KEY}":%s`)
    expect(script).not.toMatch(/"repo":%s/)
    // TODO 1254: the default repo and the .app name are constants at the top of the script (same values as src/shared/product.json)
    expect(script).toContain(`PUBLIC_REPO=${DEFAULT_RELEASE_REPO}`)
    expect(script).toContain('REPO="${AIOS_REPO:-$PUBLIC_REPO}"')
    expect(script).toContain(`PRODUCT=${APP_BUNDLE_NAME.replace(/\.app$/, '')}`)
    expect(script).toContain('APP_NAME="$PRODUCT.app"')
    expect(script).toContain(`"$DEFAULT_ROOT/${INSTALL_ROOT_POINTER_NAME}"`)
    expect(script).toContain(`KEEP_VERSIONS=${KEEP_VERSIONS}`)
    expect(script).toContain('$VERSIONS/.staging-XXXXXX')
    // TODO 1050: swapping is only a rename (move the old one aside, then put the new one in place). The symlink form is dropped and a real copy is placed
    expect(script).toContain('mv "$APP" "$VERSIONS/$installed/$APP_NAME"')
    expect(script).toContain('mv "$VERSIONS/$version/$APP_NAME" "$APP"')
  })
})

const PLIST = (version: string): string =>
  `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`

describe('install location detection (detectInstall)', () => {
  const root = '/Users/u/.local/share/aios'
  const link = '/Users/u/Applications/Temoto.app'
  const bundle = `${root}/versions/0.28.0/Temoto.app`
  const base: DetectInput = {
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    devServer: false,
    defaultUserData: true,
    execPath: `${bundle}/Contents/MacOS/Temoto`,
    appPath: `${bundle}/Contents/Resources/app`,
    home: '/Users/u'
  }
  function fakeFs(overrides: Partial<{ links: Record<string, string>; files: Record<string, string>; symlinks: string[] }> = {}): LayoutFs {
    const links: Record<string, string> = { [link]: `${root}/versions/0.28.0/Temoto.app`, ...overrides.links }
    const files: Record<string, string> = {
      [`${root}/install.json`]: JSON.stringify({ link, releaseRepo: 'someone/fork' }),
      ...overrides.files
    }
    const symlinks = new Set(overrides.symlinks ?? [link])
    return {
      realpath: (path) => links[path] ?? path,
      isSymlink: (path) => symlinks.has(path),
      readText: (path) => files[path] ?? null
    }
  }

  it('versioned when running from a version directory and a symlink and install.json exist', () => {
    const detection = detectInstall(base, fakeFs())
    expect(detection).toEqual({
      kind: 'versioned',
      layout: { root, versionsDir: `${root}/versions`, link, repo: 'someone/fork', runningVersion: '0.28.0' }
    })
  })

  it('judges by the real path even with an execPath through a symlink', () => {
    const viaLink = { ...base, execPath: `${link}/Contents/MacOS/Temoto` }
    const detection = detectInstall(viaLink, fakeFs())
    expect(detection.kind).toBe('versioned')
  })

  it('TODO 1050: the real-directory form (running from ~/Applications/Temoto.app itself) is versioned too, and the root is the default location', () => {
    const real = { ...base, execPath: `${link}/Contents/MacOS/Temoto`, appPath: `${link}/Contents/Resources/app` }
    const fs = fakeFs({
      links: { [link]: link },
      symlinks: [],
      files: { [`${link}/Contents/Info.plist`]: PLIST('0.30.0') }
    })
    expect(detectInstall(real, fs)).toEqual({
      kind: 'versioned',
      layout: { root, versionsDir: `${root}/versions`, link, repo: 'someone/fork', runningVersion: '0.30.0' }
    })
    // No backup / the backup's link points elsewhere / Info.plist unreadable / link is a symlink (the 103 form, but not running from the version directory) all give not-installed
    const notInstalled = { kind: 'unsupported', reason: 'not-installed' }
    expect(detectInstall(real, fakeFs({ links: { [link]: link }, symlinks: [], files: { [`${root}/install.json`]: '{' } }))).toEqual(notInstalled)
    expect(detectInstall(real, fakeFs({ links: { [link]: link }, symlinks: [] }))).toEqual(notInstalled)
    expect(detectInstall(real, fakeFs({ links: { [link]: link }, symlinks: [link], files: { [`${link}/Contents/Info.plist`]: PLIST('0.30.0') } }))).toEqual(notInstalled)
  })

  it("review 57-10: a root moved with AIOS_INSTALL_ROOT is also followed from the default root's install-root and is versioned", () => {
    const custom = '/Volumes/data/aios-root'
    const real = { ...base, execPath: `${link}/Contents/MacOS/Temoto`, appPath: `${link}/Contents/Resources/app` }
    const fs = fakeFs({
      links: { [link]: link },
      symlinks: [],
      files: {
        [`${root}/install-root`]: `${custom}\n`,
        [`${custom}/install.json`]: JSON.stringify({ link, releaseRepo: 'someone/fork' }),
        [`${link}/Contents/Info.plist`]: PLIST('0.30.0')
      }
    })
    expect(detectInstall(real, fs)).toEqual({
      kind: 'versioned',
      layout: { root: custom, versionsDir: `${custom}/versions`, link, repo: 'someone/fork', runningVersion: '0.30.0' }
    })
    // If the target is relative, fall back to the default root (the default root has an install.json)
    const rel = fakeFs({
      links: { [link]: link },
      symlinks: [],
      files: { [`${root}/install-root`]: 'rel/root', [`${link}/Contents/Info.plist`]: PLIST('0.30.0') }
    })
    expect(detectInstall(real, rel)).toMatchObject({ kind: 'versioned', layout: { root } })
  })

  it('TODO 1050: reads the version in Info.plist', () => {
    expect(parsePlistVersion(PLIST('0.30.0'))).toBe('0.30.0')
    expect(parsePlistVersion(PLIST('abc'))).toBeNull()
    expect(parsePlistVersion(null)).toBeNull()
    expect(parsePlistVersion('bplist00')).toBeNull()
  })

  it('forms that do not move: npm run dev / launching a built app directly with electron . / a shell under development / a copy / other OSes', () => {
    // TODO 623: with no dev server and isPackaged false (a built app started directly with `electron .`), use the reason not-installed (not installed as a distributed build),
    // not the 'npm run dev' one.
    expect(detectInstall({ ...base, isPackaged: false }, fakeFs())).toEqual({ kind: 'unsupported', reason: 'not-installed' })
    expect(detectInstall({ ...base, devServer: true }, fakeFs())).toEqual({ kind: 'unsupported', reason: 'dev' })
    expect(detectInstall({ ...base, isPackaged: false, devServer: true }, fakeFs())).toEqual({
      kind: 'unsupported',
      reason: 'dev'
    })
    // In the shell, Resources/app is a symlink to the repo
    expect(detectInstall(base, fakeFs({ symlinks: [link, base.appPath] }))).toEqual({ kind: 'unsupported', reason: 'dev-shell' })
    expect(detectInstall({ ...base, defaultUserData: false }, fakeFs())).toEqual({ kind: 'unsupported', reason: 'instance' })
    expect(detectInstall({ ...base, arch: 'x64' }, fakeFs())).toEqual({ kind: 'unsupported', reason: 'platform' })
  })

  it('not-installed when outside the install-temoto.sh location (an old-style real directory, no record, not a symlink)', () => {
    const legacy = { ...base, execPath: `${link}/Contents/MacOS/Temoto` }
    expect(detectInstall(legacy, fakeFs({ links: { [link]: link }, symlinks: [] }))).toEqual({
      kind: 'unsupported',
      reason: 'not-installed'
    })
    expect(detectInstall(base, fakeFs({ files: { [`${root}/install.json`]: '{' } }))).toEqual({
      kind: 'unsupported',
      reason: 'not-installed'
    })
    expect(detectInstall(base, fakeFs({ symlinks: [] }))).toEqual({ kind: 'unsupported', reason: 'not-installed' })
    expect(detectInstall(base, fakeFs({ links: { [link]: '/elsewhere/Temoto.app' } }))).toEqual({
      kind: 'unsupported',
      reason: 'not-installed'
    })
  })

  it('checks the shape of install.json', () => {
    expect(parseInstallManifest('{"link":"/a/Temoto.app"}')).toEqual({ link: '/a/Temoto.app', repo: DEFAULT_RELEASE_REPO })
    expect(parseInstallManifest('{"link":"rel/Temoto.app"}')).toBeNull()
    expect(parseInstallManifest('{"link":"/a/Temoto.app","releaseRepo":"no slash"}')).toBeNull()
    expect(parseInstallManifest('{"link":"/a/Temoto.app","releaseRepo":"someone/fork"}')).toEqual({ link: '/a/Temoto.app', repo: 'someone/fork' })
    // TODO 1185: do not read the old key repo (the default from before the switch is written there); look at the default public repo
    expect(parseInstallManifest('{"link":"/a/Temoto.app","repo":"old/place"}')).toEqual({ link: '/a/Temoto.app', repo: DEFAULT_RELEASE_REPO })
    expect(DEFAULT_RELEASE_REPO).toBe('temoto-app/temoto')
    // code-review: hold (set back with --version in install-temoto.sh) accepts only the version form
    expect(parseInstallManifest('{"link":"/a/Temoto.app","hold":"0.30.0"}')).toEqual({
      link: '/a/Temoto.app',
      repo: DEFAULT_RELEASE_REPO,
      hold: '0.30.0'
    })
    expect(parseInstallManifest('{"link":"/a/Temoto.app","hold":"bad"}')).toEqual({
      link: '/a/Temoto.app',
      repo: DEFAULT_RELEASE_REPO
    })
    expect(bundleOfExecutable('/x/Temoto.app/Contents/MacOS/Temoto')).toBe('/x/Temoto.app')
    expect(bundleOfExecutable('/usr/bin/node')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Placing, swapping, and cleanup (the real fs, in a temporary directory)
// ---------------------------------------------------------------------------

describe('placing into the version directory (stageRelease)', () => {
  let dir: string
  let layout: InstallLayout
  const version = '0.29.0'
  const zip = releaseZipName(version)
  let zipBytes: Buffer
  let sums: string
  let identifier: string
  let signer: string
  let requirementCode: number
  let plistVersion: string
  let ditto: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-update-')))
    const versionsDir = join(dir, 'root', 'versions')
    mkdirSync(join(versionsDir, '0.28.0', 'Temoto.app', 'Contents'), { recursive: true })
    layout = { root: join(dir, 'root'), versionsDir, link: join(dir, 'Applications', 'Temoto.app'), repo: 'o/r', runningVersion: '0.28.0' }
    zipBytes = Buffer.from('pretend zip')
    sums = `${createHash('sha256').update(zipBytes).digest('hex')}  ${zip}\n${'0'.repeat(64)}  install-temoto.sh\n`
    identifier = 'io.github.temoto-app.temoto'
    signer = SIGNED_AIOS_DEV
    requirementCode = 0
    plistVersion = version
    ditto = vi.fn()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const source = {
    latestTag: async () => `v${version}`,
    download: async (_tag: string, names: readonly string[], target: string) => {
      expect(names).toEqual([zip, 'SHA256SUMS'])
      writeFileSync(join(target, zip), zipBytes)
      writeFileSync(join(target, 'SHA256SUMS'), sums)
    }
  }
  const run: CommandRunner = async (command, args) => {
    if (command === 'ditto') {
      ditto(args)
      const out = args[3] as string
      mkdirSync(join(out, 'Temoto.app', 'Contents'), { recursive: true })
      writeFileSync(join(out, 'Temoto.app', 'Contents', 'Info.plist'), 'plist')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'codesign' && args[0] === '--verify' && args.includes('-R')) {
      requirements.push(args[args.indexOf('-R') + 1] as string)
      return { code: requirementCode, stdout: '', stderr: '' }
    }
    if (command === 'codesign' && args[0] === '--verify') return { code: 0, stdout: '', stderr: '' }
    if (command === 'codesign') return { code: 0, stdout: '', stderr: `Executable=x\nIdentifier=${identifier}\n${signer}` }
    if (command === 'plutil') return { code: 0, stdout: `${plistVersion}\n`, stderr: '' }
    if (command === 'xattr') return { code: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected ${command}`)
  }

  const requirements: string[] = []
  const stagingLeft = (): string[] => readdirSync(layout.versionsDir).filter((name) => name.startsWith('.app-staging-'))

  it('fetches, verifies SHA-256, signature, identifier, and version, and places into the version directory, leaving no partial fetch', async () => {
    const result = await stageRelease(layout, `v${version}`, version, source, run)
    expect(result).toEqual({ bundle: join(layout.versionsDir, version, 'Temoto.app'), reused: false })
    expect(existsSync(join(layout.versionsDir, version, 'Temoto.app', 'Contents', 'Info.plist'))).toBe(true)
    expect(stagingLeft()).toEqual([])
    // Do not fetch it again; reuse it
    const again = await stageRelease(layout, `v${version}`, version, source, run)
    expect(again.reused).toBe(true)
    expect(ditto).toHaveBeenCalledTimes(1)
  })

  it('places nothing if SHA-256 does not match', async () => {
    sums = `${'f'.repeat(64)}  ${zip}\n`
    expect(await reasonOf(stageRelease(layout, `v${version}`, version, source, run))).toBe('update-checksum-mismatch')
    expect(existsSync(join(layout.versionsDir, version))).toBe(false)
    expect(stagingLeft()).toEqual([])
    expect(ditto).not.toHaveBeenCalled()
  })

  it('does not place an .app with a different identifier or version', async () => {
    identifier = 'com.example.other'
    expect(await reasonOf(stageRelease(layout, `v${version}`, version, source, run))).toBe('update-invalid-app')
    identifier = 'io.github.temoto-app.temoto'
    plistVersion = '0.28.9'
    expect(await reasonOf(stageRelease(layout, `v${version}`, version, source, run))).toBe('update-invalid-app')
    expect(existsSync(join(layout.versionsDir, version))).toBe(false)
    expect(stagingLeft()).toEqual([])
  })

  it("TODO 951: places both a Developer ID build (the Team ID verified through Apple's CA chain) and a self-signed aios dev build", async () => {
    signer = SIGNED_DEVELOPER_ID
    requirements.length = 0
    const result = await stageRelease(layout, `v${version}`, version, source, run)
    expect(result.reused).toBe(false)
    expect(requirements).toEqual([developerIdRequirement('LVG3JZJZ3U')])
    // A self-signed version (a build from before notarization, the downgrade safety net) does not check the requirements
    rmSync(join(layout.versionsDir, version), { recursive: true, force: true })
    signer = SIGNED_AIOS_DEV
    requirements.length = 0
    expect((await stageRelease(layout, `v${version}`, version, source, run)).reused).toBe(false)
    expect(requirements).toEqual([])
  })

  it("TODO 951: does not place ad-hoc, another signer, a Developer ID that fails the requirement, or another Team ID's build", async () => {
    for (const [text, code] of [
      [SIGNED_ADHOC, 0],
      ['Authority=someone else\nTeamIdentifier=not set\n', 0],
      [SIGNED_DEVELOPER_ID, 3],
      [SIGNED_DEVELOPER_ID.replaceAll('LVG3JZJZ3U', 'ABCDE12345'), 0]
    ] as const) {
      signer = text
      requirementCode = code
      expect(await reasonOf(stageRelease(layout, `v${version}`, version, source, run))).toBe('update-untrusted-signer')
      expect(existsSync(join(layout.versionsDir, version))).toBe(false)
      expect(stagingLeft()).toEqual([])
    }
  })

  it('when it cannot fetch, keeps the reason code, and the previous partial fetch (older than 1 hour) is also cleaned up', async () => {
    const old = join(layout.versionsDir, '.app-staging-old')
    mkdirSync(old)
    const past = (Date.now() - STALE_STAGING_MS - 60_000) / 1000
    utimesSync(old, past, past)
    const failing = { ...source, download: async () => Promise.reject(reasonError('update-gh-auth')) }
    expect(await reasonOf(stageRelease(layout, `v${version}`, version, failing, run))).toBe('update-gh-auth')
    expect(stagingLeft()).toEqual([])
  })

  it('code-review: does not remove an extraction of install-temoto.sh (.staging-*) or an in-progress partial fetch (new)', () => {
    const script = join(layout.versionsDir, '.staging-abc123')
    const fresh = join(layout.versionsDir, '.app-staging-fresh')
    const old = join(layout.versionsDir, '.app-staging-old')
    for (const path of [script, fresh, old]) mkdirSync(path)
    const past = (Date.now() - STALE_STAGING_MS - 60_000) / 1000
    utimesSync(script, past, past)
    utimesSync(old, past, past)
    expect(removeStaleStaging(layout.versionsDir)).toBe(1)
    expect(existsSync(script)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(STAGING_PREFIX).not.toBe('.staging-')
  })

  const putApp = (path: string, version: string, mark: string): void => {
    mkdirSync(join(path, 'Contents'), { recursive: true })
    writeFileSync(join(path, 'Contents', 'Info.plist'), PLIST(version))
    writeFileSync(join(path, 'mark'), mark)
  }
  const markOf = (path: string): string => readFileSync(join(path, 'mark'), 'utf8')

  it('TODO 1050: moves the real Temoto.app aside to versions/<current version> and puts the new version in place with rename', () => {
    putApp(layout.link, '0.28.0', 'old')
    putApp(join(layout.versionsDir, version, 'Temoto.app'), version, 'new')
    swapApp(layout, version)
    expect(lstatSync(layout.link).isSymbolicLink()).toBe(false)
    expect(markOf(layout.link)).toBe('new')
    expect(linkedVersion(layout)).toBe(version)
    expect(markOf(join(layout.versionsDir, '0.28.0', 'Temoto.app'))).toBe('old')
    // The placed version's directory (empty) does not remain, and no temporary name is left beside it
    expect(existsSync(join(layout.versionsDir, version))).toBe(false)
    expect(readdirSync(join(dir, 'Applications'))).toEqual(['Temoto.app'])
    // Going back (placing the moved-aside version) uses the same steps
    swapApp(layout, '0.28.0')
    expect(markOf(layout.link)).toBe('old')
    expect(markOf(join(layout.versionsDir, version, 'Temoto.app'))).toBe('new')
  })

  it('TODO 1050: removes the 103 symlink form and places the real directory, with the previous version left in versions', () => {
    mkdirSync(join(dir, 'Applications'), { recursive: true })
    putApp(join(layout.versionsDir, '0.28.0', 'Temoto.app'), '0.28.0', 'old')
    putApp(join(layout.versionsDir, version, 'Temoto.app'), version, 'new')
    symlinkSync(join(layout.versionsDir, '0.28.0', 'Temoto.app'), layout.link)
    expect(linkedVersion(layout)).toBe('0.28.0')
    swapApp(layout, version)
    expect(lstatSync(layout.link).isSymbolicLink()).toBe(false)
    expect(markOf(layout.link)).toBe('new')
    expect(markOf(join(layout.versionsDir, '0.28.0', 'Temoto.app'))).toBe('old')
  })

  it('TODO 1050: places it even if the link is gone midway through the swap (the previous run died between the two renames), and refuses if there is no version to put in', () => {
    mkdirSync(join(dir, 'Applications'), { recursive: true })
    putApp(join(layout.versionsDir, version, 'Temoto.app'), version, 'new')
    swapApp(layout, version)
    expect(markOf(layout.link)).toBe('new')
    expect(() => swapApp(layout, '0.31.0')).toThrow()
    expect(markOf(layout.link)).toBe('new')
  })

  it('TODO 1050: when placing fails, restores the real directory that was moved aside', () => {
    putApp(layout.link, '0.28.0', 'old')
    // Build a state where the path of the version to install is not a directory (a directory cannot be placed by rename), and fail the second rename
    mkdirSync(join(layout.versionsDir, version), { recursive: true })
    writeFileSync(join(layout.versionsDir, version, 'Temoto.app'), 'file')
    let code: string | undefined
    try {
      swapApp(layout, version)
    } catch (err) {
      code = parseReason((err as Error).message)?.code
    }
    expect(code).toBe('update-install-failed')
    expect(markOf(layout.link)).toBe('old')
  })

  it('review 57-6: when the link is something else whose version cannot be read, refuses without moving or deleting anything', () => {
    mkdirSync(layout.link, { recursive: true })
    writeFileSync(join(layout.link, 'mine'), 'user')
    putApp(join(layout.versionsDir, version, 'Temoto.app'), version, 'new')
    expect(() => swapApp(layout, version)).toThrow()
    expect(readFileSync(join(layout.link, 'mine'), 'utf8')).toBe('user')
    expect(markOf(join(layout.versionsDir, version, 'Temoto.app'))).toBe('new')
    expect(readdirSync(join(dir, 'Applications'))).toEqual(['Temoto.app'])
  })

  it('keeps up to KEEP_VERSIONS (2) versions, newest first, and always keeps a version told to be kept', () => {
    expect(KEEP_VERSIONS).toBe(2)
    for (const v of ['0.25.0', '0.26.0', '0.27.0', '0.29.0', '0.30.0']) {
      mkdirSync(join(layout.versionsDir, v, 'Temoto.app'), { recursive: true })
    }
    // 0.25.0 is running (set back by hand); 0.30.0 is the one installed
    const removed = pruneVersions(layout.versionsDir, ['0.25.0', '0.30.0'])
    expect(removed.sort()).toEqual(['0.26.0', '0.27.0', '0.28.0', '0.29.0'])
    expect(readdirSync(layout.versionsDir).sort()).toEqual(['0.25.0', '0.30.0'])
  })

  it('with the real-copy form (max = KEEP_VERSIONS - 1 = 1) still never deletes the running, linked or just-installed version', () => {
    for (const v of ['0.25.0', '0.26.0', '0.27.0', '0.29.0', '0.30.0']) {
      mkdirSync(join(layout.versionsDir, v, 'Temoto.app'), { recursive: true })
    }
    // running 0.26.0, symlink target 0.27.0, just installed 0.30.0: all three survive although max is 1
    const removed = pruneVersions(layout.versionsDir, ['0.26.0', '0.27.0', '0.30.0'], KEEP_VERSIONS - 1)
    expect(removed.sort()).toEqual(['0.25.0', '0.28.0', '0.29.0'])
    expect(readdirSync(layout.versionsDir).sort()).toEqual(['0.26.0', '0.27.0', '0.30.0'])
    // with nothing to keep, exactly the newest one stays
    expect(pruneVersions(layout.versionsDir, [], KEEP_VERSIONS - 1).sort()).toEqual(['0.26.0', '0.27.0'])
    expect(readdirSync(layout.versionsDir)).toEqual(['0.30.0'])
  })

  it('wave 105 review: the real-copy form (running and linked versions outside versions/) keeps only 1 version in versions/ with max = 1', () => {
    for (const v of ['0.102.0', '0.103.0', '0.105.0']) {
      mkdirSync(join(layout.versionsDir, v, 'Temoto.app'), { recursive: true })
    }
    // 0.104.0 is running and is the install location itself (not in versions/); 0.105.0 was just staged in versions/
    const removed = pruneVersions(layout.versionsDir, ['0.104.0', '0.105.0', '0.104.0'], KEEP_VERSIONS - 1)
    expect(removed.sort()).toEqual(expect.arrayContaining(['0.102.0', '0.103.0']))
    expect(readdirSync(layout.versionsDir).sort()).toEqual(['0.105.0'])
  })

  it('wave 105 review: the symlink form (max = 2) keeps the running version, the target and nothing else beyond them', () => {
    for (const v of ['0.102.0', '0.103.0', '0.104.0', '0.105.0']) {
      mkdirSync(join(layout.versionsDir, v, 'Temoto.app'), { recursive: true })
    }
    pruneVersions(layout.versionsDir, ['0.104.0', '0.105.0', '0.104.0'], KEEP_VERSIONS)
    expect(readdirSync(layout.versionsDir).sort()).toEqual(['0.104.0', '0.105.0'])
  })

  it('picks the line of SHA256SUMS', () => {
    expect(checksumFor(sums, zip)).toMatch(/^[0-9a-f]{64}$/)
    expect(checksumFor(sums, 'nothing')).toBeNull()
  })
})

describe('the gh-based source (ghReleaseSource)', () => {
  it('looks up the latest tag with gh release view, and gh missing or not logged in are reason codes', async () => {
    const calls: string[][] = []
    const ok: CommandRunner = async (_cmd, args) => {
      calls.push([...args])
      return { code: 0, stdout: 'v0.29.0\n', stderr: '' }
    }
    expect(await ghReleaseSource('o/r', ok).latestTag()).toBe('v0.29.0')
    expect(calls[0]).toEqual(['release', 'view', '-R', 'o/r', '--json', 'tagName', '--jq', '.tagName'])

    const missing: CommandRunner = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    }
    expect(await reasonOf(ghReleaseSource('o/r', missing).latestTag())).toBe('update-gh-missing')
    const auth: CommandRunner = async () => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' })
    expect(await reasonOf(ghReleaseSource('o/r', auth).latestTag())).toBe('update-gh-auth')
    const notFound: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' })
    expect(await reasonOf(ghReleaseSource('o/r', notFound).latestTag())).toBe('update-gh-auth')
    const other: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'unexpected failure' })
    expect(await reasonOf(ghReleaseSource('o/r', other).download('v1.0.0', ['a'], '/tmp/x'))).toBe('update-download-failed')
  })
})

// ---------------------------------------------------------------------------
// UpdateService
// ---------------------------------------------------------------------------

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

const versionedLayout: InstallLayout = {
  root: '/r',
  versionsDir: '/r/versions',
  link: '/A/Temoto.app',
  repo: 'o/r',
  runningVersion: '0.28.0'
}

function harness(overrides: Partial<UpdateServiceDeps> = {}, settings = new MemorySettings()) {
  let now = 1_000_000
  let tick: (() => void) | null = null
  let linked: string | null = '0.28.0'
  let idleSeconds = 0
  let blocker: string | null = null
  const blockerCalls: boolean[] = []
  const statuses: UpdateStatus[] = []
  const stage = vi.fn<(tag: string, version: string) => Promise<{ reused: boolean }>>(async () => ({ reused: false }))
  const swap = vi.fn((version: string) => {
    linked = version
  })
  const relaunch = vi.fn()
  const prune = vi.fn<(keep: readonly string[]) => string[]>(() => [])
  const latestTag = vi.fn(async () => 'v0.29.0')
  const service = new UpdateService({
    settings,
    currentVersion: '0.28.0',
    detection: { kind: 'versioned', layout: versionedLayout },
    latestTag,
    stage,
    linkedVersion: () => linked,
    swapLink: swap,
    prune,
    restartBlocker: (options) => {
      blockerCalls.push(options.ignoreBackgroundShells)
      return blocker
    },
    systemIdleSeconds: () => idleSeconds,
    closing: () => false,
    // Wave 106 review Z2: the reservation carrying is required; by default there is nothing to carry.
    carryReservations: () => true,
    relaunch,
    onChanged: (status) => statuses.push(status),
    now: () => now,
    schedule: (fn) => {
      tick = fn
      return () => {
        tick = null
      }
    },
    ...overrides
  })
  return {
    service,
    settings,
    stage,
    swap,
    relaunch,
    prune,
    latestTag,
    statuses,
    blockerCalls,
    advance(ms: number) {
      now += ms
    },
    tick() {
      tick?.()
    },
    get ticking() {
      return tick !== null
    },
    setLinked(version: string | null) {
      linked = version
    },
    setIdle(seconds: number) {
      idleSeconds = seconds
    },
    setBlocker(value: string | null) {
      blocker = value
    },
    async settle() {
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    }
  }
}

describe('UpdateService', () => {
  it('in a form that does not move, records nothing and the operation is update-unsupported, and the previous version is recorded', async () => {
    const settings = new MemorySettings()
    const h = harness({ detection: { kind: 'unsupported', reason: 'dev-shell' } }, settings)
    h.service.start()
    expect(h.ticking).toBe(false)
    expect(h.service.status()).toMatchObject({ supported: false, unsupportedReason: 'dev-shell', current: '0.28.0' })
    expect(await reasonOf(h.service.check())).toBe('update-unsupported')
    expect(settings.readTyped(UPDATE_LAST_RUN_VERSION)).toBe('0.28.0')
    expect(h.latestTag).not.toHaveBeenCalled()
  })

  it('shows 「更新しました」 only on the first launch after an update, not on the very first launch, and it disappears when closed', () => {
    const first = harness()
    first.service.start()
    expect(first.service.status().justUpdated).toBeNull()

    const settings = new MemorySettings()
    settings.writeTyped(UPDATE_LAST_RUN_VERSION, '0.27.0')
    const h = harness({}, settings)
    h.service.start()
    expect(h.service.status().justUpdated).toEqual({ from: '0.27.0', to: '0.28.0' })
    expect(settings.readTyped(UPDATE_LAST_RUN_VERSION)).toBe('0.28.0')
    expect(h.service.dismissNotice().justUpdated).toBeNull()
  })

  it('auto-update ON: checks 2 minutes after startup and places the new version (the swap is at exit)', async () => {
    const h = harness()
    h.service.start()
    h.tick()
    expect(h.latestTag).not.toHaveBeenCalled()
    h.advance(FIRST_CHECK_DELAY_MS)
    h.tick()
    await h.settle()
    expect(h.stage).toHaveBeenCalledWith('v0.29.0', '0.29.0')
    expect(h.service.status()).toMatchObject({ phase: 'staged', staged: '0.29.0', latest: '0.29.0' })
    expect(h.prune).toHaveBeenCalledWith(['0.28.0', '0.29.0', '0.28.0'])
    expect(h.swap).not.toHaveBeenCalled()
    // The next check is 6 hours later
    h.latestTag.mockClear()
    h.advance(CHECK_INTERVAL_MS - 1)
    h.tick()
    expect(h.latestTag).not.toHaveBeenCalled()
    h.advance(1)
    h.tick()
    expect(h.latestTag).toHaveBeenCalledTimes(1)
    await h.settle()
    // Swap at quit
    h.service.applyAtQuit()
    expect(h.swap).toHaveBeenCalledWith('0.29.0')
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('does not fetch the same version or an older version (downgrade)', async () => {
    const h = harness({ latestTag: async () => 'v0.28.0' })
    h.service.start()
    await h.service.check()
    expect(h.service.status().phase).toBe('up-to-date')
    const older = harness({ latestTag: async () => 'v0.27.5' })
    older.service.start()
    await older.service.check()
    expect(older.service.status()).toMatchObject({ phase: 'up-to-date', latest: '0.27.5', staged: null })
    expect(older.stage).not.toHaveBeenCalled()
  })

  it('auto-update OFF: does not check on the tick, 「更新を確認」 goes only to available, and 「入れる」 places it', async () => {
    const settings = new MemorySettings()
    settings.writeTyped(UPDATE_AUTO, false)
    const h = harness({}, settings)
    h.service.start()
    h.advance(FIRST_CHECK_DELAY_MS * 10)
    h.tick()
    expect(h.latestTag).not.toHaveBeenCalled()
    await h.service.check()
    expect(h.service.status()).toMatchObject({ phase: 'available', latest: '0.29.0', auto: false })
    expect(h.stage).not.toHaveBeenCalled()
    await h.service.install()
    expect(h.service.status()).toMatchObject({ phase: 'staged', staged: '0.29.0' })
    // With OFF, no restart even when idle
    h.setIdle(IDLE_RESTART_SECONDS * 2)
    h.tick()
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('code-review: does not install a version at or below hold (the version restored with install-temoto.sh) and is held, and resumes when a newer version appears', async () => {
    let hold: string | null = '0.29.0'
    let latest = 'v0.29.0'
    const h = harness({ heldVersion: () => hold, latestTag: async () => latest })
    h.service.start()
    expect(h.service.status().held).toBe('0.29.0')
    await h.service.check()
    expect(h.stage).not.toHaveBeenCalled()
    expect(h.service.status()).toMatchObject({ phase: 'held', latest: '0.29.0', held: '0.29.0', staged: null })
    // Install does not get past the hold either (the check is run again and it stays held)
    await h.service.install()
    expect(h.stage).not.toHaveBeenCalled()
    // Resume when a version newer than the hold appears
    latest = 'v0.30.0'
    await h.service.check()
    expect(h.stage).toHaveBeenCalledWith('v0.30.0', '0.30.0')
    expect(h.service.status()).toMatchObject({ phase: 'staged', staged: '0.30.0' })
    // When hold is removed from install.json, it also disappears from the state (re-read at each check)
    hold = null
    await h.service.check()
    expect(h.service.status().held).toBeNull()
  })

  it('code-review: pressing 「入れる」 during a check waits for the check and then places (install does not silently fail)', async () => {
    const settings = new MemorySettings()
    settings.writeTyped(UPDATE_AUTO, false)
    let release: (tag: string) => void = () => undefined
    const h = harness({ latestTag: () => new Promise<string>((resolve) => (release = resolve)) }, settings)
    h.service.start()
    const checking = h.service.check()
    const installing = h.service.install()
    release('v0.29.0')
    await checking
    await installing
    expect(h.stage).toHaveBeenCalledWith('v0.29.0', '0.29.0')
    expect(h.service.status()).toMatchObject({ phase: 'staged', staged: '0.29.0' })
  })

  it('code-review: 「入れる」 during a check places nothing unless the result is a newer version', async () => {
    const settings = new MemorySettings()
    settings.writeTyped(UPDATE_AUTO, false)
    let release: (tag: string) => void = () => undefined
    const h = harness({ latestTag: () => new Promise<string>((resolve) => (release = resolve)) }, settings)
    h.service.start()
    const checking = h.service.check()
    const installing = h.service.install()
    release('v0.28.0')
    await checking
    await installing
    expect(h.stage).not.toHaveBeenCalled()
    expect(h.service.status().phase).toBe('up-to-date')
  })

  it('when idle (untouched for 10 minutes and nothing to stop), swaps and restarts', async () => {
    const h = harness()
    h.service.start()
    await h.service.check()
    expect(h.service.status().staged).toBe('0.29.0')
    h.setIdle(IDLE_RESTART_SECONDS - 1)
    h.tick()
    expect(h.relaunch).not.toHaveBeenCalled()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.setBlocker('session')
    h.tick()
    expect(h.relaunch).not.toHaveBeenCalled()
    h.setBlocker(null)
    h.tick()
    expect(h.swap).toHaveBeenCalledWith('0.29.0')
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
    expect(h.ticking).toBe(false)
  })

  it('TODO 1050: the real-directory form (deferSwap) does not swap before the restart, and the swap happens during exit', async () => {
    const h = harness({ deferSwap: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
    expect(h.swap).not.toHaveBeenCalled()
    h.service.applyAtQuit()
    expect(h.swap).toHaveBeenCalledWith('0.29.0')
  })

  it('TODO 606: 「再起動して更新」 first checks drafts, and if canceled neither swaps nor restarts', async () => {
    let answer = false
    const confirmRestart = vi.fn(async () => answer)
    const restartAborted = vi.fn()
    const h = harness({ confirmRestart, restartAborted })
    h.service.start()
    await h.service.check()
    await h.service.restartNow()
    expect(confirmRestart).toHaveBeenCalledTimes(1)
    expect(h.swap).not.toHaveBeenCalled()
    expect(h.relaunch).not.toHaveBeenCalled()
    // If it passes, swap and restart
    answer = true
    await h.service.restartNow()
    expect(h.swap).toHaveBeenCalledWith('0.29.0')
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
    expect(restartAborted).not.toHaveBeenCalled()
  })

  it('TODO 967: a restart other than an update relaunches with the installed version if there is one (otherwise false and leaves it to the caller)', async () => {
    const h = harness()
    h.service.start()
    expect(h.service.relaunchIntoStaged()).toBe(false)
    expect(h.relaunch).not.toHaveBeenCalled()
    await h.service.check()
    expect(h.service.relaunchIntoStaged()).toBe(true)
    expect(h.swap).toHaveBeenCalledWith('0.29.0')
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
    // A second run does not happen (during the restart)
    expect(h.service.relaunchIntoStaged()).toBe(false)
    expect(h.relaunch).toHaveBeenCalledTimes(1)
  })

  it('TODO 606: when the swap fails after the check passed, restores the check\'s "done"', async () => {
    const restartAborted = vi.fn()
    const h = harness({
      confirmRestart: async () => true,
      restartAborted,
      swapLink: () => {
        throw new Error('EACCES')
      }
    })
    h.service.start()
    await h.service.check()
    await h.service.restartNow()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(restartAborted).toHaveBeenCalledTimes(1)
  })

  it('TODO 1277: afterSwap is called after the swap, and the update continues even if it throws', async () => {
    const order: string[] = []
    const swapLink = vi.fn(() => {
      order.push('swap')
    })
    const afterSwap = vi.fn(() => {
      order.push('after')
      throw new Error('login item failed')
    })
    const h = harness({ swapLink, afterSwap })
    h.service.start()
    await h.service.check()
    h.service.applyAtQuit()
    expect(order).toEqual(['swap', 'after'])
    expect(afterSwap).toHaveBeenCalledWith('0.29.0')
    expect(h.service.status().phase).not.toBe('failed')
  })

  it('TODO 1277: afterSwap is not called when the swap fails', async () => {
    const afterSwap = vi.fn()
    const h = harness({
      swapLink: () => {
        throw new Error('EACCES')
      },
      afterSwap
    })
    h.service.start()
    await h.service.check()
    h.service.applyAtQuit()
    expect(afterSwap).not.toHaveBeenCalled()
  })

  it('TODO 1133: when the swap of an idle restart fails, does not retry on every tick for the same version', async () => {
    const swapLink = vi.fn(() => {
      throw new Error('EACCES')
    })
    const h = harness({ swapLink })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS + 1)
    h.tick()
    h.tick()
    h.tick()
    expect(swapLink).toHaveBeenCalledTimes(1)
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('at startup, if the symlink target is newer than the current one, treats it as the installed version (died before the swap, or by other means)', () => {
    const h = harness()
    h.setLinked('0.29.0')
    h.service.start()
    expect(h.service.status()).toMatchObject({ phase: 'staged', staged: '0.29.0' })
    // Already swapped, so nothing happens at quit
    h.service.applyAtQuit()
    expect(h.swap).not.toHaveBeenCalled()
  })

  it('if the user put the symlink back to the previous version, does not overwrite it at exit', async () => {
    const h = harness()
    h.service.start()
    await h.service.check()
    h.setLinked('0.30.0')
    h.service.applyAtQuit()
    expect(h.swap).not.toHaveBeenCalled()
  })

  it('failures are carried in the state as reason codes (not thrown as exceptions)', async () => {
    const h = harness({ latestTag: async () => Promise.reject(reasonError('update-gh-auth')) })
    h.service.start()
    await h.service.check()
    expect(h.service.status()).toMatchObject({ phase: 'failed', failure: 'update-gh-auth' })
    const s = harness({ stage: async () => Promise.reject(new Error('boom')) })
    s.service.start()
    await s.service.check()
    expect(s.service.status()).toMatchObject({ phase: 'failed', failure: 'update-download-failed', staged: null })
  })

  it('when turned back ON, checks right away if it has not been checked yet, and writes to the settings', async () => {
    const settings = new MemorySettings()
    settings.writeTyped(UPDATE_AUTO, false)
    const h = harness({}, settings)
    h.service.start()
    h.service.setAuto(true)
    await h.settle()
    expect(settings.readTyped(UPDATE_AUTO)).toBe(true)
    expect(h.latestTag).toHaveBeenCalledTimes(1)
    expect(h.statuses.at(-1)?.auto).toBe(true)
  })

  // TODO 751: when checks kept failing, `gh` used to be called every minute (`TICK_MS`)
  describe('check failures and the retry interval (TODO 751)', () => {
    it('even if latestTag keeps throwing, advancing the tick 10 times calls latestTag only once', async () => {
      const h = harness()
      h.latestTag.mockRejectedValue(reasonError('update-check-failed'))
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)
      expect(h.service.status()).toMatchObject({ phase: 'failed', failure: 'update-check-failed', checkedAt: null })

      h.latestTag.mockClear()
      for (let i = 0; i < 10; i += 1) {
        h.advance(TICK_MS)
        h.tick()
        await h.settle()
      }
      expect(h.latestTag).not.toHaveBeenCalled()
    })

    it('a timeout or being offline (update-check-failed) grows by doubling from 15 minutes', async () => {
      const h = harness()
      h.latestTag.mockRejectedValue(reasonError('update-check-failed'))
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)

      // After the first failure: not called before 15 minutes, called at 15 minutes
      h.latestTag.mockClear()
      h.advance(CHECK_RETRY_BASE_MS - 1)
      h.tick()
      expect(h.latestTag).not.toHaveBeenCalled()
      h.advance(1)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)

      // After the second failure: double, 30 minutes
      h.latestTag.mockClear()
      h.advance(CHECK_RETRY_BASE_MS * 2 - 1)
      h.tick()
      expect(h.latestTag).not.toHaveBeenCalled()
      h.advance(1)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)
    })

    it('the growth stops at 6 hours (CHECK_INTERVAL_MS)', async () => {
      const h = harness()
      h.latestTag.mockRejectedValue(reasonError('update-check-failed'))
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      // Fail many times in a row and check that the interval, though it grows exponentially, stops at the cap
      for (let i = 0; i < 8; i += 1) {
        h.latestTag.mockClear()
        h.advance(CHECK_INTERVAL_MS)
        h.tick()
        await h.settle()
        expect(h.latestTag).toHaveBeenCalledTimes(1)
      }
    })

    it('gh missing or login required is fixed at 6 hours right from the first failure (not doubled)', async () => {
      const h = harness()
      h.latestTag.mockRejectedValue(reasonError('update-gh-missing'))
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)

      h.latestTag.mockClear()
      h.advance(CHECK_RETRY_BASE_MS)
      h.tick()
      // Not called at 15 minutes (unlike a timeout or being offline)
      expect(h.latestTag).not.toHaveBeenCalled()
      h.advance(CHECK_INTERVAL_MS - CHECK_RETRY_BASE_MS - 1)
      h.tick()
      expect(h.latestTag).not.toHaveBeenCalled()
      h.advance(1)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)
    })

    it('on success it returns to the normal 6 hours from then on, and checkedAt stays at the time of the success', async () => {
      let fail = true
      const h = harness()
      h.latestTag.mockImplementation(async () => {
        if (fail) throw reasonError('update-check-failed')
        return 'v0.28.0'
      })
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      expect(h.service.status().checkedAt).toBeNull()

      fail = false
      h.advance(CHECK_RETRY_BASE_MS)
      h.tick()
      await h.settle()
      expect(h.service.status()).toMatchObject({ phase: 'up-to-date', checkedAt: expect.any(Number) })

      h.latestTag.mockClear()
      h.advance(CHECK_INTERVAL_MS - 1)
      h.tick()
      expect(h.latestTag).not.toHaveBeenCalled()
      h.advance(1)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)
    })

    it('the 「更新を確認」 button (calling check directly) runs right away without waiting for the interval', async () => {
      const h = harness()
      h.latestTag.mockRejectedValue(reasonError('update-check-failed'))
      h.service.start()
      h.advance(FIRST_CHECK_DELAY_MS)
      h.tick()
      await h.settle()
      expect(h.latestTag).toHaveBeenCalledTimes(1)
      await h.service.check().catch(() => undefined)
      expect(h.latestTag).toHaveBeenCalledTimes(2)
    })
  })
})

describe('TODO 1333: why an installed version waits, the background-shell grace, and carrying drafts over the idle restart', () => {
  it('shows the blocker as the waiting reason (a conversation, a reservation, a running !), then the Mac being in use, and clears it on restart', async () => {
    const h = harness()
    h.service.start()
    await h.service.check()
    expect(h.service.status().staged).toBe('0.29.0')
    h.setIdle(0)
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-input')
    h.setBlocker('session')
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-session')
    h.setBlocker('queue')
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-queue')
    h.setBlocker('shell')
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-shell')
    // Pushed to the windows only when it changes
    const pushed = h.statuses.filter((status) => status.waiting === 'update-wait-shell').length
    h.tick()
    expect(h.statuses.filter((status) => status.waiting === 'update-wait-shell').length).toBe(pushed)
    h.setBlocker(null)
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    expect(h.service.status().waiting).toBeNull()
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('no waiting reason when auto-update is OFF or nothing is installed', async () => {
    const h = harness()
    h.service.start()
    h.setIdle(0)
    h.tick()
    expect(h.service.status().waiting).toBeNull()
    await h.service.check()
    h.service.setAuto(false)
    expect(h.service.status().waiting).toBeNull()
  })

  it('background shells stop holding the restart one hour after the version was installed (counted from the persisted time); nothing else is relaxed', async () => {
    const h = harness()
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.setBlocker('session')
    h.tick()
    expect(h.blockerCalls.at(-1)).toBe(false)
    h.advance(BACKGROUND_SHELL_GRACE_MS - 1)
    h.tick()
    expect(h.blockerCalls.at(-1)).toBe(false)
    h.advance(1)
    h.tick()
    expect(h.blockerCalls.at(-1)).toBe(true)
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('the installed time survives a restart of the app (same version), and a different installed version starts counting again', async () => {
    const settings = new MemorySettings()
    const first = harness({}, settings)
    first.service.start()
    await first.service.check()
    const at = first.service.status().stagedAt
    expect(at).not.toBeNull()
    expect(settings.readTyped(UPDATE_STAGED_AT)).toEqual({ version: '0.29.0', at })
    // The app restarts (e.g. crashed) with the version already placed: the link is newer than the running version
    const second = harness({}, settings)
    second.setLinked('0.29.0')
    second.advance(30 * 60_000)
    second.service.start()
    expect(second.service.status().stagedAt).toBe(at)
    // A newer version placed later: counted from its own installation
    const third = harness({}, settings)
    third.setLinked('0.30.0')
    third.advance(2 * 60 * 60_000)
    third.service.start()
    expect(third.service.status().stagedAt).toBe(1_000_000 + 2 * 60 * 60_000)
  })

  it('carries the Composer text right before the idle restart, and restarts only after it said yes', async () => {
    const order: string[] = []
    const carryDrafts = vi.fn(async () => {
      order.push('carry')
      return true
    })
    const h = harness({ carryDrafts, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    expect(h.relaunch).not.toHaveBeenCalled()
    await h.settle()
    expect(order).toEqual(['carry'])
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('a viewer\'s unsaved draft holds the restart before anything is collected or written, with its own reason', async () => {
    const carryDrafts = vi.fn(async () => true)
    const h = harness({ carryDrafts, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.setBlocker('viewer-draft')
    h.tick()
    await h.settle()
    expect(carryDrafts).not.toHaveBeenCalled()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(h.service.status().waiting).toBe('update-wait-viewer-draft')
  })

  it('a viewer draft that appears after the Composer text was stored cancels the restart and discards the stored copy', async () => {
    const discardCarried = vi.fn()
    const setBlocker: { current: (value: string | null) => void } = { current: () => undefined }
    const carryDrafts = vi.fn(async () => {
      setBlocker.current('viewer-draft')
      return true
    })
    const h = harness({ carryDrafts, discardCarried, hasDrafts: () => true })
    setBlocker.current = h.setBlocker
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
  })

  it('a draft that cannot be carried keeps the restart waiting with the draft reason, and it is tried again on the next tick', async () => {
    let carried = false
    const carryDrafts = vi.fn(async () => carried)
    const h = harness({ carryDrafts, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(h.service.status().waiting).toBe('update-wait-draft')
    carried = true
    h.tick()
    await h.settle()
    expect(carryDrafts).toHaveBeenCalledTimes(2)
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('if the user comes back while the drafts were being carried, the stored copy is discarded and nothing restarts', async () => {
    let resolveCarry: (value: boolean) => void = () => undefined
    const carryDrafts = vi.fn(() => new Promise<boolean>((resolve) => (resolveCarry = resolve)))
    const discardCarried = vi.fn()
    const h = harness({ carryDrafts, discardCarried, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    h.tick() // the second tick does not start a second collection
    expect(carryDrafts).toHaveBeenCalledTimes(1)
    h.setIdle(5)
    resolveCarry(true)
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
  })

  it('a failed swap of an idle restart discards the stored drafts', async () => {
    const discardCarried = vi.fn()
    const restartAborted = vi.fn()
    const swapLink = vi.fn(() => {
      throw new Error('EACCES')
    })
    const h = harness({ swapLink, carryDrafts: async () => true, discardCarried, restartAborted })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
    expect(restartAborted).not.toHaveBeenCalled()
  })

  it('"Restart to Update" is unchanged: it does not carry drafts and does not look at the blocker', async () => {
    const carryDrafts = vi.fn(async () => true)
    const h = harness({ carryDrafts })
    h.service.start()
    await h.service.check()
    h.setBlocker('session')
    await h.service.restartNow()
    expect(carryDrafts).not.toHaveBeenCalled()
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })
})

describe('wave 105 review: the waiting reason and cancelling an idle restart', () => {
  it('the waiting reason is worked out while a check is running or the carrying is in progress (no early return before it)', async () => {
    let resolveCarry: (value: boolean) => void = () => undefined
    const carryDrafts = vi.fn(() => new Promise<boolean>((resolve) => (resolveCarry = resolve)))
    const h = harness({ carryDrafts, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(0)
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-input')
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick() // starts carrying
    h.setBlocker('queue')
    h.tick() // carrying in progress: the reason still follows
    expect(h.service.status().waiting).toBe('update-wait-queue')
    resolveCarry(true)
    await h.settle()
  })

  it('a version whose swap failed shows its own waiting reason for the rest of the launch', async () => {
    const swapLink = vi.fn(() => {
      throw new Error('EACCES')
    })
    const h = harness({ swapLink })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    h.tick()
    expect(h.service.status().waiting).toBe('update-wait-apply-failed')
    expect(swapLink).toHaveBeenCalledTimes(1)
  })

  it('arms the quit before the restart and disarms it when the swap fails', async () => {
    const order: string[] = []
    const swapLink = vi.fn(() => {
      throw new Error('EACCES')
    })
    const h = harness({
      swapLink,
      armIdleRestart: () => order.push('arm'),
      disarmIdleRestart: () => order.push('disarm')
    })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(order).toEqual(['arm', 'disarm'])
  })

  it('an idle restart whose quit was called off makes the service live again, drops the stored drafts, and can try again', async () => {
    const discardCarried = vi.fn()
    const h = harness({ deferSwap: () => true, discardCarried })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    expect(h.relaunch).toHaveBeenCalledTimes(1)
    expect(h.ticking).toBe(false)
    h.service.cancelIdleRestart()
    expect(h.ticking).toBe(true)
    expect(discardCarried).toHaveBeenCalledTimes(1)
    h.tick()
    expect(h.relaunch).toHaveBeenCalledTimes(2)
  })
})

describe('TODO 1337: stopped reservations are carried over the idle restart', () => {
  it('a stopped reservation that cannot be carried holds the restart with its own reason, before anything is written', async () => {
    const carryDrafts = vi.fn(async () => true)
    const carryReservations = vi.fn(() => true)
    const h = harness({ carryDrafts, carryReservations, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.setBlocker('queue-uncarriable')
    h.tick()
    await h.settle()
    expect(h.service.status().waiting).toBe('update-wait-queue-uncarriable')
    expect(carryDrafts).not.toHaveBeenCalled()
    expect(carryReservations).not.toHaveBeenCalled()
    expect(h.relaunch).not.toHaveBeenCalled()
    // Not dropped after a while: an hour later it still holds.
    h.advance(BACKGROUND_SHELL_GRACE_MS + 1)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('carries the drafts, then the reservations right after the last check, then restarts', async () => {
    const order: string[] = []
    const carryDrafts = vi.fn(async () => {
      order.push('drafts')
      return true
    })
    const carryReservations = vi.fn(() => {
      order.push('reservations')
      return true
    })
    const relaunch = vi.fn(() => {
      order.push('relaunch')
    })
    const h = harness({ carryDrafts, carryReservations, relaunch, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(order).toEqual(['drafts', 'reservations', 'relaunch'])
  })

  it('carries the reservations also when there is no draft step', async () => {
    const carryReservations = vi.fn(() => true)
    const h = harness({ carryReservations })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    expect(carryReservations).toHaveBeenCalledTimes(1)
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('if the reservations cannot be written after the drafts were, nothing restarts and both copies are removed (never one without the other)', async () => {
    const discardCarried = vi.fn()
    let reservationsOk = false
    const carryReservations = vi.fn(() => reservationsOk)
    const h = harness({ carryDrafts: async () => true, carryReservations, discardCarried, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
    expect(h.service.status().waiting).toBe('update-wait-queue-uncarriable')
    // The next tick tries again.
    reservationsOk = true
    h.tick()
    await h.settle()
    expect(carryReservations).toHaveBeenCalledTimes(2)
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('if the drafts cannot be carried, the reservations are not written at all', async () => {
    const carryReservations = vi.fn(() => true)
    const h = harness({ carryDrafts: async () => false, carryReservations, hasDrafts: () => true })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(carryReservations).not.toHaveBeenCalled()
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('a reservation that starts moving while the drafts are collected cancels the restart before the reservations are written', async () => {
    const setBlocker: { current: (value: string | null) => void } = { current: () => undefined }
    const carryDrafts = vi.fn(async () => {
      setBlocker.current('queue')
      return true
    })
    const carryReservations = vi.fn(() => true)
    const discardCarried = vi.fn()
    const h = harness({ carryDrafts, carryReservations, discardCarried, hasDrafts: () => true })
    setBlocker.current = h.setBlocker
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(carryReservations).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
    expect(h.relaunch).not.toHaveBeenCalled()
  })

  it('"Restart to Update" does not carry reservations (unchanged)', async () => {
    const carryReservations = vi.fn(() => true)
    const h = harness({ carryReservations })
    h.service.start()
    await h.service.check()
    await h.service.restartNow()
    expect(carryReservations).not.toHaveBeenCalled()
    expect(h.relaunch).toHaveBeenCalledWith('0.29.0')
  })

  it('wave 106 review Z2: the carrying cannot be left unwired (required in the deps and the wiring, checked by the compiler)', () => {
    // `restartBlocker` lets carriable stopped reservations through, so a restart without the carrying would lose them silently.
    expectTypeOf<UpdateServiceDeps['carryReservations']>().toEqualTypeOf<() => boolean>()
    expectTypeOf<UpdateWiring['carriedReservations']>().not.toBeNullable()
    expectTypeOf<UpdateWiring['carriedReservations']>().toHaveProperty('carry')
  })

  it('wave 106 review Z2: a carry that says no holds the restart and removes what was written for it', async () => {
    const discardCarried = vi.fn()
    const h = harness({ carryReservations: () => false, discardCarried })
    h.service.start()
    await h.service.check()
    h.setIdle(IDLE_RESTART_SECONDS)
    h.tick()
    await h.settle()
    expect(h.relaunch).not.toHaveBeenCalled()
    expect(discardCarried).toHaveBeenCalledTimes(1)
    expect(h.service.status().waiting).toBe('update-wait-queue-uncarriable')
  })
})
