// TODO 375 (wave 20 bundle J): the shape of the aios.app shell and the order of signing (the pure part of scripts/app-shell.mjs).
// Neither codesign nor PlistBuddy is called. The results on the real shell are in docs/notes/wave20.md, bundle J.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { ENTITLEMENTS, EXECUTABLE, RELEASE_BUNDLE_ID, SHELL_BUNDLE_ID, URL_SCHEMES, infoPlistOps, planSigning, resolveSignIdentity } from '../scripts/app-shell.mjs'
import { APP_URL_SCHEMES_ACCEPTED } from '../src/common/app-url.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { teamIdProblem } from '../scripts/release-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

type PlistOp = { op: 'set' | 'add'; key: string; type: string; value: string } | { op: 'delete'; key: string }
type SignStep = { path: string; kind: 'file' | 'bundle' | 'app'; args: string[]; entitlements: string | null }

/** The Electron.app of Electron 44 with only the name changed (what scanAppLayout in scripts/app-shell.mjs returns). */
const F = 'Contents/Frameworks'
const electronLayout = {
  mainExecutable: 'Contents/MacOS/aios',
  machos: [
    'Contents/MacOS/aios',
    `${F}/Electron Framework.framework/Versions/A/Electron Framework`,
    `${F}/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`,
    `${F}/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`,
    `${F}/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib`,
    `${F}/Electron Helper.app/Contents/MacOS/Electron Helper`,
    `${F}/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)`,
    `${F}/Electron Helper (Plugin).app/Contents/MacOS/Electron Helper (Plugin)`,
    `${F}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`,
    `${F}/Mantle.framework/Versions/A/Mantle`,
    `${F}/ReactiveObjC.framework/Versions/A/ReactiveObjC`,
    `${F}/Squirrel.framework/Versions/A/Squirrel`,
    `${F}/Squirrel.framework/Versions/A/Resources/ShipIt`
  ],
  bundles: [
    { path: `${F}/Electron Framework.framework`, executable: `${F}/Electron Framework.framework/Versions/A/Electron Framework` },
    { path: `${F}/Electron Helper.app`, executable: `${F}/Electron Helper.app/Contents/MacOS/Electron Helper` },
    { path: `${F}/Electron Helper (GPU).app`, executable: `${F}/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)` },
    { path: `${F}/Electron Helper (Plugin).app`, executable: `${F}/Electron Helper (Plugin).app/Contents/MacOS/Electron Helper (Plugin)` },
    { path: `${F}/Electron Helper (Renderer).app`, executable: `${F}/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)` },
    { path: `${F}/Mantle.framework`, executable: `${F}/Mantle.framework/Versions/A/Mantle` },
    { path: `${F}/ReactiveObjC.framework`, executable: `${F}/ReactiveObjC.framework/Versions/A/ReactiveObjC` },
    { path: `${F}/Squirrel.framework`, executable: `${F}/Squirrel.framework/Versions/A/Squirrel` }
  ]
}

describe('Info.plist (TODO 375)', () => {
  const ops = infoPlistOps({ version: '0.20.0' }) as PlistOp[]
  const setValue = (key: string): string | undefined => {
    const op = ops.find((o) => o.op === 'set' && o.key === key)
    return op && op.op !== 'delete' ? op.value : undefined
  }

  it("CFBundleExecutable is Electron's own binary (no shell script in between)", () => {
    expect(EXECUTABLE).toBe('aios')
    expect(setValue('CFBundleExecutable')).toBe('aios')
    expect(ops.some((o) => o.op !== 'delete' && o.value.includes('aios-bin'))).toBe(false)
  })

  it("the identifier is local.aios and the version is package.json's version", () => {
    expect(SHELL_BUNDLE_ID).toBe('local.aios')
    // TODO 1263: only the distributed build takes the new identifier; the development shell keeps local.aios
    expect(RELEASE_BUNDLE_ID).toBe('io.github.temoto-app.temoto')
    const release = infoPlistOps({ version: '0.20.0', bundleId: RELEASE_BUNDLE_ID }) as PlistOp[]
    expect(release).toContainEqual({ op: 'set', key: 'CFBundleIdentifier', type: 'string', value: RELEASE_BUNDLE_ID })
    expect(release).toContainEqual({ op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLName', type: 'string', value: 'io.github.temoto-app.temoto.url' })
    expect(setValue('CFBundleIdentifier')).toBe('local.aios')
    expect(setValue('CFBundleShortVersionString')).toBe('0.20.0')
    expect(setValue('CFBundleVersion')).toBe('0.20.0')
  })

  it('removes the integrity record of the removed default_app.asar', () => {
    expect(ops).toContainEqual({ op: 'delete', key: 'ElectronAsarIntegrity' })
  })

  it('CFBundleDocumentTypes is removed and rebuilt (drop onto the Dock, item 98)', () => {
    const del = ops.findIndex((o) => o.op === 'delete' && o.key === 'CFBundleDocumentTypes')
    const add = ops.findIndex((o) => o.op === 'add' && o.key === 'CFBundleDocumentTypes')
    expect(del).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThan(del)
    expect(ops).toContainEqual({ op: 'add', key: 'CFBundleDocumentTypes:0:LSItemContentTypes:0', type: 'string', value: 'public.folder' })
  })

  it('has usage strings for the microphone and speech recognition (item 226)', () => {
    expect(setValue('NSMicrophoneUsageDescription')).toMatch(/^"Temoto /)
    expect(setValue('NSSpeechRecognitionUsageDescription')).toMatch(/^"Temoto /)
  })

  it('CFBundleURLTypes is removed and rebuilt, and declares the same scheme as main (TODO 976 stage 3)', () => {
    const del = ops.findIndex((o) => o.op === 'delete' && o.key === 'CFBundleURLTypes')
    const add = ops.findIndex((o) => o.op === 'add' && o.key === 'CFBundleURLTypes')
    expect(del).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThan(del)
    expect(URL_SCHEMES).toEqual(APP_URL_SCHEMES_ACCEPTED)
    expect(URL_SCHEMES).toEqual(['aios', 'temoto'])
    expect(ops).toContainEqual({ op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLSchemes:0', type: 'string', value: 'aios' })
    // TODO 1263: temoto:// is an alias
    expect(ops).toContainEqual({ op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLSchemes:1', type: 'string', value: 'temoto' })
    expect(ops).toContainEqual({ op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLName', type: 'string', value: 'local.aios.url' })
  })
})

describe('signing order (TODO 375)', () => {
  const plan = planSigning(electronLayout, { identity: 'HASH' }) as SignStep[]
  const index = (path: string): number => plan.findIndex((s) => s.path === path)

  it('finally signs the whole shell with --identifier local.aios and without --deep', () => {
    const last = plan[plan.length - 1] as SignStep
    expect(last.kind).toBe('app')
    expect(last.args).toEqual(['--force', '--sign', 'HASH', '--identifier', 'local.aios', ''])
    expect(plan.every((s) => !s.args.includes('--deep'))).toBe(true)
  })

  it("does not sign the bundle's main binary on its own (signed along with the bundle)", () => {
    const paths = plan.map((s) => s.path)
    expect(paths).not.toContain('Contents/MacOS/aios')
    expect(paths).not.toContain(`${F}/Electron Framework.framework/Versions/A/Electron Framework`)
    expect(paths).not.toContain(`${F}/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)`)
  })

  it('signs the 4 Helpers and 4 frameworks one by one with the same identity', () => {
    const bundles = plan.filter((s) => s.kind === 'bundle')
    expect(bundles.map((s) => s.path).sort()).toEqual(electronLayout.bundles.map((b) => b.path).sort())
    expect(plan.every((s) => s.args.slice(0, 3).join(' ') === '--force --sign HASH')).toBe(true)
  })

  it('inside out: inner files come before the bundle that contains them', () => {
    expect(index(`${F}/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`)).toBeLessThan(
      index(`${F}/Electron Framework.framework`)
    )
    expect(index(`${F}/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`)).toBeLessThan(
      index(`${F}/Electron Framework.framework`)
    )
    expect(index(`${F}/Squirrel.framework/Versions/A/Resources/ShipIt`)).toBeLessThan(index(`${F}/Squirrel.framework`))
    // All of these come before the shell.
    expect(plan.slice(0, -1).every((s) => s.kind !== 'app')).toBe(true)
  })

  it('does not give an identifier to inner parts (derived from each Info.plist / file name)', () => {
    expect(plan.slice(0, -1).every((s) => !s.args.includes('--identifier'))).toBe(true)
  })

  it('the shell identifier is local.aios even with ad-hoc (`-`)', () => {
    const adhoc = planSigning(electronLayout, { identity: '-' }) as SignStep[]
    expect(adhoc[adhoc.length - 1]?.args).toEqual(['--force', '--sign', '-', '--identifier', 'local.aios', ''])
  })

  it('when re-signing an old-shape shell (aios-bin), also gives aios-bin local.aios', () => {
    const old = planSigning(
      { ...electronLayout, mainExecutable: 'Contents/MacOS/aios', machos: [...electronLayout.machos.slice(1), 'Contents/MacOS/aios-bin'] },
      { identity: 'HASH' }
    ) as SignStep[]
    const bin = old.find((s) => s.path === 'Contents/MacOS/aios-bin')
    expect(bin?.args).toEqual(['--force', '--sign', 'HASH', '--identifier', 'local.aios', 'Contents/MacOS/aios-bin'])
    expect(old.indexOf(bin as SignStep)).toBeLessThan(old.length - 1)
  })
})

describe('Hardened Runtime and entitlements (TODO 951)', () => {
  const hardened = { app: '/r/build/entitlements.mac.plist', helper: '/r/build/entitlements.helper.plist', timestamp: true }
  const plan = planSigning(electronLayout, { identity: 'DEVID', hardened }) as SignStep[]

  it('if not passed, as before (no runtime, entitlements, or timestamp — the aios dev / ad-hoc shell and the distributed version)', () => {
    const plain = planSigning(electronLayout, { identity: 'HASH' }) as SignStep[]
    expect(plain.every((s) => !s.args.includes('--options') && !s.args.includes('--entitlements') && !s.args.includes('--timestamp'))).toBe(true)
    expect(plain.every((s) => s.entitlements === null)).toBe(true)
  })

  it('gives all of them --options runtime and --timestamp (a notarization requirement)', () => {
    for (const step of plan) {
      expect(step.args.slice(0, 6)).toEqual(['--force', '--sign', 'DEVID', '--options', 'runtime', '--timestamp'])
    }
    const noStamp = planSigning(electronLayout, { identity: 'HASH', hardened: { ...hardened, timestamp: false } }) as SignStep[]
    expect(noStamp.every((s) => s.args.includes('runtime') && !s.args.includes('--timestamp'))).toBe(true)
  })

  it('the shell binary gets the app entitlements and the 4 Helpers get the helper entitlements; not given to frameworks, dylibs, .node files, or standalone executables', () => {
    const last = plan[plan.length - 1] as SignStep
    expect(last.args).toEqual([
      '--force', '--sign', 'DEVID', '--options', 'runtime', '--timestamp', '--entitlements', hardened.app, '--identifier', 'local.aios', ''
    ])
    const helpers = plan.filter((s) => s.path.endsWith('.app'))
    expect(helpers).toHaveLength(4)
    expect(helpers.every((s) => s.entitlements === hardened.helper && s.args.includes(hardened.helper))).toBe(true)
    const others = plan.filter((s) => s.kind !== 'app' && !s.path.endsWith('.app'))
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((s) => s.entitlements === null && !s.args.includes('--entitlements'))).toBe(true)
  })

  it("the old-shape aios-bin (Electron's binary) also gets the app entitlements", () => {
    const old = planSigning(
      { ...electronLayout, machos: [...electronLayout.machos.slice(1), 'Contents/MacOS/aios-bin'] },
      { identity: 'HASH', hardened }
    ) as SignStep[]
    expect(old.find((s) => s.path === 'Contents/MacOS/aios-bin')?.entitlements).toBe(hardened.app)
  })

  it("the entitlements plist is Electron's default (JIT, unsigned executable memory, library validation disabled) + microphone", () => {
    const app = readFileSync(join(root, ENTITLEMENTS.app as string), 'utf8')
    const helper = readFileSync(join(root, ENTITLEMENTS.helper as string), 'utf8')
    const keys = (xml: string): string[] => [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] as string).sort()
    expect(keys(app)).toEqual([
      'com.apple.security.automation.apple-events',
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.device.audio-input'
    ])
    expect(keys(helper)).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation'
    ])
    // All values are true; it does not have get-task-allow (debugger attach, which notarization refuses)
    for (const xml of [app, helper]) {
      expect(xml).not.toContain('get-task-allow')
      expect(xml.match(/<true\/>/g)?.length).toBe(keys(xml).length)
    }
    // The microphone usage sentence (paired with Hardened Runtime's audio-input) is in Info.plist
    expect(infoPlistOps({ version: '1.0.0' }).some((o: PlistOp) => o.key === 'NSMicrophoneUsageDescription')).toBe(true)
  })
})

describe('Developer ID identity (TODO 951)', () => {
  const both =
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "aios dev"\n' +
    '  2) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Development: Someone (LVG3JZJZ3U)"\n' +
    '  3) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Developer ID Application: Someone (LVG3JZJZ3U)"\n'

  it('the distributed version (preferDeveloperId) takes Developer ID first and reads the Team ID', () => {
    expect(resolveSignIdentity({ env: undefined, findIdentityOutput: both, preferDeveloperId: true })).toMatchObject({
      identity: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      developerId: true,
      teamId: 'LVG3JZJZ3U',
      adhoc: false
    })
  })

  it('review 58-5: a Developer ID name without (TEAM) gives a message that stops before signing', () => {
    const noTeam = '  1) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Developer ID Application: Someone"\n'
    const sign = resolveSignIdentity({ env: undefined, findIdentityOutput: noTeam, preferDeveloperId: true })
    expect(sign).toMatchObject({ developerId: true, teamId: null })
    expect(teamIdProblem(sign)).toContain('Team ID が取れない')
    expect(teamIdProblem(sign)).toContain('Developer ID Application: Someone')
    const ok = resolveSignIdentity({ env: undefined, findIdentityOutput: both, preferDeveloperId: true })
    expect(teamIdProblem(ok)).toBeNull()
    expect(teamIdProblem(resolveSignIdentity({ env: undefined, findIdentityOutput: '' }))).toBeNull()
  })

  it('the shell (without preferDeveloperId) uses aios dev as before; does not pick Apple Development', () => {
    expect(resolveSignIdentity({ env: undefined, findIdentityOutput: both })).toMatchObject({
      identity: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      developerId: false,
      teamId: null
    })
    const noDevId = both.split('\n').slice(0, 2).join('\n')
    expect(resolveSignIdentity({ env: undefined, findIdentityOutput: noDevId, preferDeveloperId: true })).toMatchObject({
      identity: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      developerId: false
    })
  })

  it('ad-hoc when there is neither Developer ID nor aios dev (aios dev on this machine as of 2026-10-30)', () => {
    const r = resolveSignIdentity({ env: undefined, findIdentityOutput: '  1) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Development: x (LVG3JZJZ3U)"\n', preferDeveloperId: true })
    expect(r).toMatchObject({ identity: '-', adhoc: true, developerId: false })
  })

  it('AIOS_SIGN_IDENTITY is matched against the list to decide whether it is a Developer ID (by name or SHA-1)', () => {
    expect(resolveSignIdentity({ env: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', findIdentityOutput: both })).toMatchObject({
      developerId: true,
      teamId: 'LVG3JZJZ3U'
    })
    expect(resolveSignIdentity({ env: 'Developer ID Application: Someone (LVG3JZJZ3U)', findIdentityOutput: both })).toMatchObject({
      developerId: true
    })
    expect(resolveSignIdentity({ env: 'Developer ID Application: Unknown (ZZZZZZZZZZ)', findIdentityOutput: both })).toMatchObject({
      developerId: false
    })
    expect(resolveSignIdentity({ env: '-', findIdentityOutput: both, preferDeveloperId: true })).toMatchObject({ developerId: false, adhoc: true })
  })
})

describe('how the signing identity is decided (TODO 375)', () => {
  const one = '  1) E45261E78005D2136E621D89062B3FF7B2AFE211 "aios dev"\n     1 valid identities found\n'

  it('if the keychain has aios dev, signs with its SHA-1', () => {
    const r = resolveSignIdentity({ env: undefined, findIdentityOutput: one })
    expect(r).toMatchObject({ identity: 'E45261E78005D2136E621D89062B3FF7B2AFE211', adhoc: false, warning: null })
  })

  it('with two of the same name, takes the first one + a warning (by name, codesign stops as ambiguous)', () => {
    const two =
      '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "aios dev"\n  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "aios dev"\n'
    const r = resolveSignIdentity({ env: undefined, findIdentityOutput: two })
    expect(r.identity).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(r.warning).toMatch(/2 個/)
  })

  it('ad-hoc + a warning when there is none', () => {
    for (const out of ['     0 valid identities found\n', null, '  1) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Development: x"\n']) {
      const r = resolveSignIdentity({ env: undefined, findIdentityOutput: out })
      expect(r).toMatchObject({ identity: '-', adhoc: true })
      expect(r.warning).toMatch(/ad-hoc/)
    }
  })

  it('AIOS_SIGN_IDENTITY takes precedence (`-` is an explicit ad-hoc and does not warn)', () => {
    expect(resolveSignIdentity({ env: 'other cert', findIdentityOutput: one })).toMatchObject({
      identity: 'other cert',
      adhoc: false,
      warning: null
    })
    expect(resolveSignIdentity({ env: '-', findIdentityOutput: one })).toMatchObject({ identity: '-', adhoc: true, warning: null })
  })

  it('an empty AIOS_SIGN_IDENTITY is the same as unset', () => {
    expect(resolveSignIdentity({ env: '', findIdentityOutput: one }).identity).toBe('E45261E78005D2136E621D89062B3FF7B2AFE211')
  })
})
