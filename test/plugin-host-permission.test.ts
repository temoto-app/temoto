/**
 * TODO 499 (wave 25 bundle H): in the shipped build, the Node permission model of plugin-host was off.
 *
 * Measured (docs/notes/wave25.md bundle H, Electron 44.4.3):
 *  - Putting `--permission` in `execArgv` of `utilityProcess.fork` has **no effect** (`process.permission` is undefined, with the default name or when packaged). Only `NODE_OPTIONS` works.
 *  - That NODE_OPTIONS is discarded by Electron, which treats the app as packaged, unless the Helper's name is `Electron Helper*`. electron-builder renames the Helper to `aios Helper*.app`, so `restoreElectronHelpers` restores it in `afterPack`.
 *  - Before reading any plugin, plugin-host reports its state in a `permission` frame, and main turns it into the one row `plugin.host.permission`.
 *
 * Electron's utility process cannot be started from Vitest, so this checks the pure parts, the shape of the source, and the plain Node permission model
 * (that the judgment expression is correct against the real `process.permission`).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describePermission } from '../src/plugin-host/dispatch.js'
import { buildHostEnv, permissionLogLine } from '../src/main/plugin/host-env.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { ELECTRON_HELPER_PREFIX, helperRestorePlan, restoreElectronHelpers } from '../scripts/release-config.mjs'

type Step = { fromApp: string; toApp: string; fromExe: string; toExe: string }

const root = join(import.meta.dirname, '..')

describe('describePermission (state reported by plugin-host)', () => {
  it('disabled when process.permission is missing', () => {
    expect(describePermission(undefined, '/x/Electron Helper.app/Contents/MacOS/Electron Helper')).toEqual({
      enabled: false,
      helper: 'Electron Helper'
    })
  })

  it('enabled when reading / is not allowed, disabled when it is allowed (the allow list is equivalent to `*`)', () => {
    const restricted = { has: (scope: string, ref: string) => !(scope === 'fs.read' && ref === '/') }
    const open = { has: () => true }
    expect(describePermission(restricted, '/a/aios Helper').enabled).toBe(true)
    expect(describePermission(open, '/a/aios Helper').enabled).toBe(false)
  })

  it('disabled when has throws or the shape is wrong (no exception escapes)', () => {
    const throwing = {
      has: () => {
        throw new Error('boom')
      }
    }
    expect(describePermission(throwing, 'x').enabled).toBe(false)
    expect(describePermission({ has: 'no' }, 'x').enabled).toBe(false)
    expect(describePermission(null, 'x').enabled).toBe(false)
  })

  it('the helper is only the executable name (the path is not sent)', () => {
    const report = describePermission(undefined, '/Users/x/Applications/aios.app/Contents/Frameworks/aios Helper.app/Contents/MacOS/aios Helper')
    expect(report.helper).toBe('aios Helper')
    expect(report.helper).not.toContain('/')
  })

  it('with the real Node permission model, the check expression separates enabled from disabled', () => {
    const probe = (flags: string[]): boolean => {
      const script =
        "const p = process.permission; process.stdout.write(String(typeof p === 'object' && p !== null && p.has('fs.read', '/') === false))"
      return execFileSync(process.execPath, [...flags, '-e', script], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } }) === 'true'
    }
    expect(probe(['--permission', `--allow-fs-read=${root}`])).toBe(true)
    expect(probe([])).toBe(false)
  })
})

describe('permissionLogLine (one line at main startup)', () => {
  it('info when enabled, with via as NODE_OPTIONS and the helper attached', () => {
    expect(permissionLogLine('aios.markdown', { enabled: true, helper: 'Electron Helper' })).toEqual({
      level: 'info',
      event: 'plugin.host.permission',
      fields: { pluginId: 'aios.markdown', enabled: true, via: 'NODE_OPTIONS', helper: 'Electron Helper' }
    })
  })

  it('warn when disabled (the Helper was renamed = treated as packaged)', () => {
    const line = permissionLogLine('aios.markdown', { enabled: false, helper: 'aios Helper' })
    expect(line.level).toBe('warn')
    expect(line.fields).toMatchObject({ enabled: false, helper: 'aios Helper' })
  })

  it('a malformed report is warn as "not in effect"', () => {
    for (const payload of [undefined, null, 'yes', { enabled: 'true' }, { enabled: 1 }]) {
      const line = permissionLogLine('p', payload)
      expect(line.level).toBe('warn')
      expect(line.fields['enabled']).toBe(false)
    }
    expect(permissionLogLine('p', { enabled: true, helper: 'x'.repeat(500) }).fields['helper']).toHaveLength(64)
  })
})

describe('how plugin-host is started (source shape)', () => {
  const host = readFileSync(join(root, 'src/main/plugin/host.ts'), 'utf8')
  const entry = readFileSync(join(root, 'src/plugin-host/index.ts'), 'utf8')

  it('the permission model is passed through NODE_OPTIONS (buildHostEnv); it does not rely on execArgv (does not work on Electron 44 either)', () => {
    const fork = /utilityProcess\.fork\([\s\S]*?\n {4}\}\)/.exec(host)?.[0] ?? ''
    expect(fork).toContain('env: buildHostEnv(process.env, [allowHost, allowPlugin])')
    expect(fork).not.toMatch(/^\s*execArgv\s*:/m)
    expect(buildHostEnv({}, ['/a'])['NODE_OPTIONS']).toBe('--permission --allow-fs-read="/a"')
  })

  it('plugin-host sends the permission frame before loading the plugin', () => {
    const report = entry.indexOf("kind: 'permission'")
    const load = entry.indexOf('loadPlugin(entry)')
    expect(report).toBeGreaterThan(0)
    expect(load).toBeGreaterThan(report)
  })

  it('main accepts the permission frame and logs only the first one', () => {
    expect(host).toMatch(/FRAME_KINDS[^\n]*'permission'/)
    expect(host).toContain('if (running.permissionReported) return')
    expect(host).toContain('permissionLogLine(pluginId, frame.payload)')
  })
})

describe('Helper name of the distributed build (scripts/release-config.mjs)', () => {
  const builderLayout = [
    'Electron Framework.framework',
    'Mantle.framework',
    'ReactiveObjC.framework',
    'Squirrel.framework',
    'aios Helper (GPU).app',
    'aios Helper (Plugin).app',
    'aios Helper (Renderer).app',
    'aios Helper.app'
  ]

  it('builds the list that restores the Helper renamed by electron-builder back to Electron Helper*.app', () => {
    expect(ELECTRON_HELPER_PREFIX).toBe('Electron')
    const plan = helperRestorePlan(builderLayout, 'aios') as Step[]
    expect(plan.map((s) => s.toApp)).toEqual([
      'Electron Helper (GPU).app',
      'Electron Helper (Plugin).app',
      'Electron Helper (Renderer).app',
      'Electron Helper.app'
    ])
    expect(plan.find((s) => s.fromApp === 'aios Helper (GPU).app')).toEqual({
      fromApp: 'aios Helper (GPU).app',
      toApp: 'Electron Helper (GPU).app',
      fromExe: 'aios Helper (GPU)',
      toExe: 'Electron Helper (GPU)'
    })
  })

  it('does not touch an already default name, Framework, or an unrelated .app (empty for the shell form)', () => {
    expect(helperRestorePlan(['Electron Helper.app', 'Electron Framework.framework'], 'aios')).toEqual([])
    expect(helperRestorePlan(['aios Helperish.app', 'aios Helper (x/y).app', 'aios.app'], 'aios')).toEqual([])
    expect((helperRestorePlan(['aios Helper EH.app'], 'aios') as Step[])[0]?.toApp).toBe('Electron Helper EH.app')
  })

  it('restoreElectronHelpers: fixes the executable, then Info.plist CFBundleExecutable, then the .app, in that order', () => {
    const ops: string[] = []
    const plan = restoreElectronHelpers('/d/aios.app', 'aios', {
      readdir: () => ['aios Helper.app', 'Electron Framework.framework'],
      rename: (from: string, to: string) => ops.push(`mv ${from} -> ${to}`),
      setExecutable: (plist: string, exe: string) => ops.push(`plist ${plist} = ${exe}`)
    }) as Step[]
    expect(plan).toHaveLength(1)
    const fw = '/d/aios.app/Contents/Frameworks'
    expect(ops).toEqual([
      `mv ${fw}/aios Helper.app/Contents/MacOS/aios Helper -> ${fw}/aios Helper.app/Contents/MacOS/Electron Helper`,
      `plist ${fw}/aios Helper.app/Contents/Info.plist = Electron Helper`,
      `mv ${fw}/aios Helper.app -> ${fw}/Electron Helper.app`
    ])
  })

  it('release.mjs restores before signing in afterPack and verifies the Helper name in the extracted zip', () => {
    const release = readFileSync(join(root, 'scripts/release.mjs'), 'utf8')
    const restore = release.indexOf('restoreElectronHelpers(app,')
    const sign = release.indexOf('signApp(app, sign.identity')
    expect(restore).toBeGreaterThan(0)
    expect(sign).toBeGreaterThan(restore)
    expect(release).toContain('Helper が既定の名前でない')
  })
})
