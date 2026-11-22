/**
 * The electron-builder configuration that makes `Temoto.app` for distribution (the version that runs on its own) (TODO 492, wave 24 bundle B).
 *
 * `scripts/release.mjs` (`npm run release`) passes this configuration to electron-builder's API. The configuration is written in JS so that
 * the same values as the shell (`scripts/make-app.mjs`: the identifiers, the Info.plist wording, the signing order) are read from
 * `scripts/app-shell.mjs` in one place. The pure parts (`releaseConfig` / `extendInfoFromOps` / `zipName`) are checked by test/release-config.test.ts.
 * The only thing that touches files is `restoreElectronHelpers` (TODO 499, restores the Helpers to their default names); the list of renames
 * it makes is built by the pure `helperRestorePlan`. Both are checked by the tests (the former with fs / PlistBuddy swapped out).
 *
 * What was decided ("Distribution" in docs/notes/app-shell.md, and docs/ARCHITECTURE.md 8.4):
 * - **No asar** (`asar: false`). plugin-host passes realpath to Node's permission model `--allow-fs-read`
 *   (`src/main/plugin/host.ts`); the gateway runs Electron itself as Node with `ELECTRON_RUN_AS_NODE=1` and reads
 *   `out/main/gateway.js`; and the two helpers and the compat/ tables are looked up by relative path from `app.getAppPath()` / `import.meta.dirname`.
 *   All of these assume that real files are in `Contents/Resources/app/`. With the same shape as the shell (a symlink to the repo), no line of code
 *   has to change. asar + `asarUnpack` will be reviewed under TODO 494 / 103 stage 2 (auto-update and notarization).
 * - **Electron uses `node_modules/electron/dist` as it is** (`electronDist`). It is not downloaded again, so it is the same version as the shell.
 * - **Native modules are not rebuilt** (`npmRebuild: false`). `better-sqlite3-multiple-ciphers` and `@parcel/watcher` both ship N-API prebuilds
 *   (`prebuilds/darwin-arm64.node` / `@parcel/watcher-darwin-arm64`), which do not depend on Electron's ABI.
 * - **Signing is not left to electron-builder** (`identity: null`). `afterPack` calls `signApp` from `scripts/app-shell.mjs`, and, as with the shell,
 *   it signs from the inside out: "`aios dev` if it is there, otherwise ad-hoc + a warning". electron-builder's signing looks only for Developer ID /
 *   Apple Development certificates, and does not pick up the self-signed `aios dev`.
 * - **The Helpers are distributed under the `Electron Helper*.app` names** (TODO 499, `restoreElectronHelpers`). If they are renamed, Electron treats
 *   the app as packaged and drops NODE_OPTIONS, and plugin-host's Node permission model is lost.
 * - The fuses are not touched (`electronFuses` is not set). Turning off `RunAsNode` stops the gateway from running (docs/notes/app-shell.md).
 * - **TODO 951: Developer ID, Hardened Runtime and notarization are not left to electron-builder either.** If `Developer ID Application: …` is in the
 *   keychain, `signApp` signs with it, attaching `--options runtime --timestamp` and the entitlements (`build/entitlements*.plist`). release.mjs's afterPack
 *   then runs `notarytool submit --wait` and `stapler staple`, and only after that does electron-builder make the zip (`releaseSigningMode` /
 *   `notarizeCommands`). If there is no Developer ID, it is as before: `aios dev` / ad-hoc, with no Hardened Runtime and no notarization.
 *   The `hardenedRuntime: false` below is a setting for electron-builder's own signing; since `identity: null`, it has no effect (signApp adds it).
 *   There are two distributed items: the zip (which auto-update and install-temoto.sh read), and the DMG (TODO 1243 stage 1: the entry that a person
 *   downloads in a browser and drags into Applications; release.mjs applies signing, notarization and stapling to the DMG too).
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { RELEASE_BUNDLE_ID, infoPlistOps } from './app-shell.mjs'
import product from '../src/shared/product.json' with { type: 'json' }

/**
 * TODO 1254: the public product name (`Temoto`). `src/shared/product.json` is the source of truth (the same value as `PRODUCT_NAME` in main and the renderer).
 * electron-builder makes the .app and the executable this name (`Temoto.app/Contents/MacOS/Temoto`).
 */
export const PRODUCT_NAME = product.name
/** The name of the .app to distribute (`Temoto.app`; the contents of the zip and the DMG, and the name that install-temoto.sh and auto-update look for). */
export const APP_BUNDLE = `${PRODUCT_NAME}.app`
/** TODO 1263: the installer attached to each Release (`install-temoto.sh`; `scripts/install-temoto.sh` in this repo). */
export const INSTALL_SCRIPT = product.installScript

/** The name of the zip to distribute. The asset name in the Release is this too (install-temoto.sh looks for `Temoto-<version>-arm64-mac.zip`). */
export function zipName(version) {
  return `${PRODUCT_NAME}-${version}-arm64-mac.zip`
}

/** TODO 1243 stage 1: the name of the DMG to distribute (the entry that a person downloads). Auto-update and install-temoto.sh do not read it (only the zip). */
export function dmgName(version) {
  return `${PRODUCT_NAME}-${version}-arm64.dmg`
}

/** Of the operations on the shell's Info.plist, the keys that electron-builder writes itself (name, identifier, version, icon). */
const MANAGED_BY_BUILDER = new Set([
  'CFBundleExecutable',
  'CFBundleName',
  'CFBundleDisplayName',
  'CFBundleIdentifier',
  'CFBundleIconFile',
  'CFBundleShortVersionString',
  'CFBundleVersion',
])

/** Removes the double quotes that were added to pass values to PlistBuddy. */
function unquote(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/**
 * Maps `infoPlistOps` (the list of operations on the shell's Info.plist) to electron-builder's `mac.extendInfo` (a dictionary that is merged deeply).
 * `delete` becomes `null` (electron-builder removes a key whose value is null). `add` with `A:0:B` is built into arrays and dictionaries.
 * The keys that electron-builder writes itself are removed (they come from `appId` / `productName` / `version` / `icon`).
 * @param {ReturnType<typeof infoPlistOps>} ops
 */
export function extendInfoFromOps(ops) {
  /** @type {Record<string, unknown>} */
  const info = {}
  for (const op of ops) {
    const [top] = op.key.split(':')
    if (MANAGED_BY_BUILDER.has(top)) continue
    if (op.op === 'delete') {
      // If the same key is added again later (CFBundleDocumentTypes), that add overwrites it.
      info[op.key] = null
      continue
    }
    const value =
      op.type === 'array' ? [] : op.type === 'dict' ? {} : op.type === 'bool' ? op.value === 'true' : unquote(op.value)
    const path = op.key.split(':')
    /** @type {any} */
    let node = info
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = /^\d+$/.test(path[i]) ? Number(path[i]) : path[i]
      if (node[segment] === null || node[segment] === undefined) node[segment] = /^\d+$/.test(path[i + 1]) ? [] : {}
      node = node[segment]
    }
    const last = path[path.length - 1]
    node[/^\d+$/.test(last) ? Number(last) : last] = value
  }
  return info
}

/**
 * The electron-builder configuration.
 * @param {{ version: string, afterPack?: (context: unknown) => Promise<void> }} options
 */
export function releaseConfig({ version, afterPack }) {
  return {
    appId: RELEASE_BUNDLE_ID,
    // Constraint 5: do not put the name of the backend in the product name or the logo. TODO 1254: the public name (`src/shared/product.json`).
    productName: PRODUCT_NAME,
    directories: { output: 'dist', buildResources: 'build' },
    electronDist: 'node_modules/electron/dist',
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    // The owner publishes by running `gh release create` by hand (owner decision 2 of TODO 492). electron-builder is not allowed to upload it.
    publish: null,
    files: [
      'package.json',
      // Includes `out/local-provider/` (TODO 1315): the bundled local-model provider that the second backend imports by `file://` URL.
      // That backend is a separate program and cannot read inside an asar, so if asar is ever turned on this directory must be unpacked.
      'out/**/*',
      '!out/.built-commit',
      // TODO 1190 review Y-4: the file that release.mjs writes with the HEAD at build time. Do not put the hash of the build source into the distributed build.
      '!out/.release-head',
      // The mark of `npm run check` and the record of flaky tests (they carry the commit of the build source). Not included in the zip that is distributed.
      '!out/check/**',
      // The tables read at run time (src/main/session/adapter/compat.ts looks up `out/main/../../compat`; exclusions are already bundled).
      'compat/*.json',
      // The bundled Help (TODO 1174, ARCHITECTURE 7.4.13). main reads `<appPath>/resources/help/`, the same as in dev and in the shell,
      // so it is placed inside the app, not in extraResources (directly under Contents/Resources/).
      'resources/help/**',
      // The menu bar template images (TODO 1269). main reads `<appPath>/resources/tray/` (same place logic as Help).
      'resources/tray/**',
      // The static page a window shows after its renderer kept dying (TODO 1319). main reads `<appPath>/resources/recovery/`.
      'resources/recovery/**',
      // The bundled change history (TODO 1186, section 5 of `docs/notes/public-repo.md`). main reads `<appPath>/CHANGELOG.md`.
      'CHANGELOG.md',
      // The native modules' sources, and the prebuilds for other OSes and CPUs, are not needed.
      '!**/node_modules/better-sqlite3-multiple-ciphers/{deps,src,build}/**',
      '!**/node_modules/better-sqlite3-multiple-ciphers/prebuilds/{darwin-x64,linux-*,linuxmusl-*,win32-*}.node',
      '!**/node_modules/@parcel/watcher/{build,src}/**',
      '!**/node_modules/@parcel/watcher/binding.gyp',
    ],
    mac: {
      target: [
        { target: 'zip', arch: ['arm64'] },
        // TODO 1243 stage 1: also make a DMG. The zip is kept for auto-update and install-temoto.sh (the update mechanism is not changed).
        { target: 'dmg', arch: ['arm64'] },
      ],
      icon: 'build/icon.icns',
      category: 'public.app-category.developer-tools',
      identity: null,
      // electron-builder's own signing setting (it has no effect, since identity: null means no signing). Hardened Runtime is added by signApp (TODO 951).
      hardenedRuntime: false,
      gatekeeperAssess: false,
      // `aios://`'s `CFBundleURLTypes` (TODO 976 stage 3) also comes in from here. electron-builder's `protocols` is not used:
      // writing the same key in two places could mix arrays through extendInfo's deep merge, so it is kept in one place, in infoPlistOps, as in the shell.
      extendInfo: extendInfoFromOps(infoPlistOps({ version, bundleId: RELEASE_BUNDLE_ID })),
      // `${version}` is filled in by electron-builder (the same form as zipName).
      artifactName: zipName('${version}'),
    },
    // TODO 1243 stage 1: the look is minimal (only a link to Temoto.app and /Applications; no background image). electron-builder is not allowed to sign it
    // (signing, notarization and stapling are applied by release.mjs to the DMG itself, after the notarized .app is put in it).
    // `artifactName` overrides mac.artifactName (the zip).
    dmg: {
      title: `${PRODUCT_NAME} \${version}`,
      artifactName: dmgName('${version}'),
      format: 'UDZO',
      sign: false,
      window: { width: 540, height: 380 },
      contents: [
        { x: 140, y: 190, type: 'file' },
        { x: 400, y: 190, type: 'link', path: '/Applications' },
      ],
    },
    afterPack,
  }
}

/**
 * The head of the default name of Electron's Helpers (TODO 499).
 *
 * **Electron (measured on 44) treats the app as "packaged" unless the name of the Helper that runs the utility process is `Electron Helper*`,
 * and then it drops most of `NODE_OPTIONS`** (stderr shows `Most NODE_OPTIONs are not supported in packaged apps.`). plugin-host's Node permission
 * model (`--permission` / `--allow-fs-read`) is passed only through NODE_OPTIONS (the `execArgv` of `utilityProcess.fork` only lands in
 * `process.execArgv`, and has no effect either under the default name or when packaged; measured in wave 25 bundle H). So if electron-builder renames
 * the Helpers to `<productName> Helper*.app`, the permission model is lost silently. electron-builder has no setting to stop the rename (`moveHelpers`
 * in `app-builder-lib/out/electron/electronMac.js` always renames to `sanitizedProductName`), so the Helpers are restored to their default names in
 * `afterPack` (before signing). Electron itself looks for `Electron Helper.app` first and, if that is missing, for `<CFBundleName> Helper.app`
 * (electron_main_delegate_mac.mm). So after the restore, the way the app launches is the same as the dogfood shell (which does not rename the Helpers).
 */
export const ELECTRON_HELPER_PREFIX = 'Electron'

/**
 * Makes the list of renames that returns the names of the items in `Contents/Frameworks/` to the default names (pure).
 * It picks up only `<productFilename> Helper….app` (it leaves the Framework, the items still named `Electron Helper*`, and other .apps alone).
 * @param {readonly string[]} names the names of the items in `Frameworks/`
 * @param {string} productFilename electron-builder's `appInfo.productFilename` (Temoto)
 * @returns {Array<{ fromApp: string, toApp: string, fromExe: string, toExe: string }>}
 */
export function helperRestorePlan(names, productFilename) {
  const head = `${productFilename} Helper`
  const plan = []
  for (const name of [...names].sort()) {
    if (!name.startsWith(head) || !name.endsWith('.app')) continue
    const suffix = name.slice(head.length, -'.app'.length) // '' / ' (GPU)' / ' (Renderer)' / ' (Plugin)' / ' EH' / ' NP'
    if (suffix !== '' && !/^ (\([A-Za-z]+\)|[A-Z]{2})$/.test(suffix)) continue
    const toExe = `${ELECTRON_HELPER_PREFIX} Helper${suffix}`
    plan.push({ fromApp: name, toApp: `${toExe}.app`, fromExe: `${head}${suffix}`, toExe })
  }
  return plan
}

/**
 * Restores the Helpers in `<app>/Contents/Frameworks/` to their default names (TODO 499). Called from `afterPack` **before signing**.
 * The `CFBundleExecutable` in Info.plist (which electron-builder rewrote to `Temoto Helper…`) is brought into line too.
 * `CFBundleDisplayName` / `CFBundleIdentifier` (`<appId>.helper…`) are left as they are.
 * @param {string} app the path of the `.app`
 * @param {string} productFilename
 * @param {{ readdir?: (dir: string) => string[], rename?: (from: string, to: string) => void, setExecutable?: (plist: string, exe: string) => void }} [ops] for tests
 */
export function restoreElectronHelpers(app, productFilename, ops = {}) {
  const readdir = ops.readdir ?? ((dir) => readdirSync(dir))
  const rename = ops.rename ?? ((from, to) => renameSync(from, to))
  const setExecutable =
    ops.setExecutable ??
    ((plist, exe) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleExecutable ${exe}`, plist], { stdio: 'pipe' }))
  const frameworks = join(app, 'Contents', 'Frameworks')
  const plan = helperRestorePlan(readdir(frameworks), productFilename)
  for (const step of plan) {
    const macos = join(frameworks, step.fromApp, 'Contents', 'MacOS')
    rename(join(macos, step.fromExe), join(macos, step.toExe))
    setExecutable(join(frameworks, step.fromApp, 'Contents', 'Info.plist'), step.toExe)
    rename(join(frameworks, step.fromApp), join(frameworks, step.toApp))
  }
  return plan
}

// ---- TODO 951: Developer ID, Hardened Runtime, notarization (the pure parts; test/release-config.test.ts checks them) ----------------

/** The default name of the keychain profile made with `xcrun notarytool store-credentials <name>` (change it with `AIOS_NOTARY_PROFILE`). */
export const NOTARY_PROFILE_DEFAULT = 'aios'

/**
 * The stop message for when the signature is Developer ID but the Team ID (`(ABCDE12345)`) cannot be taken from the name. It is shown before signing (review 58-5).
 * If it cannot be taken, the check run after signing and notarization (matching the Team ID) fails with a message that makes no sense. Returns null if there is no problem.
 * @param {{ developerId: boolean, teamId: string | null, label: string }} sign
 */
export function teamIdProblem(sign) {
  if (!sign.developerId || sign.teamId !== null) return null
  return `Developer ID の名前から Team ID が取れない: ${sign.label}`
}

/**
 * How the signing stage of the distributed build is decided.
 * - **Hardened Runtime and the entitlements are added only for Developer ID** (the condition of notarization). A self-signed `aios dev` / ad-hoc build
 *   does not get them, as before (no regression). `AIOS_HARDENED_RUNTIME=1` adds them even to a self-signed one (for trying the entitlements locally).
 * - **Notarization happens only for Developer ID**. `AIOS_NOTARIZE=0` skips it even for Developer ID (to try only the signing).
 * A stage that is skipped gives its reason in `skipped` (release.mjs prints it).
 * @param {{ sign: { developerId: boolean, teamId: string | null, label: string }, env: Record<string, string | undefined> }} input
 */
export function releaseSigningMode({ sign, env }) {
  const profile = (env.AIOS_NOTARY_PROFILE ?? '').trim() || NOTARY_PROFILE_DEFAULT
  const forceRuntime = env.AIOS_HARDENED_RUNTIME === '1'
  const hardened = sign.developerId || forceRuntime
  /** @type {string[]} */
  const skipped = []
  let notarize = false
  if (!sign.developerId) {
    skipped.push(`公証: 飛ばす (署名が Developer ID でない: ${sign.label})`)
    if (!hardened) skipped.push('Hardened Runtime: 付けない (Developer ID でない。試すなら AIOS_HARDENED_RUNTIME=1)')
  } else if (env.AIOS_NOTARIZE === '0') {
    skipped.push('公証: 飛ばす (AIOS_NOTARIZE=0)')
  } else {
    notarize = true
  }
  return { hardened, timestamp: sign.developerId, notarize, profile, teamId: sign.teamId, skipped }
}

/**
 * The commands that make the zip to submit for notarization, submit it, staple it, and verify it (`xcrun` / `ditto`). A zip cannot be stapled, so
 * the .app is **stapled first**, and then electron-builder makes the zip (this runs right after signing, inside afterPack in release.mjs).
 * Authentication is only the name of the keychain profile (no token or App-specific password is passed or written).
 * @param {{ app: string, zip: string, profile: string }} input
 */
export function notarizeCommands({ app, zip, profile }) {
  return {
    zip: ['ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]],
    submit: ['xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait', '--output-format', 'json']],
    log: (/** @type {string} */ id) => ['xcrun', ['notarytool', 'log', id, '--keychain-profile', profile]],
    staple: ['xcrun', ['stapler', 'staple', app]],
    validate: ['xcrun', ['stapler', 'validate', app]],
    preflight: ['xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json']],
  }
}

/**
 * TODO 1243 stage 1: the commands that sign, notarize and staple the DMG. The .app is already notarized (and stapled) in afterPack, and the DMG itself
 * also gets Developer ID signing, notarization and stapling (a DMG can be stapled, so the Gatekeeper check passes offline right after download).
 * Authentication is only the name of the keychain profile. `sign` is used only for Developer ID (an ad-hoc DMG is not signed).
 * The commands for mounting and checking are split into `dmgInspectCommands`, which takes neither an identity nor a profile (so that a signing command
 * cannot be built with an empty identity).
 * @param {{ dmg: string, identity: string, profile: string }} input
 */
export function dmgCommands({ dmg, identity, profile }) {
  return {
    sign: ['codesign', ['--force', '--sign', identity, '--timestamp', dmg]],
    submit: ['xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait', '--output-format', 'json']],
    log: (/** @type {string} */ id) => ['xcrun', ['notarytool', 'log', id, '--keychain-profile', profile]],
    staple: ['xcrun', ['stapler', 'staple', dmg]],
  }
}

/**
 * TODO 1243 stage 1 (the wave 88 code review): the commands that mount the DMG and check it. They take neither the signing identity nor the notarization
 * profile (they only read and detach).
 * @param {{ dmg: string }} input
 */
export function dmgInspectCommands({ dmg }) {
  return {
    verifySign: ['codesign', ['--verify', '--strict', dmg]],
    validate: ['xcrun', ['stapler', 'validate', dmg]],
    // The Gatekeeper check of the DMG uses `-t open --context context:primary-signature` (`-t exec` is for the .app).
    assess: ['spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg]],
    attach: (/** @type {string} */ mountpoint) => ['hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountpoint, dmg]],
    detach: (/** @type {string} */ mountpoint) => ['hdiutil', ['detach', mountpoint]],
  }
}

/**
 * Reads the stdout of `notarytool submit --wait --output-format json`. Gives `{ id, status }` (status is `Accepted` / `Invalid` /
 * `Rejected` / …). If it cannot be read, status is null.
 * @param {string} stdout
 */
export function parseNotarySubmit(stdout) {
  const pick = (/** @type {any} */ value) => ({
    id: typeof value?.id === 'string' ? value.id : null,
    status: typeof value?.status === 'string' ? value.status : null,
  })
  // It can return JSON that is pretty-printed (over several lines), so the whole text is read first.
  try {
    return pick(JSON.parse(stdout.trim()))
  } catch {
    // For a form with a leading line, go to the line-by-line reading below.
  }
  try {
    return pick(JSON.parse(stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? ''))
  } catch {
    return { id: null, status: null }
  }
}

/**
 * Reads `codesign -dvv` (the result is on stderr). It reads in the same form as `signerOf` in src/main/update/stage.ts (a test passes the same output to both).
 * @param {string} text
 */
export function parseCodesignDetail(text) {
  const field = (/** @type {string} */ key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const team = field('TeamIdentifier')
  return {
    identifier: field('Identifier'),
    authorities: [...text.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim()),
    teamId: team === null || team === 'not set' ? null : team,
    adhoc: /^Signature=adhoc$/m.test(text),
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]*\([^)]*\bruntime\b[^)]*\)/m.test(text),
    stapled: /^Notarization Ticket=stapled$/m.test(text),
  }
}

/**
 * The requirement that only a signature by a Developer ID Application certificate whose Team ID is `team` satisfies (`codesign --verify -R`).
 * It is checked against Apple's CA chain, not against the name string (a self-signed certificate given the same name does not pass).
 * The same sentence as `developerIdRequirement` in src/main/update/stage.ts (a test checks that they match).
 * @param {string} team
 */
export function developerIdRequirement(team) {
  return (
    '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
    ` and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`
  )
}

/**
 * Reads `spctl -a -vv -t exec <app>` (the result is on stderr). A notarized build gives `accepted` + `source=Notarized Developer ID`.
 * @param {string} text
 */
export function parseSpctl(text) {
  return {
    accepted: /: accepted$/m.test(text),
    source: /^source=(.*)$/m.exec(text)?.[1]?.trim() ?? null,
  }
}

/** The repo that holds the Release (the public repo; the same as the default in install-temoto.sh). TODO 1254: `temoto-app/temoto` (`src/shared/product.json`). */
export const RELEASE_REPO = product.releaseRepo

/**
 * TODO 1144 stage 1: the name of the asset of the extension version table (the same as `PLUGIN_VERSIONS_ASSET` in src/shared/plugin-update.ts; a test checks that they match).
 * The app's auto-update (src/main/update/plugin-versions.ts) takes this from the latest Release, and shows "latest / update available" for each extension.
 */
export const PLUGIN_VERSIONS_ASSET = 'plugins.json'

/** The format number of the version table (the same as `PLUGIN_VERSIONS_FORMAT` in src/shared/plugin-update.ts). */
export const PLUGIN_VERSIONS_FORMAT = 1

/**
 * The names of the assets to attach to the Release (inside dist/). The order is the order passed to gh (zip → DMG → install scripts → …).
 * `SHA256SUMS` is last (it holds the values of everything else).
 * TODO 1144 stage 2: `pluginAssets` (a zip per extension, `pluginAssetName`) come before the version table.
 * TODO 1144 stage 4: if `signed`, `SHA256SUMS.sig` comes last (the detached signature of SHA256SUMS; it is not on SHA256SUMS' own line).
 * @param {string} version
 * @param {string[]} [pluginAssets]
 * @param {boolean} [signed]
 */
export function releaseAssets(version, pluginAssets = [], signed = false) {
  // TODO 1243 stage 1: the DMG (which a person downloads) comes right after the zip (which auto-update and install-temoto.sh read).
  return [zipName(version), dmgName(version), INSTALL_SCRIPT, 'install-backend.sh', ...pluginAssets, PLUGIN_VERSIONS_ASSET, 'SHA256SUMS', ...(signed ? [SUMS_SIGNATURE_ASSET] : [])]
}

/** TODO 1144 stage 4: the name of the detached signature asset of SHA256SUMS (the same as `SUMS_SIGNATURE_ASSET` in src/main/update/sums-signature.ts; a test checks that they match). */
export const SUMS_SIGNATURE_ASSET = 'SHA256SUMS.sig'

/**
 * TODO 1144 stage 2: the name of the zip of one extension's bundle (the same as `pluginAssetName` in src/shared/plugin-update.ts; a test checks that they match).
 * @param {string} id
 * @param {string} version
 */
export function pluginAssetName(id, version) {
  return `plugin-${id}-${version}.zip`
}

/**
 * TODO 1144 stage 2: reads the contents of an extension's directory (`out/plugins/<id>/`) in the order of their relative paths (`/`-separated).
 * It throws if there is anything other than symlinks, plain files and directories (aios's extraction refuses symlinks, so it stops before distribution).
 * @param {string} dir
 * @returns {Array<{ path: string, data: Buffer }>}
 */
export function collectPluginFiles(dir) {
  const out = []
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(join(dir, path))
      if (stat.isSymbolicLink()) throw new Error(`${path}: 拡張機能の中に symlink がある`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) out.push({ path, data: readFileSync(join(dir, path)) })
      else throw new Error(`${path}: 普通のファイルでない`)
    }
  }
  walk('')
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!out.some((file) => file.path === 'manifest.json')) throw new Error(`${dir}: manifest.json が無い`)
  return out
}

/**
 * TODO 1144 stage 2: puts the contents of `collectPluginFiles` into one zip (manifest.json directly at the top; deflate; the time is fixed).
 * The form that aios's extraction (src/main/update/plugin-zip.ts) reads: no zip64, no encryption, no symlinks.
 * @param {Array<{ path: string, data: Uint8Array }>} files
 * @returns {Uint8Array}
 */
export function pluginBundleZip(files) {
  const entries = {}
  for (const file of files) entries[file.path] = [new Uint8Array(file.data), { level: 9 }]
  return zipSync(entries, { mtime: new Date(2000, 0, 1) })
}

/**
 * TODO 1144 stage 1: the contents of the extension version table (`plugins.json`). `manifests` is what was read from `out/plugins/<id>/manifest.json` of the .app being distributed.
 * The form is `{ format, aios, plugins: { <id>: { version } } }` (ARCHITECTURE 8.5.1). Sorted by id; a duplicate id or a missing version throws.
 * Stage 2: if `assets` (id → `{ asset, sha256 }`) is passed, it is added to each line (the format number stays at 1; an old aios drops keys it does not know).
 * If it is passed, every id must be present, the name must be `pluginAssetName(id, version)`, and the SHA-256 must be 64 lowercase hex digits.
 * @param {{ version: string, manifests: Array<{ id?: unknown, version?: unknown }>, assets?: Record<string, { asset: string, sha256: string }> }} options
 */
export function pluginVersionTable({ version, manifests, assets }) {
  const entries = []
  for (const manifest of manifests) {
    const { id, version: pluginVersion } = manifest
    if (typeof id !== 'string' || id === '') throw new Error('manifest.id が無い')
    if (typeof pluginVersion !== 'string' || pluginVersion === '') throw new Error(`${id}: manifest.version が無い`)
    if (entries.some(([seen]) => seen === id)) throw new Error(`${id}: 同じ id の拡張機能が 2 つある`)
    if (assets === undefined) {
      entries.push([id, { version: pluginVersion }])
      continue
    }
    const asset = assets[id]
    if (asset === undefined) throw new Error(`${id}: 資産が無い`)
    if (asset.asset !== pluginAssetName(id, pluginVersion)) throw new Error(`${id}: 資産の名前が ${pluginAssetName(id, pluginVersion)} でない`)
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`${id}: SHA-256 の形が違う`)
    entries.push([id, { version: pluginVersion, asset: asset.asset, sha256: asset.sha256 }])
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return { format: PLUGIN_VERSIONS_FORMAT, aios: version, plugins: Object.fromEntries(entries) }
}

/**
 * Turns `pluginVersionTable` into the text of the asset (JSON indented by 2 spaces, ending in a newline).
 * @param {ReturnType<typeof pluginVersionTable>} table
 */
export function pluginVersionTableText(table) {
  return `${JSON.stringify(table, null, 2)}\n`
}

/**
 * The contents of `SHA256SUMS` (in a form that `shasum -a 256 -c` reads: `<hex>  <name>`, one file per line, ending in a newline).
 * @param {Array<{ name: string, sha256: string }>} entries
 */
export function sha256SumsText(entries) {
  return entries.map((e) => `${e.sha256}  ${e.name}\n`).join('')
}

/**
 * TODO 1185 X-4: cuts out of `CHANGELOG.md` the section for the version `version` (from its `## [version]` heading up to just before the heading of the next version). Returns null if there is none.
 * It returns the same result as `extractVersionSection` in `src/shared/release-notes.ts` (scripts/ cannot read .ts, so it keeps a copy, which
 * test/release-config.test.ts checks against it).
 * @param {string} markdown @param {string} version
 */
export function changelogSection(markdown, version) {
  const headings = [...markdown.matchAll(/^## \[([^\]\n]+)\][^\n]*$/gm)]
  const index = headings.findIndex((m) => m[1] === version)
  if (index < 0) return null
  const start = headings[index]?.index ?? 0
  const end = headings[index + 1]?.index ?? markdown.length
  return markdown.slice(start, end).trimEnd() + '\n'
}

/** The place where the Release notes are written (from the repo root; dist/ is ignored by git). */
export function releaseNotesPath(version) {
  return `dist/release-notes-${version}.md`
}

/** The download button of the Release notes (an image in the public repo; `build/` is on the publish allowlist). */
export const DOWNLOAD_BUTTON = 'build/download-macos.svg'

/**
 * The text of the Release notes: a download button and a direct link to the DMG, then the version's section of `CHANGELOG.md`.
 * The Release page lists assets by name and folds everything after the tenth, so the DMG (the one a person downloads) is hidden
 * behind "Show all assets"; the button puts it at the top. Both links are to the asset of the Release in `repo`.
 * The image is read from the tag of the same version (it exists whenever the Release does, and an old Release keeps its own button).
 * GitHub drops inline `<svg>` from notes, so the button is an `<img>`; the line of text under it stays readable if the image does not load.
 * @param {{ section: string, version: string, repo?: string }} o
 */
export function releaseNotesText({ section, version, repo = RELEASE_REPO }) {
  const dmg = dmgName(version)
  const url = `https://github.com/${repo}/releases/download/v${version}/${dmg}`
  const image = `https://raw.githubusercontent.com/${repo}/v${version}/${DOWNLOAD_BUTTON}`
  const button = `<a href="${url}"><img src="${image}" alt="Download for macOS (Apple silicon)" width="320"></a>`
  return `${button}\n\n[${dmg}](${url})\n\n${section}`
}

/**
 * Writes the Release notes (`gh release create --notes-file`): the download link and that version's section of `CHANGELOG.md`.
 * If there is no section, it writes nothing and returns null (the command then falls back to the fixed guidance text).
 * @param {string} repoRoot @param {string} version @returns {string | null} the path relative to the repo root
 */
export function writeReleaseNotes(repoRoot, version) {
  let text
  try {
    text = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')
  } catch {
    return null
  }
  const section = changelogSection(text, version)
  if (section === null) return null
  const path = releaseNotesPath(version)
  mkdirSync(join(repoRoot, 'dist'), { recursive: true })
  writeFileSync(join(repoRoot, path), releaseNotesText({ section, version }))
  return path
}

/**
 * The public command that the owner types by hand (owner decision 2 of TODO 492: the release script is not published).
 * It passes the commit to `--target`, so the tag is put on that commit (gh creates the tag if it does not exist; the commit must already be pushed).
 * TODO 1144 stage 2: it also attaches `pluginAssets` (the name of each extension's zip).
 * TODO 1185: if `commit` is null, `--verify-tag` is used instead of `--target` (the tag was put on the public commit beforehand and pushed; if not, gh stops).
 * If `assets` is passed, those names are attached (if null, only a mark of where the assets are). `notesFile` is the notes file (`writeReleaseNotes`).
 * @param {{ version: string, commit: string | null, repo?: string, pluginAssets?: string[], assets?: string[] | null, notesFile?: string | null, signed?: boolean }} options
 */
export function ghReleaseCommand({ version, commit, repo = RELEASE_REPO, pluginAssets = [], assets, notesFile = null, signed = false }) {
  const names = assets === undefined ? releaseAssets(version, pluginAssets, signed) : assets
  return [
    'gh release create',
    `v${version}`,
    `-R ${repo}`,
    commit === null ? '--verify-tag' : `--target ${commit}`,
    `--title "${PRODUCT_NAME} ${version}"`,
    // TODO 1185 X-4: the notes are the section for that version in CHANGELOG (the install guidance is used only when there is none).
    notesFile !== null
      ? `--notes-file ${notesFile}`
      : `--notes "Install and update: see the README (curl -fsSLO https://github.com/${repo}/releases/latest/download/${INSTALL_SCRIPT} && bash ${INSTALL_SCRIPT})"`,
    ...(names === null ? ['dist/<npm run release の資産>'] : names.map((name) => `dist/${name}`)),
  ].join(' \\\n  ')
}
