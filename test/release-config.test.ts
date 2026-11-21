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

describe('electron-builder の設定 (TODO 492)', () => {
  const afterPack = async (): Promise<void> => {}
  const config = releaseConfig({ version: '0.24.0', afterPack }) as Config

  it('識別子は io.github.temoto-app.temoto (TODO 1263。殻は local.aios のまま)、製品名は Temoto (制約 5、TODO 1254)', () => {
    expect(config.appId).toBe(RELEASE_BUNDLE_ID)
    expect(config.appId).toBe('io.github.temoto-app.temoto')
    expect(config.productName).toBe('Temoto')
    expect(APP_BUNDLE).toBe('Temoto.app')
  })

  it('arm64 の zip と DMG を作る', () => {
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

  it('署名は electron-builder にさせず、afterPack (scripts/app-shell.mjs の signApp) でする', () => {
    expect(config.mac.identity).toBeNull()
    expect(config.afterPack).toBe(afterPack)
  })

  it('asar にしない・ネイティブモジュールを作り直さない・Electron は node_modules のものを使う・公開しない', () => {
    expect(config.asar).toBe(false)
    expect(config.npmRebuild).toBe(false)
    expect(config.electronDist).toBe('node_modules/electron/dist')
    expect(config.publish).toBeNull()
  })

  it('out/ と実行時に読む compat/ の表を入れる', () => {
    expect(config.files).toContain('out/**/*')
    expect(config.files).toContain('!out/.built-commit')
    expect(config.files).toContain('!out/.release-head')
    // TODO 1185 X-6: the check marks (the build's commit, flaky.jsonl) are not distributed
    expect(config.files).toContain('!out/check/**')
    expect(config.files).toContain('compat/*.json')
    expect(config.files).toContain('package.json')
  })

  it('同梱の Help (TODO 1174) を Resources/app/resources/help/ に入れる (main は `<appPath>/resources/help` を読む)', () => {
    expect(config.files).toContain('resources/help/**')
  })

  it('同梱の変更履歴 (TODO 1186) を Resources/app/CHANGELOG.md に入れ、展開後の検証の一覧にも載せる', () => {
    expect(config.files).toContain('CHANGELOG.md')
    const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
    expect(release).toMatch(/'CHANGELOG\.md',/)
  })

  it('配る zip にバックエンドの名前を持つ鍵や値を足さない (制約 5)', () => {
    const text = JSON.stringify({ ...config, afterPack: undefined })
    const terms = JSON.parse(readFileSync(new URL('../compat/forbidden-terms.json', import.meta.url), 'utf8')) as { terms: string[] }
    for (const term of terms.terms) expect(text.toLowerCase()).not.toContain(term)
  })
})

describe('Info.plist の追加分 (殻の infoPlistOps から写す)', () => {
  const info = extendInfoFromOps(infoPlistOps({ version: '0.24.0', bundleId: RELEASE_BUNDLE_ID })) as Record<string, unknown>

  it('electron-builder が自分で書く鍵は持たない', () => {
    for (const key of ['CFBundleExecutable', 'CFBundleIdentifier', 'CFBundleName', 'CFBundleShortVersionString', 'CFBundleIconFile']) {
      expect(info).not.toHaveProperty(key)
    }
  })

  it('マイクと音声認識の用途の文は引用符を外して持つ (項目 226)', () => {
    expect(info['NSMicrophoneUsageDescription']).toMatch(/^Temoto uses the microphone/)
    expect(info['NSSpeechRecognitionUsageDescription']).toMatch(/^Temoto transcribes/)
  })

  it('消す鍵は null (electron-builder は null の鍵を消す)', () => {
    expect(info['NSHumanReadableCopyright']).toBeNull()
    expect(info['ElectronAsarIntegrity']).toBeNull()
  })

  it('CFBundleDocumentTypes は配列と辞書に組み立てる (Dock への Drop、項目 98)', () => {
    expect(info['CFBundleDocumentTypes']).toEqual([
      {
        CFBundleTypeName: 'Folder',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.folder', 'public.item']
      }
    ])
  })

  it('CFBundleURLTypes も配列と辞書に組み立てる (aios:// の URL scheme、TODO 976 段 3)', () => {
    expect(info['CFBundleURLTypes']).toEqual([
      { CFBundleURLName: 'io.github.temoto-app.temoto.url', CFBundleTypeRole: 'Viewer', CFBundleURLSchemes: ['aios', 'temoto'] }
    ])
  })
})

describe('Release の資産と公開のコマンド', () => {
  it('資産は zip / install-temoto.sh / install-backend.sh / plugins.json (TODO 1144) / SHA256SUMS', () => {
    expect(releaseAssets('0.24.0')).toEqual([
      'Temoto-0.24.0-arm64-mac.zip',
      'Temoto-0.24.0-arm64.dmg',
      'install-temoto.sh',
      'install-backend.sh',
      'plugins.json',
      'SHA256SUMS'
    ])
  })

  it('SHA256SUMS は shasum -a 256 -c が読む形', () => {
    expect(sha256SumsText([{ name: 'a.zip', sha256: 'ab'.repeat(32) }, { name: 'b.sh', sha256: 'cd'.repeat(32) }])).toBe(
      `${'ab'.repeat(32)}  a.zip\n${'cd'.repeat(32)}  b.sh\n`
    )
  })

  it('gh release create はタグ v<版> を commit に付け、資産を全部添付する', () => {
    const command = ghReleaseCommand({ version: '0.24.0', commit: 'f'.repeat(40) }) as string
    expect(command).toMatch(/^gh release create \\\n {2}v0\.24\.0 \\\n {2}-R temoto-app\/temoto/)
    expect(command).toContain(`--target ${'f'.repeat(40)}`)
    for (const asset of releaseAssets('0.24.0') as string[]) expect(command).toContain(`dist/${asset}`)
  })
  it('TODO 1185: commit を渡さなければ公開の commit に打ったタグを使う (--verify-tag、--target なし)', () => {
    const command = ghReleaseCommand({ version: '0.78.0', commit: null }) as string
    expect(command).toContain('-R temoto-app/temoto')
    expect(command).toContain('--verify-tag')
    expect(command).not.toContain('--target')
    expect(command).toContain('curl -fsSLO https://github.com/temoto-app/temoto/releases/latest/download/install-temoto.sh')
  })
  it('TODO 1185 X-4: ノートは CHANGELOG のその版の節 (--notes-file)。節が無いときだけ入れ方の案内', () => {
    const withFile = ghReleaseCommand({ version: '0.78.0', commit: null, notesFile: 'dist/release-notes-0.78.0.md' }) as string
    expect(withFile).toContain('--notes-file dist/release-notes-0.78.0.md')
    expect(withFile).not.toContain('--notes "')
    expect(ghReleaseCommand({ version: '0.78.0', commit: null }) as string).toContain('--notes "Install and update')
    expect(ghReleaseCommand({ version: '0.78.0', commit: null, assets: null }) as string).toContain('dist/<npm run release')
  })
  it('TODO 1185 X-4: changelogSection は src/shared の extractVersionSection と同じ節を切る', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
    expect(changelogSection(changelog, version)).toBe(extractVersionSection(changelog, version))
    expect(changelogSection(changelog, version)).not.toBeNull()
    const two = '# C\n\n## [2.0.0] - x\n\nb\n\n## [1.0.0] - y\n\na\n'
    expect(changelogSection(two, '2.0.0')).toBe('## [2.0.0] - x\n\nb\n')
    expect(changelogSection(two, '3.0.0')).toBeNull()
    expect(changelogSection(two, '1.0.0')).toBe(extractVersionSection(two, '1.0.0'))
  })
  it('TODO 1144 段 2: 拡張機能ごとの zip は版表の前に並び、gh release create にも添付する', () => {
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

  it('開発機の殻 (Resources/app が symlink) を上書きしない', () => {
    // TODO 1254: looks at both the install destination (Temoto.app) and the location of the shell (the previous name, aios.app).
    expect(script).toContain('for candidate in "$APP" "$LEGACY_APP"; do')
    expect(script).toMatch(/if \[ -L "\$candidate\/Contents\/Resources\/app" \]; then\n\s+die /)
    expect(script).toContain('LEGACY_APP="$HOME/Applications/aios.app"')
  })

  it('zip は ditto で展開し、zip の名前は release と同じ形', () => {
    expect(script).toContain('ditto -x -k')
    expect(script).toContain('zip="$PRODUCT-${version}-arm64-mac.zip"')
  })

  it('バックエンドの名前を持たない (install-backend.sh に任せる、制約 6)', () => {
    const terms = JSON.parse(readFileSync(new URL('../compat/forbidden-terms.json', import.meta.url), 'utf8')) as { terms: string[] }
    for (const term of terms.terms) expect(script.toLowerCase()).not.toContain(term)
  })
})

describe('Developer ID・Hardened Runtime・公証 (TODO 951)', () => {
  const devId = { developerId: true, teamId: 'LVG3JZJZ3U', label: 'Developer ID Application: x (LVG3JZJZ3U)' }
  const selfSigned = { developerId: false, teamId: null, label: 'aios dev (HASH)' }

  it('Developer ID なら Hardened Runtime + timestamp + 公証 (プロファイルの既定は aios)', () => {
    const mode = releaseSigningMode({ sign: devId, env: {} })
    expect(mode).toMatchObject({ hardened: true, timestamp: true, notarize: true, profile: 'aios', teamId: 'LVG3JZJZ3U', skipped: [] })
    expect(NOTARY_PROFILE_DEFAULT).toBe('aios')
    expect(releaseSigningMode({ sign: devId, env: { AIOS_NOTARY_PROFILE: 'other' } }).profile).toBe('other')
    expect(releaseSigningMode({ sign: devId, env: { AIOS_NOTARY_PROFILE: '  ' } }).profile).toBe('aios')
  })

  it('Developer ID でなければ今までどおり (Hardened Runtime なし・公証なし) で、理由を出す', () => {
    const mode = releaseSigningMode({ sign: selfSigned, env: {} })
    expect(mode).toMatchObject({ hardened: false, timestamp: false, notarize: false })
    expect(mode.skipped.join('\n')).toMatch(/公証: 飛ばす \(署名が Developer ID でない: aios dev/)
    expect(mode.skipped.join('\n')).toMatch(/Hardened Runtime: 付けない/)
  })

  it('AIOS_HARDENED_RUNTIME=1 は自己署名でも runtime を付ける (timestamp と公証はしない)。AIOS_NOTARIZE=0 は公証だけ外す', () => {
    expect(releaseSigningMode({ sign: selfSigned, env: { AIOS_HARDENED_RUNTIME: '1' } })).toMatchObject({
      hardened: true,
      timestamp: false,
      notarize: false
    })
    const noNotary = releaseSigningMode({ sign: devId, env: { AIOS_NOTARIZE: '0' } })
    expect(noNotary).toMatchObject({ hardened: true, notarize: false })
    expect(noNotary.skipped).toEqual(['公証: 飛ばす (AIOS_NOTARIZE=0)'])
  })

  it('公証のコマンドはプロファイルの名前だけを渡し、zip は ditto --keepParent、staple は .app に', () => {
    const c = notarizeCommands({ app: '/d/aios.app', zip: '/t/n.zip', profile: 'aios' })
    expect(c.zip).toEqual(['ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '/d/aios.app', '/t/n.zip']])
    expect(c.submit).toEqual(['xcrun', ['notarytool', 'submit', '/t/n.zip', '--keychain-profile', 'aios', '--wait', '--output-format', 'json']])
    expect(c.staple).toEqual(['xcrun', ['stapler', 'staple', '/d/aios.app']])
    expect(c.validate).toEqual(['xcrun', ['stapler', 'validate', '/d/aios.app']])
    expect(c.log('ID')).toEqual(['xcrun', ['notarytool', 'log', 'ID', '--keychain-profile', 'aios']])
    const all = JSON.stringify(c) + JSON.stringify(c.log('ID'))
    expect(all).not.toMatch(/--password|--apple-id|--key\b|--issuer/)
  })

  it('TODO 1243 段 1: DMG の署名・公証・staple・確かめるコマンドは DMG そのものに掛け、認証はプロファイルの名前だけ', () => {
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

  it('notarytool の JSON と spctl の出力を読む', () => {
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

  it('Developer ID の要件は Apple の CA の鎖と Team ID (名前の文字列ではない)', () => {
    const req = developerIdRequirement('LVG3JZJZ3U') as string
    expect(req.startsWith('=anchor apple generic')).toBe(true)
    expect(req).toContain('certificate leaf[subject.OU] = "LVG3JZJZ3U"')
    expect(req).toContain('1.2.840.113635.100.6.2.6')
  })

  it('release.mjs は Developer ID のときだけ公証し、展開した zip で staple・spctl・Team ID を確かめる', () => {
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
  it('消すのは out/ の直下 (check を除く) と dist/ だけ', () => {
    expect(cleanTargets('/repo', ['main', 'check', 'plugins', 'renderer'], true)).toEqual([
      '/repo/out/main',
      '/repo/out/plugins',
      '/repo/out/renderer',
      '/repo/dist'
    ])
    expect(cleanTargets('/repo', ['check'], false)).toEqual([])
  })

  it('危険なパスは消さない (根・node_modules・ソース・out/check・親・out/ の孫・別の根)', () => {
    for (const bad of ['/repo', '/repo/node_modules', '/repo/src', '/repo/out', '/repo/out/check', '/repo/out/main/x', '/repo/out/../src', '/', '/repo/..', '/repo/dist/x', '/other/dist']) {
      expect(isSafeTarget('/repo', bad)).toBe(false)
    }
    for (const good of ['/repo/dist', '/repo/out/main', '/repo/out/.release-head']) expect(isSafeTarget('/repo', good)).toBe(true)
  })

  it('実ファイルで: out/check・node_modules・ソースは残り、他は消える', () => {
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

  it('package.json に clean があり、release.mjs は --skip-build でないとき build の直前に clean を呼ぶ', () => {
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
