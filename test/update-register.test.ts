// TODO 1245: register aios installed into /Applications from the DMG for automatic updates without asking. The location is a temporary directory
// (the real /Applications and ~/.local/share/aios are never written).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectInstallWithRegistration, isPreRenameManifest, registerApplicationsInstall, type RegisterFs } from '../src/main/update/register.js'
import type { DetectInput } from '../src/main/update/layout.js'

const PLIST = (v: string): string =>
  `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n<string>${v}</string></dict></plist>`

describe('TODO 1245: registration in /Applications', () => {
  let dir: string
  let apps: string
  let home: string
  let root: string

  function makeApp(parent: string): DetectInput {
    const bundle = join(parent, 'Temoto.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(bundle, 'Contents', 'Resources', 'app'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), PLIST('0.88.0'))
    return {
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      devServer: false,
      defaultUserData: true,
      execPath: join(bundle, 'Contents', 'MacOS', 'aios'),
      appPath: join(bundle, 'Contents', 'Resources', 'app'),
      home
    }
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-register-')))
    apps = join(dir, 'Applications')
    home = join(dir, 'home')
    mkdirSync(apps)
    mkdirSync(home)
    root = join(home, '.local', 'share', 'aios')
  })
  afterEach(() => {
    chmodSync(apps, 0o755)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a distributed build that runs from /Applications writes install.json and becomes versioned', () => {
    const input = makeApp(apps)
    const detection = detectInstallWithRegistration(input, { applicationsDir: apps })
    const link = join(apps, 'Temoto.app')
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual({ link, releaseRepo: 'temoto-app/temoto' })
    expect(detection).toEqual({
      kind: 'versioned',
      layout: { root, versionsDir: join(root, 'versions'), link, repo: 'temoto-app/temoto', runningVersion: '0.88.0' }
    })
  })

  it('if there is a root install-root points to, writes there', () => {
    const input = makeApp(apps)
    const custom = join(dir, 'custom-root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'install-root'), `${custom}\n`)
    expect(registerApplicationsInstall(input, { applicationsDir: apps }).kind).toBe('registered')
    expect(existsSync(join(custom, 'install.json'))).toBe(true)
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })

  it('does not register from a DMG mount point or another place (Downloads)', () => {
    const mounted = makeApp(join(dir, 'Volumes', 'aios 0.88.0'))
    mkdirSync(join(dir, 'Downloads'))
    const downloaded = makeApp(join(dir, 'Downloads'))
    for (const input of [mounted, downloaded]) {
      expect(registerApplicationsInstall(input, { applicationsDir: apps })).toEqual({ kind: 'skipped' })
      expect(detectInstallWithRegistration(input, { applicationsDir: apps })).toEqual({ kind: 'unsupported', reason: 'not-installed' })
    }
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })

  it('does not register for a dev server, unpackaged, a copy, or a shell under development (Resources/app is a symlink)', () => {
    const input = makeApp(apps)
    const skipped = { kind: 'skipped' }
    expect(registerApplicationsInstall({ ...input, devServer: true }, { applicationsDir: apps })).toEqual(skipped)
    expect(registerApplicationsInstall({ ...input, isPackaged: false }, { applicationsDir: apps })).toEqual(skipped)
    expect(registerApplicationsInstall({ ...input, defaultUserData: false }, { applicationsDir: apps })).toEqual(skipped)
    rmSync(input.appPath, { recursive: true })
    symlinkSync(dir, input.appPath)
    expect(registerApplicationsInstall(input, { applicationsDir: apps })).toEqual(skipped)
    expect(detectInstallWithRegistration(input, { applicationsDir: apps })).toEqual({ kind: 'unsupported', reason: 'dev-shell' })
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })

  it('does not touch it when install.json already exists (even if it points at another link or is broken)', () => {
    const input = makeApp(apps)
    mkdirSync(root, { recursive: true })
    for (const text of [JSON.stringify({ link: join(home, 'Applications', 'Temoto.app'), releaseRepo: 'a/b' }), '{']) {
      writeFileSync(join(root, 'install.json'), text)
      expect(registerApplicationsInstall(input, { applicationsDir: apps })).toEqual({ kind: 'skipped' })
      expect(readFileSync(join(root, 'install.json'), 'utf8')).toBe(text)
    }
  })

  it('TODO 1263: an install.json pointing at the name before the rename (aios.app) is rewritten and becomes versioned (a machine reinstalled with a DMG under the previous name)', () => {
    const input = makeApp(apps)
    mkdirSync(root, { recursive: true })
    const old = JSON.stringify({ link: join(home, 'Applications', 'aios.app'), releaseRepo: 'aios-desktop/aios-desktop', hold: '0.80.0' })
    writeFileSync(join(root, 'install.json'), old)
    expect(isPreRenameManifest(old)).toBe(true)
    expect(isPreRenameManifest('{')).toBe(false)
    expect(isPreRenameManifest(JSON.stringify({ link: join(home, 'Applications', 'Temoto.app') }))).toBe(false)
    const detection = detectInstallWithRegistration(input, { applicationsDir: apps })
    const link = join(apps, 'Temoto.app')
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual({ link, releaseRepo: 'temoto-app/temoto' })
    expect(detection.kind).toBe('versioned')
  })

  it('when /Applications cannot be written, writes nothing and returns applications-readonly (checked by actually creating a temporary file)', () => {
    const input = makeApp(apps)
    chmodSync(apps, 0o555)
    const detection = detectInstallWithRegistration(input, { applicationsDir: apps })
    // Running as root can create files, so in that environment only the side that can be written is checked
    if (process.getuid?.() === 0) expect(detection.kind).toBe('versioned')
    else {
      expect(detection).toEqual({ kind: 'unsupported', reason: 'applications-readonly' })
      expect(existsSync(join(root, 'install.json'))).toBe(false)
    }
  })

  it('even if writing install.json fails, only returns the reason (does not throw)', () => {
    const input = makeApp(apps)
    const writer: RegisterFs = {
      probeWritable: () => undefined,
      mkdirp: () => undefined,
      writeAtomic: () => {
        throw new Error('EROFS')
      }
    }
    expect(registerApplicationsInstall(input, { applicationsDir: apps, writer })).toEqual({
      kind: 'unwritable',
      reason: 'applications-readonly',
      detail: 'EROFS'
    })
  })
})
