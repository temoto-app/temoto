// TODO 492 (wave 24 bundle B): electron-builder settings for the distributable aios.app (the pure part of scripts/release-config.mjs).
// Neither electron-builder nor codesign is called. The results of checking with a real zip are in bundle B of docs/notes/wave24.md.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { clean, cleanTargets, isSafeTarget } from '../scripts/clean.mjs'
import { extractVersionSection } from '../src/shared/release-notes.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { RELEASE_BUNDLE_ID, infoPlistOps } from '../scripts/app-shell.mjs'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { APP_BUNDLE, changelogSection, dmgCommands, dmgInspectCommands, dmgName, extendInfoFromOps, ghReleaseCommand, releaseAssets, releaseConfig, sha256SumsText, zipName } from '../scripts/release-config.mjs'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { NOTARY_PROFILE_DEFAULT, developerIdRequirement, notarizeCommands, parseNotarySubmit, parseSpctl, releaseSigningMode } from '../scripts/release-config.mjs'

type Config = {
  appId: string
  productName: string
  asar: boolean
  npmRebuild: boolean
  publish: unknown
  files: string[]
  electronDist: string
  mac: { identity: unknown; target: Array<{ target: string; arch: string[] }>; extendInfo: Record<string, unknown>; artifactName: string }
  dmg: { artifactName: string; sign: boolean; contents: Array<{ type?: string; path?: string }>; background?: unknown }
  afterPack: unknown
}

describe('electron-builder configuration (TODO 492)', () => {
  const afterPack = async (): Promise<void> => {}
  const config = releaseConfig({ version: '0.24.0', afterPack }) as Config

  it('the identifier is io.github.temoto-app.temoto (TODO 1263; the shell stays local.aios), and the product name is Temoto (constraint 5, TODO 1254)', () => {
    expect(config.appId).toBe(RELEASE_BUNDLE_ID)
    expect(config.appId).toBe('io.github.temoto-app.temoto')
    expect(config.productName).toBe('Temoto')
    expect(APP_BUNDLE).toBe('Temoto.app')
  })

  it('builds an arm64 zip and DMG', () => {
    expect(config.mac.target).toEqual([
      { target: 'zip', arch: ['arm64'] },
      { target: 'dmg', arch: ['arm64'] }
    ])
    expect(zipName('0.24.0')).toBe('Temoto-0.24.0-arm64-mac.zip')
    expect(config.mac.artifactName).toBe('Temoto-${version}-arm64-mac.zip')
    // TODO 1243 stage 1: the DMG does not overwrite the zip name (which auto-update and install-temoto.sh read), and its look is minimal (no background, a link to /Applications)
    expect(dmgName('0.24.0')).toBe('Temoto-0.24.0-arm64.dmg')
    expect(config.dmg.artifactName).toBe('Temoto-${version}-arm64.dmg')
    expect(config.dmg.sign).toBe(false)
    expect(config.dmg.background).toBeUndefined()
    expect(config.dmg.contents.map((c) => c.type)).toEqual(['file', 'link'])
    expect(config.dmg.contents[1]?.path).toBe('/Applications')
  })

  it('signing is not done by electron-builder but in afterPack (signApp of scripts/app-shell.mjs)', () => {
    expect(config.mac.identity).toBeNull()
    expect(config.afterPack).toBe(afterPack)
  })

  it('no asar, no rebuild of native modules, Electron comes from node_modules, and no publishing', () => {
    expect(config.asar).toBe(false)
    expect(config.npmRebuild).toBe(false)
    expect(config.electronDist).toBe('node_modules/electron/dist')
    expect(config.publish).toBeNull()
  })

  it('includes out/ and the compat/ table read at runtime', () => {
    expect(config.files).toContain('out/**/*')
    expect(config.files).toContain('!out/.built-commit')
    expect(config.files).toContain('!out/.release-head')
    // TODO 1185 X-6: the check marks (the build's commit, flaky.jsonl) are not distributed
    expect(config.files).toContain('!out/check/**')
    expect(config.files).toContain('compat/*.json')
    expect(config.files).toContain('package.json')
  })

  it('puts the bundled Help (TODO 1174) in Resources/app/resources/help/ (main reads `<appPath>/resources/help`)', () => {
    expect(config.files).toContain('resources/help/**')
  })

  it('puts the bundled changelog (TODO 1186) in Resources/app/CHANGELOG.md and also lists it in the post-extraction verification', () => {
    expect(config.files).toContain('CHANGELOG.md')
    const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
    expect(release).toMatch(/'CHANGELOG\.md',/)
  })

  it('does not add keys or values carrying the backend name to the distributed zip (constraint 5)', () => {
    const text = JSON.stringify({ ...config, afterPack: undefined })
    const terms = JSON.parse(readFileSync(new URL('../compat/forbidden-terms.json', import.meta.url), 'utf8')) as { terms: string[] }
    for (const term of terms.terms) expect(text.toLowerCase()).not.toContain(term)
  })
})

describe('Info.plist additions (copied from the shell infoPlistOps)', () => {
  const info = extendInfoFromOps(infoPlistOps({ version: '0.24.0', bundleId: RELEASE_BUNDLE_ID })) as Record<string, unknown>

  it('does not hold keys that electron-builder writes itself', () => {
    for (const key of ['CFBundleExecutable', 'CFBundleIdentifier', 'CFBundleName', 'CFBundleShortVersionString', 'CFBundleIconFile']) {
      expect(info).not.toHaveProperty(key)
    }
  })

  it('holds the microphone and speech recognition usage sentences with the quotes removed (item 226)', () => {
    expect(info['NSMicrophoneUsageDescription']).toMatch(/^Temoto uses the microphone/)
    expect(info['NSSpeechRecognitionUsageDescription']).toMatch(/^Temoto transcribes/)
  })

  it('a key to remove is null (electron-builder removes null keys)', () => {
    expect(info['NSHumanReadableCopyright']).toBeNull()
    expect(info['ElectronAsarIntegrity']).toBeNull()
  })

  it('CFBundleDocumentTypes is assembled into arrays and dictionaries (Drop onto the Dock, item 98)', () => {
    expect(info['CFBundleDocumentTypes']).toEqual([
      {
        CFBundleTypeName: 'Folder',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.folder', 'public.item']
      }
    ])
  })

  it('CFBundleURLTypes is also assembled into arrays and dictionaries (the aios:// URL scheme, TODO 976 stage 3)', () => {
    expect(info['CFBundleURLTypes']).toEqual([
      { CFBundleURLName: 'io.github.temoto-app.temoto.url', CFBundleTypeRole: 'Viewer', CFBundleURLSchemes: ['aios', 'temoto'] }
    ])
  })
})

describe('Release assets and the publish command', () => {
  it('the assets are zip / install-temoto.sh / install-backend.sh / plugins.json (TODO 1144) / SHA256SUMS', () => {
    expect(releaseAssets('0.24.0')).toEqual([
      'Temoto-0.24.0-arm64-mac.zip',
      'Temoto-0.24.0-arm64.dmg',
      'install-temoto.sh',
      'install-backend.sh',
      'plugins.json',
      'SHA256SUMS'
    ])
  })

  it('SHA256SUMS is in the shape that shasum -a 256 -c reads', () => {
    expect(sha256SumsText([{ name: 'a.zip', sha256: 'ab'.repeat(32) }, { name: 'b.sh', sha256: 'cd'.repeat(32) }])).toBe(
      `${'ab'.repeat(32)}  a.zip\n${'cd'.repeat(32)}  b.sh\n`
    )
  })

  it('gh release create puts the tag v<version> on the commit and attaches all assets', () => {
    const command = ghReleaseCommand({ version: '0.24.0', commit: 'f'.repeat(40) }) as string
    expect(command).toMatch(/^gh release create \\\n {2}v0\.24\.0 \\\n {2}-R temoto-app\/temoto/)
    expect(command).toContain(`--target ${'f'.repeat(40)}`)
    for (const asset of releaseAssets('0.24.0') as string[]) expect(command).toContain(`dist/${asset}`)
  })
  it('TODO 1185: without a commit passed, it uses the tag placed on the publishing commit (--verify-tag, no --target)', () => {
    const command = ghReleaseCommand({ version: '0.78.0', commit: null }) as string
    expect(command).toContain('-R temoto-app/temoto')
    expect(command).toContain('--verify-tag')
    expect(command).not.toContain('--target')
    expect(command).toContain('curl -fsSLO https://github.com/temoto-app/temoto/releases/latest/download/install-temoto.sh')
  })
  it("TODO 1185 X-4: the notes are the version's section of the CHANGELOG (--notes-file); only when the section is missing, the install guidance", () => {
    const withFile = ghReleaseCommand({ version: '0.78.0', commit: null, notesFile: 'dist/release-notes-0.78.0.md' }) as string
    expect(withFile).toContain('--notes-file dist/release-notes-0.78.0.md')
    expect(withFile).not.toContain('--notes "')
    expect(ghReleaseCommand({ version: '0.78.0', commit: null }) as string).toContain('--notes "Install and update')
    expect(ghReleaseCommand({ version: '0.78.0', commit: null, assets: null }) as string).toContain('dist/<npm run release')
  })
  it('TODO 1185 X-4: changelogSection cuts the same section as extractVersionSection in src/shared', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
    expect(changelogSection(changelog, version)).toBe(extractVersionSection(changelog, version))
    expect(changelogSection(changelog, version)).not.toBeNull()
    const two = '# C\n\n## [2.0.0] - x\n\nb\n\n## [1.0.0] - y\n\na\n'
    expect(changelogSection(two, '2.0.0')).toBe('## [2.0.0] - x\n\nb\n')
    expect(changelogSection(two, '3.0.0')).toBeNull()
    expect(changelogSection(two, '1.0.0')).toBe(extractVersionSection(two, '1.0.0'))
  })
  it('TODO 1144 stage 2: the per-extension zips are ordered before the version table and also attached to gh release create', () => {
    const plugins = ['plugin-aios.diff-1.0.0.zip', 'plugin-aios.text-1.2.0.zip']
    expect(releaseAssets('0.73.0', plugins)).toEqual([
      'Temoto-0.73.0-arm64-mac.zip',
      'Temoto-0.73.0-arm64.dmg',
      'install-temoto.sh',
      'install-backend.sh',
      ...plugins,
      'plugins.json',
      'SHA256SUMS'
    ])
    const command = ghReleaseCommand({ version: '0.73.0', commit: 'f'.repeat(40), pluginAssets: plugins }) as string
    for (const asset of plugins) expect(command).toContain(`dist/${asset}`)
  })
})

describe('install-temoto.sh', () => {
  const script = readFileSync(new URL('../scripts/install-temoto.sh', import.meta.url), 'utf8')

  it('does not overwrite the dev machine shell (Resources/app is a symlink)', () => {
    // TODO 1254: looks at both the install destination (Temoto.app) and the location of the shell (the previous name, aios.app).
    expect(script).toContain('for candidate in "$APP" "$LEGACY_APP"; do')
    expect(script).toMatch(/if \[ -L "\$candidate\/Contents\/Resources\/app" \]; then\n\s+die /)
    expect(script).toContain('LEGACY_APP="$HOME/Applications/aios.app"')
  })

  it('the zip is extracted with ditto, and the zip name has the same form as release', () => {
    expect(script).toContain('ditto -x -k')
    expect(script).toContain('zip="$PRODUCT-${version}-arm64-mac.zip"')
  })

  it('does not carry the backend name (left to install-backend.sh, constraint 6)', () => {
    const terms = JSON.parse(readFileSync(new URL('../compat/forbidden-terms.json', import.meta.url), 'utf8')) as { terms: string[] }
    for (const term of terms.terms) expect(script.toLowerCase()).not.toContain(term)
  })
})

describe('Developer ID, Hardened Runtime, and notarization (TODO 951)', () => {
  const devId = { developerId: true, teamId: 'LVG3JZJZ3U', label: 'Developer ID Application: x (LVG3JZJZ3U)' }
  const selfSigned = { developerId: false, teamId: null, label: 'aios dev (HASH)' }

  it('with Developer ID: Hardened Runtime + timestamp + notarization (the default profile is aios)', () => {
    const mode = releaseSigningMode({ sign: devId, env: {} })
    expect(mode).toMatchObject({ hardened: true, timestamp: true, notarize: true, profile: 'aios', teamId: 'LVG3JZJZ3U', skipped: [] })
    expect(NOTARY_PROFILE_DEFAULT).toBe('aios')
    expect(releaseSigningMode({ sign: devId, env: { AIOS_NOTARY_PROFILE: 'other' } }).profile).toBe('other')
    expect(releaseSigningMode({ sign: devId, env: { AIOS_NOTARY_PROFILE: '  ' } }).profile).toBe('aios')
  })

  it('without Developer ID it is as before (no Hardened Runtime, no notarization) and prints the reason', () => {
    const mode = releaseSigningMode({ sign: selfSigned, env: {} })
    expect(mode).toMatchObject({ hardened: false, timestamp: false, notarize: false })
    expect(mode.skipped.join('\n')).toMatch(/公証: 飛ばす \(署名が Developer ID でない: aios dev/)
    expect(mode.skipped.join('\n')).toMatch(/Hardened Runtime: 付けない/)
  })

  it('AIOS_HARDENED_RUNTIME=1 adds the runtime even with a self-signature (no timestamp or notarization); AIOS_NOTARIZE=0 removes only notarization', () => {
    expect(releaseSigningMode({ sign: selfSigned, env: { AIOS_HARDENED_RUNTIME: '1' } })).toMatchObject({
      hardened: true,
      timestamp: false,
      notarize: false
    })
    const noNotary = releaseSigningMode({ sign: devId, env: { AIOS_NOTARIZE: '0' } })
    expect(noNotary).toMatchObject({ hardened: true, notarize: false })
    expect(noNotary.skipped).toEqual(['公証: 飛ばす (AIOS_NOTARIZE=0)'])
  })

  it('the notarization command passes only the profile name, the zip uses ditto --keepParent, and staple goes on the .app', () => {
    const c = notarizeCommands({ app: '/d/aios.app', zip: '/t/n.zip', profile: 'aios' })
    expect(c.zip).toEqual(['ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '/d/aios.app', '/t/n.zip']])
    expect(c.submit).toEqual(['xcrun', ['notarytool', 'submit', '/t/n.zip', '--keychain-profile', 'aios', '--wait', '--output-format', 'json']])
    expect(c.staple).toEqual(['xcrun', ['stapler', 'staple', '/d/aios.app']])
    expect(c.validate).toEqual(['xcrun', ['stapler', 'validate', '/d/aios.app']])
    expect(c.log('ID')).toEqual(['xcrun', ['notarytool', 'log', 'ID', '--keychain-profile', 'aios']])
    const all = JSON.stringify(c) + JSON.stringify(c.log('ID'))
    expect(all).not.toMatch(/--password|--apple-id|--key\b|--issuer/)
  })

  it('TODO 1243 stage 1: signing, notarization, staple, and the verification commands for the DMG apply to the DMG itself, and authentication is only the profile name', () => {
    const c = dmgCommands({ dmg: '/d/aios.dmg', identity: 'Developer ID Application: X (T)', profile: 'aios' })
    expect(c.sign).toEqual(['codesign', ['--force', '--sign', 'Developer ID Application: X (T)', '--timestamp', '/d/aios.dmg']])
    expect(c.submit).toEqual(['xcrun', ['notarytool', 'submit', '/d/aios.dmg', '--keychain-profile', 'aios', '--wait', '--output-format', 'json']])
    expect(c.staple).toEqual(['xcrun', ['stapler', 'staple', '/d/aios.dmg']])
    // The mount and verification commands are separate functions that take no identity / profile (a signature cannot be built with an empty identity)
    const i = dmgInspectCommands({ dmg: '/d/aios.dmg' })
    expect(i.verifySign).toEqual(['codesign', ['--verify', '--strict', '/d/aios.dmg']])
    expect(i.validate).toEqual(['xcrun', ['stapler', 'validate', '/d/aios.dmg']])
    expect(i.assess).toEqual(['spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', '/d/aios.dmg']])
    expect(i.attach('/m')[1]).toEqual(['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', '/m', '/d/aios.dmg'])
    expect(i.detach('/m')).toEqual(['hdiutil', ['detach', '/m']])
    expect(JSON.stringify(i)).not.toMatch(/--sign/)
    const all = JSON.stringify(c) + JSON.stringify(c.log('ID'))
    expect(all).not.toMatch(/--password|--apple-id|--key\b|--issuer/)
  })

  it('reads the JSON of notarytool and the output of spctl', () => {
    expect(parseNotarySubmit('{"id":"abc","status":"Accepted","message":"Processing complete"}\n')).toEqual({ id: 'abc', status: 'Accepted' })
    expect(parseNotarySubmit('Conducting pre-submission checks...\n{"id":"x","status":"Invalid"}')).toEqual({ id: 'x', status: 'Invalid' })
    expect(parseNotarySubmit('{\n  "id" : "p1",\n  "status" : "Accepted"\n}\n')).toEqual({ id: 'p1', status: 'Accepted' })
    expect(parseNotarySubmit('Error: No Keychain password item found')).toEqual({ id: null, status: null })
    // The real VS Code output (2026-10-30) and the real shape of ~/Applications/aios.app (aios dev)
    expect(
      parseSpctl('/Applications/X.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: M (UBF8T346G9)\n')
    ).toEqual({ accepted: true, source: 'Notarized Developer ID' })
    expect(parseSpctl('/Users/u/Applications/aios.app: rejected\norigin=aios dev\n')).toEqual({ accepted: false, source: null })
  })

  it('the Developer ID requirement is the Apple CA chain and the Team ID (not a name string)', () => {
    const req = developerIdRequirement('LVG3JZJZ3U') as string
    expect(req.startsWith('=anchor apple generic')).toBe(true)
    expect(req).toContain('certificate leaf[subject.OU] = "LVG3JZJZ3U"')
    expect(req).toContain('1.2.840.113635.100.6.2.6')
  })

  it('release.mjs notarizes only with Developer ID, and verifies staple, spctl, and Team ID on the extracted zip', () => {
    const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
    expect(release).toContain('preferDeveloperId: true')
    expect(release).toContain('if (mode.notarize) notarize(app)')
    expect(release).toContain("assess.source !== 'Notarized Developer ID'")
    expect(release).toContain('--dry-run')
    // Do not write a token (only the profile name)
    expect(release).not.toMatch(/--password|APPLE_ID|APP_SPECIFIC_PASSWORD/)
  })
})

describe('npm run clean (TODO 1203)', () => {
  it('removes only directly under out/ (except check) and dist/', () => {
    expect(cleanTargets('/repo', ['main', 'check', 'plugins', 'renderer'], true)).toEqual([
      '/repo/out/main',
      '/repo/out/plugins',
      '/repo/out/renderer',
      '/repo/dist'
    ])
    expect(cleanTargets('/repo', ['check'], false)).toEqual([])
  })

  it('does not remove dangerous paths (root, node_modules, source, out/check, parent, grandchildren of out/, another root)', () => {
    for (const bad of ['/repo', '/repo/node_modules', '/repo/src', '/repo/out', '/repo/out/check', '/repo/out/main/x', '/repo/out/../src', '/', '/repo/..', '/repo/dist/x', '/other/dist']) {
      expect(isSafeTarget('/repo', bad)).toBe(false)
    }
    for (const good of ['/repo/dist', '/repo/out/main', '/repo/out/.release-head']) expect(isSafeTarget('/repo', good)).toBe(true)
  })

  it('with real files: out/check, node_modules, and source remain, and the rest are removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-clean-'))
    try {
      for (const p of ['out/main/a.js', 'out/check/flaky.jsonl', 'out/.release-head', 'dist/a.zip', 'node_modules/x/i.js', 'src/a.ts']) {
        mkdirSync(dirname(join(dir, p)), { recursive: true })
        writeFileSync(join(dir, p), 'x')
      }
      clean(dir)
      expect(existsSync(join(dir, 'out/check/flaky.jsonl'))).toBe(true)
      expect(existsSync(join(dir, 'node_modules/x/i.js'))).toBe(true)
      expect(existsSync(join(dir, 'src/a.ts'))).toBe(true)
      expect(existsSync(join(dir, 'out/main'))).toBe(false)
      expect(existsSync(join(dir, 'out/.release-head'))).toBe(false)
      expect(existsSync(join(dir, 'dist'))).toBe(false)
      clean(dir) // Does not fail even when empty
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('package.json has clean, and release.mjs calls clean right before build unless --skip-build', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.clean).toBe('node scripts/clean.mjs')
    const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
    const skip = release.indexOf("if (args.has('--skip-build')) {")
    const cleanCall = release.indexOf('clean(root)')
    const build = release.indexOf("execFileSync('npm', ['run', 'build']")
    expect(skip).toBeGreaterThan(-1)
    expect(cleanCall).toBeGreaterThan(skip)
    expect(build).toBeGreaterThan(cleanCall)
    // Inside the else branch (not called in the skip branch)
    expect(release.slice(skip, cleanCall)).toContain('} else {')
  })
})
