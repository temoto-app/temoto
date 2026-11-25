// TODO 103 stage 1 (wave 28 bundle G): run install-temoto.sh's per-version directories and symlink switch for real, in a temporary directory.
// gh / codesign / osascript / open are fakes placed first on PATH (they are neither on the network nor in the real ~/Applications).
// ditto / shasum / PlistBuddy use the real macOS tools, so this runs only on macOS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseInstallManifest } from '../src/main/update/layout.js'

const script = new URL('../scripts/install-temoto.sh', import.meta.url).pathname

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`
}

function makeApp(dir: string, version: string): string {
  const app = join(dir, 'Temoto.app')
  mkdirSync(join(app, 'Contents', 'Resources', 'app'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist(version))
  return app
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('install-temoto.sh per-version directories (TODO 103 / 1050)', () => {
  let dir: string
  let releases: string
  let appLink: string
  let root: string
  let ghLog: string

  function publish(version: string): void {
    const tagDir = join(releases, `v${version}`)
    const build = join(tagDir, 'build')
    mkdirSync(build, { recursive: true })
    makeApp(build, version)
    const zip = `Temoto-${version}-arm64-mac.zip`
    execFileSync('ditto', ['-c', '-k', '--keepParent', join(build, 'Temoto.app'), join(tagDir, zip)])
    writeFileSync(join(tagDir, 'install-backend.sh'), '#!/bin/bash\nexit 0\n')
    const sum = (name: string): string => createHash('sha256').update(readFileSync(join(tagDir, name))).digest('hex')
    writeFileSync(join(tagDir, 'SHA256SUMS'), `${sum(zip)}  ${zip}\n${sum('install-backend.sh')}  install-backend.sh\n`)
    writeFileSync(join(releases, 'latest'), `v${version}\n`)
  }

  function install(...rest: Array<string | Record<string, string>>): { code: number; out: string } {
    const args = rest.filter((arg): arg is string => typeof arg === 'string')
    const env = Object.assign({}, ...rest.filter((arg): arg is Record<string, string> => typeof arg !== 'string'))
    const result = spawnSync('bash', [script, '--no-launch', '--yes', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        HOME: join(dir, 'home'),
        // The assertions below read the Japanese messages; the English default is covered by install-script-language.test.ts.
        LC_ALL: '',
        LC_MESSAGES: '',
        LANG: 'ja_JP.UTF-8',
        AIOS_APP: appLink,
        AIOS_INSTALL_ROOT: root,
        AIOS_REPO: 'owner/repo',
        FAKE_RELEASES: releases,
        FAKE_GH_LOG: ghLog,
        FAKE_CURL_LOG: join(dir, 'curl.log'),
        ...env
      }
    })
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
  }

  const versionsOnDisk = (): string[] => readdirSync(join(root, 'versions')).filter((n) => !n.startsWith('.')).sort()

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-install-')))
    releases = join(dir, 'releases')
    appLink = join(dir, 'Applications', 'Temoto.app')
    root = join(dir, 'root')
    ghLog = join(dir, 'gh.log')
    mkdirSync(join(dir, 'bin'))
    mkdirSync(releases)
    const shim = (name: string, body: string): void => {
      writeFileSync(join(dir, 'bin', name), `#!/bin/bash\n${body}\n`)
      chmodSync(join(dir, 'bin', name), 0o755)
    }
    shim(
      'gh',
      [
        'echo "$*" >> "$FAKE_GH_LOG"',
        'case "$1 $2" in',
        '  "auth status") [ -n "$FAKE_GH_LOGGED_OUT" ] && exit 1; exit 0 ;;',
        '  "release view") cat "$FAKE_RELEASES/latest"; exit 0 ;;',
        '  "release download")',
        '    tag="$3"; shift 3; dest=""; pats=()',
        '    while [ $# -gt 0 ]; do case "$1" in -D) dest="$2"; shift ;; -p) pats+=("$2"); shift ;; esac; shift; done',
        '    for p in "${pats[@]}"; do cp "$FAKE_RELEASES/$tag/$p" "$dest/" || exit 1; done',
        '    exit 0 ;;',
        'esac',
        'exit 1'
      ].join('\n')
    )
    // TODO 1263: without gh, the public repo's Release is fetched with curl (the API for the latest tag, the download URL for each asset)
    shim(
      'curl',
      [
        'out=""; url=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -H|--connect-timeout|--retry|--proto|--proto-redir) shift ;; -*) ;; *) url="$1" ;; esac; shift; done',
        'echo "$url" >> "$FAKE_CURL_LOG"',
        'case "$url" in',
        '  https://api.github.com/repos/temoto-app/temoto/releases/latest) printf \'{"tag_name":"%s"}\' "$(cat "$FAKE_RELEASES/latest")" ;;',
        '  https://github.com/temoto-app/temoto/releases/download/*) cp "$FAKE_RELEASES/${url#https://github.com/temoto-app/temoto/releases/download/}" "$out" || exit 22 ;;',
        '  *) exit 22 ;;',
        'esac'
      ].join('\n')
    )
    shim('codesign', 'if [ "$1" = "--verify" ]; then exit 0; fi\necho "Identifier=io.github.temoto-app.temoto" >&2')
    shim('osascript', 'exit 0')
    shim('open', 'exit 0')
    // 0.27.0, in the form an old install-temoto.sh left behind (a real directory)
    mkdirSync(join(dir, 'Applications'))
    makeApp(join(dir, 'Applications'), '0.27.0')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const isRealBundle = (path: string): boolean => lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()
  const versionOf = (path: string): string =>
    /<key>CFBundleShortVersionString<\/key><string>([^<]+)<\/string>/.exec(
      readFileSync(join(path, 'Contents', 'Info.plist'), 'utf8')
    )?.[1] ?? ''

  it('TODO 1050: installing 0.28.0 over a real 0.27.0 makes the real copy the new version, and the old version moves into versions', () => {
    publish('0.28.0')
    const result = install()
    expect(result.code, result.out).toBe(0)
    expect(isRealBundle(appLink)).toBe(true)
    expect(versionOf(appLink)).toBe('0.28.0')
    // The installed version's directory does not remain; only the displaced version is in versions
    expect(versionsOnDisk()).toEqual(['0.27.0'])
    expect(existsSync(join(root, 'versions', '0.27.0', 'Temoto.app', 'Contents', 'Info.plist'))).toBe(true)
    // The copy that aios's auto-update reads
    expect(parseInstallManifest(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual({ link: appLink, repo: 'owner/repo' })
    // No half-done staging directory remains
    expect(readdirSync(join(root, 'versions')).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('TODO 1050: the 103 symlink form is replaced with a real copy without taking it (done in one go); the second time is 「既に入っている」', () => {
    const linkApp = join(dir, 'linked', 'Applications', 'Temoto.app')
    const linkRoot = join(dir, 'linked', 'root')
    mkdirSync(join(dir, 'linked', 'Applications'), { recursive: true })
    const staged = makeApp(join(linkRoot, 'versions', '0.28.0'), '0.28.0')
    symlinkSync(staged, linkApp)
    writeFileSync(ghLog, '')
    const result = install({ AIOS_APP: linkApp, AIOS_INSTALL_ROOT: linkRoot })
    expect(result.code, result.out).toBe(0)
    expect(isRealBundle(linkApp)).toBe(true)
    expect(versionOf(linkApp)).toBe('0.28.0')
    expect(existsSync(join(linkRoot, 'versions', '0.28.0'))).toBe(false)
    expect(parseInstallManifest(readFileSync(join(linkRoot, 'install.json'), 'utf8'))).toEqual({
      link: linkApp,
      repo: 'owner/repo'
    })
    // Downloads nothing
    expect(readFileSync(ghLog, 'utf8')).not.toContain('release download')
    const again = install({ AIOS_APP: linkApp, AIOS_INSTALL_ROOT: linkRoot })
    expect(again.code, again.out).toBe(0)
    expect(again.out).toContain('既に 0.28.0')
  })

  it('TODO 1050: installing a new version from the symlink form detaches the symlink and makes a real copy, and the previous version stays in versions', () => {
    const linkApp = join(dir, 'linked2', 'Applications', 'Temoto.app')
    const linkRoot = join(dir, 'linked2', 'root')
    mkdirSync(join(dir, 'linked2', 'Applications'), { recursive: true })
    symlinkSync(makeApp(join(linkRoot, 'versions', '0.27.0'), '0.27.0'), linkApp)
    const result = install({ AIOS_APP: linkApp, AIOS_INSTALL_ROOT: linkRoot })
    expect(result.code, result.out).toBe(0)
    expect(isRealBundle(linkApp)).toBe(true)
    expect(versionOf(linkApp)).toBe('0.28.0')
    expect(readdirSync(join(linkRoot, 'versions')).sort()).toEqual(['0.27.0'])
  })

  it('review 57-9: even when writing the record in the 「既に入っている」 case, it is JSON with " and \\ in the path escaped', () => {
    const tag = readFileSync(join(releases, 'latest'), 'utf8').trim().replace(/^v/, '')
    const oddRoot = join(dir, 'odd-root')
    const oddApps = join(dir, 'odd "q" \\b')
    mkdirSync(oddApps, { recursive: true })
    makeApp(oddApps, tag)
    const oddApp = join(oddApps, 'Temoto.app')
    const result = install({ AIOS_APP: oddApp, AIOS_INSTALL_ROOT: oddRoot })
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain(`既に ${tag}`)
    const manifest = parseInstallManifest(readFileSync(join(oddRoot, 'install.json'), 'utf8'))
    expect(manifest).toEqual({ link: oddApp, repo: 'owner/repo' })
  })

  it('review 57-10: if AIOS_INSTALL_ROOT is not the default, install-root is placed in the default root; if it is the default root, it is removed', () => {
    // TODO 1263: a HOME with no legacy userData takes the new data name (Temoto)
    const pointer = join(dir, 'home', '.local', 'share', 'Temoto', 'install-root')
    expect(install().code).toBe(0)
    expect(readFileSync(pointer, 'utf8')).toBe(`${root}\n`)
    const defaultRoot = join(dir, 'home', '.local', 'share', 'Temoto')
    const result = install({ AIOS_INSTALL_ROOT: defaultRoot })
    expect(result.code, result.out).toBe(0)
    expect(existsSync(pointer)).toBe(false)
    expect(existsSync(join(defaultRoot, 'install.json'))).toBe(true)
  })

  it('does nothing if the same version is installed', () => {
    const result = install()
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('既に 0.28.0')
  })

  it('puts the new version in place and keeps up to 2 versions including the installed one (1 in versions)', () => {
    publish('0.29.0')
    expect(install().code).toBe(0)
    publish('0.30.0')
    const result = install()
    expect(result.code, result.out).toBe(0)
    expect(versionOf(appLink)).toBe('0.30.0')
    expect(versionsOnDisk()).toEqual(['0.29.0'])
  })

  it("when going back to a previous version with --version, uses the remaining version's directory and does not fetch the zip", () => {
    writeFileSync(ghLog, '')
    const result = install('--version', 'v0.29.0')
    expect(result.code, result.out).toBe(0)
    expect(versionOf(appLink)).toBe('0.29.0')
    const downloads = readFileSync(ghLog, 'utf8').split('\n').filter((line) => line.startsWith('release download'))
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).not.toContain('.zip')
    // 0.30.0, from before the rollback, moved into versions
    expect(versionsOnDisk()).toEqual(['0.30.0'])
  })

  it('code-review: going back to an old version with --version writes the version before the rollback to hold (even if rolled back further, the newer one is kept)', () => {
    const manifest = (): unknown => parseInstallManifest(readFileSync(join(root, 'install.json'), 'utf8'))
    // The previous test rolled 0.30.0 back to 0.29.0
    expect(manifest()).toEqual({ link: appLink, repo: 'owner/repo', hold: '0.30.0' })
    expect(install('--version', 'v0.28.0').code).toBe(0)
    expect(manifest()).toEqual({ link: appLink, repo: 'owner/repo', hold: '0.30.0' })
    // Moving forward to a version older than the hold keeps the hold
    const result = install('--version', 'v0.29.0')
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('保留')
    expect(manifest()).toEqual({ link: appLink, repo: 'owner/repo', hold: '0.30.0' })
    expect(versionOf(appLink)).toBe('0.29.0')
  })

  it('if SHA-256 does not match, nothing is placed and Temoto.app is not replaced', () => {
    publish('0.31.0')
    writeFileSync(join(releases, 'v0.31.0', 'SHA256SUMS'), `${'0'.repeat(64)}  Temoto-0.31.0-arm64-mac.zip\n`)
    const result = install()
    expect(result.code).not.toBe(0)
    expect(versionOf(appLink)).toBe('0.29.0')
    expect(versionsOnDisk()).toEqual(['0.30.0'])
  })

  it('code-review: installing without --version (latest) clears hold', () => {
    publish('0.31.0')
    const result = install()
    expect(result.code, result.out).toBe(0)
    expect(versionOf(appLink)).toBe('0.31.0')
    expect(parseInstallManifest(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual({
      link: appLink,
      repo: 'owner/repo'
    })
  })

  it("TODO 1263: without gh (not logged in), fetches the public repo's Release with curl; the SHA-256 and signature checks are the same", () => {
    publish('0.32.0')
    const result = install({ FAKE_GH_LOGGED_OUT: '1', AIOS_REPO: 'temoto-app/temoto' })
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('(curl)')
    expect(versionOf(appLink)).toBe('0.32.0')
    const fetched = readFileSync(join(dir, 'curl.log'), 'utf8')
    expect(fetched).toContain('https://api.github.com/repos/temoto-app/temoto/releases/latest')
    expect(fetched).toContain('https://github.com/temoto-app/temoto/releases/download/v0.32.0/Temoto-0.32.0-arm64-mac.zip')
    expect(fetched).toContain('https://github.com/temoto-app/temoto/releases/download/v0.32.0/SHA256SUMS')
  })

  it('TODO 1263: without gh only the public repo can be fetched (it stops if AIOS_REPO is different)', () => {
    const result = install('--force', { FAKE_GH_LOGGED_OUT: '1' })
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('gh が要る')
  })

  it('TODO 1263: if the userData of the previous name is a real directory, the data name stays aios (the version location is also ~/.local/share/aios); the install.json of the previous name is rewritten', () => {
    const home = join(dir, 'legacy-home')
    mkdirSync(join(home, 'Library', 'Application Support', 'aios'), { recursive: true })
    const legacyRoot = join(home, '.local', 'share', 'aios')
    mkdirSync(legacyRoot, { recursive: true })
    writeFileSync(join(legacyRoot, 'install.json'), '{"link":"/Users/u/Applications/aios.app","releaseRepo":"aios-desktop/aios-desktop","hold":"0.80.0"}\n')
    const result = install({ HOME: home, AIOS_INSTALL_ROOT: '' })
    expect(result.code, result.out).toBe(0)
    expect(parseInstallManifest(readFileSync(join(legacyRoot, 'install.json'), 'utf8'))).toEqual({ link: appLink, repo: 'owner/repo' })
    expect(existsSync(join(home, '.local', 'share', 'Temoto'))).toBe(false)
  })

  it("TODO 1263 code-review: if a DB exists on the Temoto side, it stays Temoto even if the previous name's userData appears later (the version location is also ~/.local/share/Temoto)", () => {
    const home = join(dir, 'both-home')
    mkdirSync(join(home, 'Library', 'Application Support', 'aios'), { recursive: true })
    mkdirSync(join(home, 'Library', 'Application Support', 'Temoto'), { recursive: true })
    writeFileSync(join(home, 'Library', 'Application Support', 'Temoto', 'aios.db'), '')
    const result = install({ HOME: home, AIOS_INSTALL_ROOT: '' })
    expect(result.code, result.out).toBe(0)
    expect(existsSync(join(home, '.local', 'share', 'Temoto', 'install.json'))).toBe(true)
    expect(existsSync(join(home, '.local', 'share', 'aios'))).toBe(false)
  })

  it('TODO 1263: if the userData of the previous name is a symlink, it is not followed and starts with the new name (Temoto)', () => {
    const home = join(dir, 'symlink-home')
    mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
    mkdirSync(join(dir, 'elsewhere'))
    symlinkSync(join(dir, 'elsewhere'), join(home, 'Library', 'Application Support', 'aios'))
    const result = install({ HOME: home, AIOS_INSTALL_ROOT: '' })
    expect(result.code, result.out).toBe(0)
    expect(existsSync(join(home, '.local', 'share', 'Temoto', 'install.json'))).toBe(true)
    expect(existsSync(join(home, '.local', 'share', 'aios'))).toBe(false)
  })
})
