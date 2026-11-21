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

describe('TODO 1245: /Applications の登録', () => {
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

  it('/Applications から動く配る版は install.json を書いて versioned になる', () => {
    const input = makeApp(apps)
    const detection = detectInstallWithRegistration(input, { applicationsDir: apps })
    const link = join(apps, 'Temoto.app')
    expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toEqual({ link, releaseRepo: 'temoto-app/temoto' })
    expect(detection).toEqual({
      kind: 'versioned',
      layout: { root, versionsDir: join(root, 'versions'), link, repo: 'temoto-app/temoto', runningVersion: '0.88.0' }
    })
  })

  it('install-root の指す根があれば、そこに書く', () => {
    const input = makeApp(apps)
    const custom = join(dir, 'custom-root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'install-root'), `${custom}\n`)
    expect(registerApplicationsInstall(input, { applicationsDir: apps }).kind).toBe('registered')
    expect(existsSync(join(custom, 'install.json'))).toBe(true)
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })

  it('DMG のマウント先・別の場所 (Downloads) からは登録しない', () => {
    const mounted = makeApp(join(dir, 'Volumes', 'aios 0.88.0'))
    mkdirSync(join(dir, 'Downloads'))
    const downloaded = makeApp(join(dir, 'Downloads'))
    for (const input of [mounted, downloaded]) {
      expect(registerApplicationsInstall(input, { applicationsDir: apps })).toEqual({ kind: 'skipped' })
      expect(detectInstallWithRegistration(input, { applicationsDir: apps })).toEqual({ kind: 'unsupported', reason: 'not-installed' })
    }
    expect(existsSync(join(root, 'install.json'))).toBe(false)
  })

  it('dev サーバ・未パッケージ・複製・開発中の殻 (Resources/app が symlink) では登録しない', () => {
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

  it('install.json が既にあれば (別の link を指していても壊れていても) 触らない', () => {
    const input = makeApp(apps)
    mkdirSync(root, { recursive: true })
    for (const text of [JSON.stringify({ link: join(home, 'Applications', 'Temoto.app'), releaseRepo: 'a/b' }), '{']) {
      writeFileSync(join(root, 'install.json'), text)
      expect(registerApplicationsInstall(input, { applicationsDir: apps })).toEqual({ kind: 'skipped' })
      expect(readFileSync(join(root, 'install.json'), 'utf8')).toBe(text)
    }
  })

  it('TODO 1263: 改名の前の名前 (aios.app) を指す install.json は書き直して versioned になる (DMG で入れ直した前の名前の機械)', () => {
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

  it('/Applications に書けなければ何も書かず applications-readonly を返す (一時ファイルを実際に作って確かめる)', () => {
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

  it('install.json の書き込みに失敗しても理由を返すだけ (投げない)', () => {
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
