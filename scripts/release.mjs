#!/usr/bin/env node
// Makes the Temoto.app for distribution (the version that runs on its own; renamed from aios.app in TODO 1254), and gathers the assets to attach
// to the Release into dist/ (TODO 492, wave 24 bundle B).
//
//   npm run release                 npm run clean → npm run build → electron-builder → checks → assets and SHA256SUMS in dist/
//   node scripts/release.mjs --skip-build   uses out/ as it is (only when the out/.release-head written by the previous release.mjs run without
//                                           --skip-build is the same as HEAD. It cannot be used after npm run check)
//   node scripts/release.mjs --allow-dirty  makes it even with uncommitted changes (the version's mark becomes dirty; do not distribute)
//
// **It does not publish.** At the end it prints a `gh release create …` command, which the owner types by hand (owner decision 2 of TODO 492).
// The configuration is in scripts/release-config.mjs; the signing is in scripts/app-shell.mjs (the same as the shell).
//   node scripts/release.mjs --dry-run      only decides and prints the signing name, Hardened Runtime and notarization (does not build or sign)
//
// Environment variables (Developer ID, Hardened Runtime and notarization were added in TODO 951. The procedure is in docs/notes/app-shell.md):
//   AIOS_SIGN_IDENTITY     the signing name or SHA-1. By default, from the keychain: "Developer ID Application: …" → "aios dev" → ad-hoc + a warning
//   AIOS_NOTARY_PROFILE    the profile name of `xcrun notarytool store-credentials` (default aios). No token is passed or written
//   AIOS_NOTARIZE=0        skip notarization even with Developer ID (to try only the signing)
//   AIOS_HARDENED_RUNTIME=1  add Hardened Runtime + entitlements even without Developer ID (to try the entitlements locally)
// Without a Developer ID, it is as before (no Hardened Runtime, no notarization), and the reason for skipping is printed.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clean } from './clean.mjs'
import { signReleaseSums } from './plugin-signing.mjs'
import { RELEASE_BUNDLE_ID, ENTITLEMENTS, readCodesigningIdentities, resolveSignIdentity, signApp } from './app-shell.mjs'
import {
  ELECTRON_HELPER_PREFIX,
  INSTALL_SCRIPT,
  developerIdRequirement,
  ghReleaseCommand,
  writeReleaseNotes,
  notarizeCommands,
  parseCodesignDetail,
  parseNotarySubmit,
  parseSpctl,
  PLUGIN_VERSIONS_ASSET,
  RELEASE_REPO,
  collectPluginFiles,
  dmgCommands,
  dmgInspectCommands,
  dmgName,
  pluginAssetName,
  pluginBundleZip,
  pluginVersionTable,
  pluginVersionTableText,
  releaseSigningMode,
  teamIdProblem,
  releaseAssets,
  releaseConfig,
  restoreElectronHelpers,
  sha256SumsText,
  zipName,
  APP_BUNDLE,
} from './release-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const args = new Set(process.argv.slice(2))
for (const arg of args) {
  if (!['--skip-build', '--allow-dirty', '--dry-run'].includes(arg)) {
    console.error(`release: 知らないオプション: ${arg}`)
    process.exit(2)
  }
}

const say = (line) => console.log(`release: ${line}`)
const die = (line) => {
  console.error(`release: ${line}`)
  process.exit(1)
}
const run = (cmd, argv, options = {}) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', ...options })

if (process.platform !== 'darwin') die('macOS 専用。')
if (process.arch !== 'arm64') die('Apple Silicon (arm64) の Mac で作る (配るのは arm64 だけ)。')

// --- 0. Signing name and stage (TODO 951) ----------------------------------------------------------
// The keychain is only read, with `security find-identity` (nothing is written and no dialog is shown). Even when AIOS_SIGN_IDENTITY is given,
// it is checked against the list to decide whether it is a Developer ID.
const sign = resolveSignIdentity({
  env: process.env.AIOS_SIGN_IDENTITY,
  findIdentityOutput: readCodesigningIdentities(),
  preferDeveloperId: true,
})
// Stop before signing (also with --dry-run). Without a Team ID, the check after signing and notarization fails with a message that makes no sense (review 58-5).
const teamProblem = teamIdProblem(sign)
if (teamProblem !== null) die(teamProblem)
const mode = releaseSigningMode({ sign, env: process.env })
if (sign.warning) console.warn(`release: 警告: ${sign.warning}`)
say(`署名: ${sign.label}${sign.developerId ? ` (Developer ID、Team ID ${sign.teamId ?? '?'})` : ''}`)
say(`Hardened Runtime: ${mode.hardened ? `付ける (${ENTITLEMENTS.app} / ${ENTITLEMENTS.helper})` : '付けない'}`)
say(`公証: ${mode.notarize ? `する (notarytool のプロファイル "${mode.profile}")` : 'しない'}`)
for (const line of mode.skipped) say(line)
if (sign.adhoc) console.warn('release: 警告: ad-hoc の版は自動更新 (src/main/update/stage.ts) が受けない (受けるのは Developer ID と aios dev)')
const hardened = mode.hardened
  ? { app: join(root, ENTITLEMENTS.app), helper: join(root, ENTITLEMENTS.helper), timestamp: mode.timestamp }
  : null
for (const file of hardened ? [hardened.app, hardened.helper] : []) if (!existsSync(file)) die(`entitlements が無い: ${file}`)
if (args.has('--dry-run')) {
  say('--dry-run: ここで止める (ビルド・署名・公証はしない)')
  process.exit(0)
}
if (mode.notarize) {
  // Before the heavy build, check that the profile exists and that it reaches Apple (if not, show how to make it, and stop).
  const [cmd, argv] = notarizeCommands({ app: '', zip: '', profile: mode.profile }).preflight
  const probe = spawnSync(cmd, argv, { encoding: 'utf8' })
  if (probe.status !== 0) {
    die(
      `notarytool のプロファイル "${mode.profile}" が使えない (終了コード ${probe.status})。` +
        `xcrun notarytool store-credentials ${mode.profile} で作る (docs/notes/app-shell.md の「オーナーが手でやること」)。` +
        '公証せずに作るなら AIOS_NOTARIZE=0',
    )
  }
  say(`notarytool のプロファイル "${mode.profile}" は使える`)
}

// --- 1. Working tree ---------------------------------------------------------------------------
const commit = run('git', ['rev-parse', 'HEAD']).trim()
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).trim() !== ''
if (dirty && !args.has('--allow-dirty')) {
  die('未 commit の変更がある。commit してから作る (版の札 __AIOS_BUILD__ が dirty になるため。試すだけなら --allow-dirty)')
}
say(`版 ${version} / commit ${commit.slice(0, 12)}${dirty ? ' (dirty)' : ''}`)

// --- 2. Build ---------------------------------------------------------------------------
if (args.has('--skip-build')) {
  say('npm run build は飛ばす (--skip-build)')
} else {
  // TODO 1203: build from an empty state (no old plugins or helpers from out/ remain. out/check/ remains).
  const removed = clean(root)
  say(`out/ と dist/ を空にした (${removed.length} 件、out/check/ は残す)`)
  say('npm run build')
  // TODO 1190: the mark of the distributed version does not embed the commit of the build source (with AIOS_RELEASE=1 the commit is unknown, and the date is the build time)
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env, AIOS_RELEASE: '1' } })
  // Keep "which HEAD it was made from" outside the bundle (not put into the bundle; it is also excluded from the zip with !out/.release-head).
  writeFileSync(join(root, 'out', '.release-head'), `${commit}\n`)
}
const mainBundle = join(root, 'out', 'main', 'index.js')
if (!existsSync(mainBundle)) die(`ビルド成果物が無い: ${mainBundle}`)
for (const helper of [
  'speech-helper/speech-helper',
  'pdf-helper/pdf-helper',
  'vision-helper/vision-helper',
  'input-source-helper/input-source-helper'
]) {
  // If swiftc is missing, the helpers are not made, with a warning (build:speech / build:input-source). The distributed version must not lack them.
  if (!existsSync(join(root, 'out', helper))) die(`ヘルパーが無い: out/${helper} (Command Line Tools の swiftc が要る)`)
}
if (!existsSync(join(root, 'out', 'plugins'))) die('out/plugins が無い (npm run build:plugins)')

// --skip-build accepts only a previous release build made from the current HEAD (so that the out/ of an old commit is not packed; review Y-4).
if (args.has('--skip-build')) {
  const headFile = join(root, 'out', '.release-head')
  const built = existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : ''
  if (built !== commit) {
    die(`out/ は今の HEAD から作った release ビルドでない (out/.release-head: ${built.slice(0, 12) || '無し'} / HEAD: ${commit.slice(0, 12)})。--skip-build を外して作り直す`)
  }
}

// Is the version mark (TODO 316 / 1190) that of a distributed version? It does not embed the commit of the build source (the commit is unknown).
// It stops --skip-build from packing the out/ of a development build (which has a commit).
const stampedCommits = new Set()
for (const name of ['index.js', ...readdirSync(join(root, 'out', 'main', 'chunks')).map((n) => `chunks/${n}`)]) {
  const text = readFileSync(join(root, 'out', 'main', name), 'utf8')
  for (const m of text.matchAll(/"?commit"?:\s*"([0-9a-f]{40,64}|unknown)"/g)) stampedCommits.add(m[1])
}
if (stampedCommits.size !== 1 || !stampedCommits.has('unknown')) {
  die(`out/main の版の札が配る版の形でない (commit: ${[...stampedCommits].map((c) => c.slice(0, 12)).join(', ') || '無し'})。AIOS_RELEASE=1 npm run build し直す (ビルド元 の commit を札に入れない)`)
}

// --- 3. electron-builder -----------------------------------------------------------------
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })


/** Right after electron-builder assembles the .app (before the zip), signs it in the same order as the shell. */
async function afterPack(context) {
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Copying from electronDist leaves Electron's default app behind (it has no effect, because Resources/app is read first, but it is removed as the shell does).
  rmSync(join(app, 'Contents', 'Resources', 'default_app.asar'), { force: true })
  // TODO 499: restores the Helpers to `Electron Helper*.app` (before signing). If they are left renamed, Electron treats the app as packaged and drops
  // NODE_OPTIONS, and plugin-host's Node permission model is silently lost.
  const restored = restoreElectronHelpers(app, context.packager.appInfo.productFilename)
  say(`Helper を既定の名前に戻した: ${restored.length} 件 (${restored.map((s) => s.toApp).join(', ')})`)
  say(`署名する: ${app}`)
  // TODO 1254: the main binary of the distributed version has the productName's name (`Contents/MacOS/Temoto`), not the shell's default (`aios`).
  const plan = signApp(app, sign.identity, { hardened, bundleId: RELEASE_BUNDLE_ID, mainExecutable: `Contents/MacOS/${context.packager.appInfo.productFilename}` })
  say(`署名した: ${plan.length} 件${hardened ? ' (Hardened Runtime + entitlements)' : ''}`)
  if (mode.notarize) notarize(app)
}

/**
 * TODO 951: sends the signed .app for notarization, and staples it to the .app (a zip cannot be stapled, so this is before electron-builder makes the zip).
 * Authentication is only the name of the keychain profile. The result prints only the id and status (Apple's record can be looked up with notarytool log).
 */
function notarize(app) {
  const work = mkdtempSync(join(tmpdir(), 'aios-notarize-'))
  try {
    const commands = notarizeCommands({ app, zip: join(work, 'aios-notarize.zip'), profile: mode.profile })
    run(...commands.zip)
    say('公証に出す (notarytool submit --wait。数分かかる)')
    const submit = spawnSync(...commands.submit, { encoding: 'utf8' })
    const result = parseNotarySubmit(submit.stdout ?? '')
    say(`公証: id ${result.id ?? '?'} / status ${result.status ?? '?'}`)
    if (submit.status !== 0 || result.status !== 'Accepted') {
      if (result.id !== null) {
        const log = spawnSync(...commands.log(result.id), { encoding: 'utf8' })
        console.error(log.stdout)
      }
      die(`公証が通らなかった (status ${result.status ?? '?'}、終了コード ${submit.status})。上の notarytool log を見る`)
    }
    run(...commands.staple, { stdio: ['ignore', 'pipe', 'pipe'] })
    run(...commands.validate, { stdio: ['ignore', 'pipe', 'pipe'] })
    say('公証: Accepted → stapler staple / validate が通った')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const { build, Platform, Arch } = await import('electron-builder')
await build({
  projectDir: root,
  targets: Platform.MAC.createTarget(['zip', 'dmg'], Arch.arm64),
  config: releaseConfig({ version, afterPack }),
  publish: 'never',
})

const zipPath = join(dist, zipName(version))
if (!existsSync(zipPath)) die(`zip ができていない: ${zipPath}`)
const dmgPath = join(dist, dmgName(version))
if (!existsSync(dmgPath)) die(`DMG ができていない: ${dmgPath}`)

// --- 3.5 Signing, notarization and stapling of the DMG (TODO 1243 stage 1) ---------------------------------------------
// The .app is already notarized in afterPack. The DMG itself also gets Developer ID signing, notarization and stapling (so it passes even offline, right after download).
// Without a Developer ID, neither signing nor notarization is done (an ad-hoc DMG has no meaning; the reason is printed).
if (sign.developerId) {
  const dmg = dmgCommands({ dmg: dmgPath, identity: sign.identity, profile: mode.profile })
  const dmgCheck = dmgInspectCommands({ dmg: dmgPath })
  run(...dmg.sign, { stdio: ['ignore', 'pipe', 'pipe'] })
  run(...dmgCheck.verifySign, { stdio: ['ignore', 'pipe', 'pipe'] })
  say(`DMG に署名した: ${dmgName(version)}`)
  if (mode.notarize) {
    say('DMG を公証に出す (notarytool submit --wait。数分かかる)')
    const submit = spawnSync(...dmg.submit, { encoding: 'utf8' })
    const result = parseNotarySubmit(submit.stdout ?? '')
    say(`DMG の公証: id ${result.id ?? '?'} / status ${result.status ?? '?'}`)
    if (submit.status !== 0 || result.status !== 'Accepted') {
      if (result.id !== null) console.error(spawnSync(...dmg.log(result.id), { encoding: 'utf8' }).stdout)
      die(`DMG の公証が通らなかった (status ${result.status ?? '?'}、終了コード ${submit.status})。上の notarytool log を見る`)
    }
    run(...dmg.staple, { stdio: ['ignore', 'pipe', 'pipe'] })
    run(...dmgCheck.validate, { stdio: ['ignore', 'pipe', 'pipe'] })
    say('DMG の公証: Accepted → stapler staple / validate が通った')
  }
} else {
  say('DMG: 署名しない・公証しない (Developer ID でない)')
}

// --- 4. Checks: expand with ditto as the users do, and look at the signature and the contents ----------------------------
const check = mkdtempSync(join(tmpdir(), 'aios-release-'))
/** TODO 1144 stage 1: the extension version table. Made from the manifests inside the expanded .app (= what is distributed). */
let pluginTable = null
/** TODO 1144 stage 2: the names of the zips of each extension (inside dist/, in id order). */
let pluginAssets = []
try {
  run('ditto', ['-x', '-k', zipPath, check])
  const app = join(check, APP_BUNDLE)
  if (!existsSync(app)) die(`zip の中に ${APP_BUNDLE} が無い (${readdirSync(check).join(', ')})`)
  // --strict drops a "symlink that points outside the bundle". It did not pass for the shell (Resources/app → the repo), but the distributed version passes.
  run('codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'pipe', 'pipe'] })
  // codesign -d writes its result to stderr.
  const detail = parseCodesignDetail(spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr)
  const identifier = detail.identifier
  const authority = detail.authorities[0] ?? (detail.adhoc ? 'ad-hoc' : '?')
  if (identifier !== RELEASE_BUNDLE_ID) die(`署名の identifier が ${RELEASE_BUNDLE_ID} でない: ${identifier}`)
  say(`署名: Identifier=${identifier} / Authority=${authority} / TeamIdentifier=${detail.teamId ?? 'not set'}`)
  if (hardened) {
    // TODO 951: whether Hardened Runtime is on the main binary and on the Helpers (the condition of notarization).
    for (const rel of ['', 'Contents/Frameworks/Electron Helper.app', 'Contents/Frameworks/Electron Helper (Renderer).app']) {
      const d = parseCodesignDetail(spawnSync('codesign', ['-dv', '--verbose=2', join(app, rel)], { encoding: 'utf8' }).stderr)
      if (!d.runtime) die(`Hardened Runtime が付いていない: ${rel || APP_BUNDLE}`)
    }
    say('検証: 本体と Helper に Hardened Runtime (flags=runtime)')
  }
  if (sign.developerId) {
    if (detail.teamId !== sign.teamId) die(`署名の Team ID が ${sign.teamId} でない: ${detail.teamId}`)
    const req = spawnSync('codesign', ['--verify', '--strict', '-R', developerIdRequirement(sign.teamId ?? ''), app], { encoding: 'utf8' })
    if (req.status !== 0) die(`Developer ID (Team ID ${sign.teamId}) の要件を満たさない: ${req.stderr.trim()}`)
    say(`検証: Developer ID の要件 (Apple の CA の鎖 + Team ID ${sign.teamId}) を満たす`)
  }
  if (mode.notarize) {
    // The same judgment as on the user's Mac (Gatekeeper). It also checks, on the copy expanded from the zip, that the staple is inside the zip.
    if (!detail.stapled) die('展開した .app に公証の ticket が staple されていない')
    run('xcrun', ['stapler', 'validate', app], { stdio: ['ignore', 'pipe', 'pipe'] })
    const assess = parseSpctl(spawnSync('spctl', ['-a', '-vv', '-t', 'exec', app], { encoding: 'utf8' }).stderr)
    if (!assess.accepted || assess.source !== 'Notarized Developer ID') {
      die(`Gatekeeper が受けない (spctl: ${assess.accepted ? 'accepted' : 'rejected'} / source=${assess.source ?? '?'})`)
    }
    say('検証: stapler validate が通り、spctl -a は accepted / source=Notarized Developer ID')
  }
  // TODO 499: whether the Helpers keep their default names (if they are renamed, plugin-host's permission model does not take effect).
  const frameworks = readdirSync(join(app, 'Contents', 'Frameworks'))
  const renamed = frameworks.filter((name) => / Helper.*\.app$/.test(name) && !name.startsWith(`${ELECTRON_HELPER_PREFIX} Helper`))
  if (renamed.length > 0 || !frameworks.includes(`${ELECTRON_HELPER_PREFIX} Helper.app`)) {
    die(`Helper が既定の名前でない (${renamed.join(', ') || 'Electron Helper.app が無い'})。plugin-host の permission model が外れる (TODO 499)`)
  }
  const appDir = join(app, 'Contents', 'Resources', 'app')
  if (!existsSync(appDir) || lstatSync(appDir).isSymbolicLink()) die('Contents/Resources/app が実ディレクトリでない')
  for (const rel of [
    'out/main/index.js',
    'out/main/gateway.js',
    'out/speech-helper/speech-helper',
    'out/pdf-helper/pdf-helper',
    'out/vision-helper/vision-helper',
    'out/input-source-helper/input-source-helper',
    'compat/backend-paths.json',
    // TODO 1174: the bundled Help.
    'resources/help/index.html',
    // TODO 1269: the menu bar template image.
    'resources/tray/trayTemplate.png',
    // TODO 1302: the menu bar image shown while a conversation is running.
    'resources/tray/trayRunningTemplate.png',
    // TODO 1186: the bundled change history.
    'CHANGELOG.md',
    'node_modules/better-sqlite3-multiple-ciphers/prebuilds/darwin-arm64.node',
    'node_modules/@parcel/watcher-darwin-arm64/watcher.node',
    'node_modules/kuromoji/dict/base.dat.gz',
  ]) {
    if (!existsSync(join(appDir, rel))) die(`展開した .app に無い: Resources/app/${rel}`)
  }
  say('検証: ditto -x -k で展開 → codesign --verify --deep --strict が通った / 中身が揃っている / Helper は既定の名前')
  const pluginsDir = join(appDir, 'out', 'plugins')
  const pluginDirs = readdirSync(pluginsDir).filter((name) => existsSync(join(pluginsDir, name, 'manifest.json')))
  const manifests = pluginDirs.map((name) => JSON.parse(readFileSync(join(pluginsDir, name, 'manifest.json'), 'utf8')))
  if (manifests.length === 0) die('展開した .app に拡張機能の manifest が無い: Resources/app/out/plugins/*/manifest.json')
  // TODO 1144 stage 2: the bundle zip of each extension (the contents of the .app that is distributed). The aios "update" checks the SHA-256 and expands it.
  const assets = {}
  pluginDirs.forEach((name, index) => {
    const { id, version: pluginVersion } = manifests[index]
    if (typeof id !== 'string' || typeof pluginVersion !== 'string') die(`${name}: manifest の id / version が無い`)
    const asset = pluginAssetName(id, pluginVersion)
    const bytes = pluginBundleZip(collectPluginFiles(join(pluginsDir, name)))
    writeFileSync(join(dist, asset), bytes)
    assets[id] = { asset, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  pluginTable = pluginVersionTable({ version, manifests, assets })
  pluginAssets = Object.values(pluginTable.plugins).map((entry) => entry.asset)
  say(`拡張機能の版表: ${Object.entries(pluginTable.plugins).map(([id, e]) => `${id} ${e.version}`).join(', ')}`)
  say(`拡張機能ごとの資産: ${pluginAssets.length} 個 (${pluginAssets.join(', ')})`)
} finally {
  rmSync(check, { recursive: true, force: true })
}

// --- 4.5 Checks: the DMG (TODO 1243 stage 1) ---------------------------------------------------------
// It is mounted read-only, and the contents (only a link to Temoto.app and /Applications) and the signature of the .app are looked at. The mount is always detached.
{
  /** @param {string} message @returns {never} */
  const fail = (message) => {
    throw new Error(message)
  }
  const dmg = dmgInspectCommands({ dmg: dmgPath })
  const mountpoint = mkdtempSync(join(tmpdir(), 'aios-dmg-'))
  let attached = false
  // `die` calls process.exit, so finally does not run. Inside try, throw instead, and call die after the detach and the deletion.
  let failure = null
  try {
    run(...dmg.attach(mountpoint), { stdio: ['ignore', 'pipe', 'pipe'] })
    attached = true
    const entries = readdirSync(mountpoint).filter((name) => !name.startsWith('.'))
    if (!entries.includes(APP_BUNDLE)) fail(`DMG の中に ${APP_BUNDLE} が無い (${entries.join(', ')})`)
    const link = join(mountpoint, 'Applications')
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) fail('DMG の中に Applications へのリンクが無い')
    const mounted = join(mountpoint, APP_BUNDLE)
    run('codesign', ['--verify', '--deep', '--strict', mounted], { stdio: ['ignore', 'pipe', 'pipe'] })
    const inside = parseCodesignDetail(spawnSync('codesign', ['-dv', '--verbose=2', mounted], { encoding: 'utf8' }).stderr)
    if (inside.identifier !== RELEASE_BUNDLE_ID) fail(`DMG の中の署名の identifier が ${RELEASE_BUNDLE_ID} でない: ${inside.identifier}`)
    if (mode.notarize && !inside.stapled) fail('DMG の中の .app に公証の ticket が staple されていない')
    say(`検証: DMG の中は ${entries.join(', ')} / .app の署名が通った`)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    if (attached) spawnSync(...dmg.detach(mountpoint), { encoding: 'utf8' })
    rmSync(mountpoint, { recursive: true, force: true })
  }
  if (failure !== null) die(failure)
  if (mode.notarize) {
    run(...dmg.validate, { stdio: ['ignore', 'pipe', 'pipe'] })
    const assess = parseSpctl(spawnSync(...dmg.assess, { encoding: 'utf8' }).stderr)
    if (!assess.accepted || assess.source !== 'Notarized Developer ID') {
      die(`Gatekeeper が DMG を受けない (spctl: ${assess.accepted ? 'accepted' : 'rejected'} / source=${assess.source ?? '?'})`)
    }
    say('検証: DMG の stapler validate が通り、spctl -a -t open は accepted / source=Notarized Developer ID')
  }
}

// --- 5. The rest to attach, and SHA256SUMS ---------------------------------------------------------
copyFileSync(join(root, 'scripts', INSTALL_SCRIPT), join(dist, INSTALL_SCRIPT))
copyFileSync(join(root, 'compat', 'install-backend.sh'), join(dist, 'install-backend.sh'))
// TODO 1144 stage 1: the extension version table (it is also listed in SHA256SUMS; aios reads it after checking the SHA-256).
writeFileSync(join(dist, PLUGIN_VERSIONS_ASSET), pluginVersionTableText(pluginTable))
const assets = releaseAssets(version, pluginAssets).filter((name) => name !== 'SHA256SUMS')
const sums = assets.map((name) => ({
  name,
  sha256: createHash('sha256').update(readFileSync(join(dist, name))).digest('hex'),
}))
writeFileSync(join(dist, 'SHA256SUMS'), sha256SumsText(sums))
// TODO 1144 stage 4: signs with Ed25519 right after writing SHA256SUMS (the secret key is outside the repo. While the public key is empty, it warns and
// goes on even without a key; if one is embedded, it fails).
// A stale SHA256SUMS.sig left in dist/ is not used (it is removed first, so that an unsigned run does not attach it).
rmSync(join(dist, 'SHA256SUMS.sig'), { force: true })
let signed = false
try {
  const result = signReleaseSums({ distDir: dist, writeFile: writeFileSync, root })
  signed = result.signed
  if (result.warning !== null) say(`警告: ${result.warning}`)
} catch (err) {
  console.error(`release: ${err.message}`)
  process.exit(1)
}

console.log('')
say(`できた (dist/):${signed ? ' + SHA256SUMS.sig (拡張機能の署名)' : ''}`)
for (const { name, sha256 } of sums) console.log(`  ${sha256}  ${name}`)
console.log('')
// TODO 1185: the Release is made in the public repo. The tag v<version> is put on the public commit and pushed beforehand (if --verify-tag is missing, it stops).
say(`公開はオーナーが手で (このスクリプトは上げない)。タグ v${version} を ${RELEASE_REPO} に push してから:`)
console.log('')
console.log(ghReleaseCommand({ version, commit: null, pluginAssets, signed, notesFile: writeReleaseNotes(root, version) }))
console.log('')
say(`identifier: ${RELEASE_BUNDLE_ID} / 署名: ${sign.label} / Hardened Runtime: ${mode.hardened ? 'あり' : 'なし'} / 公証: ${mode.notarize ? 'Accepted + staple' : 'なし'}`)
for (const line of mode.skipped) say(line)
