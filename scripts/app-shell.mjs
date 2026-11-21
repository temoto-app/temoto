/**
 * Assembles and signs the `aios.app` shell (scripts/make-app.mjs) (TODO 375, wave 20 bundle J).
 *
 * The shell has the shape of an ordinary Electron app: the Electron binary sits at `Contents/MacOS/aios`,
 * and `CFBundleExecutable` points at it directly (no launcher shell script in between). Signing works as in
 * `@electron/osx-sign`: one piece at a time, from the inside out, and last the whole bundle, without `--deep`.
 *
 * The first three functions (`infoPlistOps` / `planSigning` / `resolveSignIdentity`) are pure, and
 * test/app-shell.test.ts checks them directly (they call neither codesign nor PlistBuddy). The second half is
 * the part that actually reads files and calls PlistBuddy / codesign.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Buffer } from 'node:buffer'
import product from '../src/shared/product.json' with { type: 'json' }

/**
 * TODO 1254: the name shown in the Dock, the menu bar and confirmation dialogs (`Temoto`; `src/shared/product.json` is the source of truth).
 * The shell's .app file name (`~/Applications/aios.app`), its executable (`EXECUTABLE`) and the identifier keep their internal names.
 */
export const DISPLAY_NAME = product.name

/**
 * The CFBundleIdentifier of the development shell (`~/Applications/aios.app`). The signing identifier matches it too (so notifications link to aios.app).
 * TODO 1263: the shell keeps `local.aios` (changing it would bring the keychain and TCC confirmations back on the development machine);
 * only the distributed build takes `RELEASE_BUNDLE_ID`.
 */
export const SHELL_BUNDLE_ID = 'local.aios'
/** TODO 1263: the CFBundleIdentifier and signing identifier of the distributed build (`src/shared/product.json`). */
export const RELEASE_BUNDLE_ID = product.bundleId
/** The CFBundleExecutable of the shell. The Electron binary is placed under this name. */
export const EXECUTABLE = 'aios'
/** The default signing name. If it is in the keychain, signing uses it (the cert made by scripts/verify-selfsign.sh). */
export const DEFAULT_SIGN_NAME = 'aios dev'
/**
 * The URL schemes (TODO 976 stage 3; TODO 1263 added `temoto` as an alias of `aios`). The same values as `APP_URL_SCHEMES_ACCEPTED` in main
 * (src/common/app-url.ts; test/app-shell.test.ts checks that they match). `CFBundleURLName` follows the reverse-domain convention and matches the identifier.
 */
export const URL_SCHEMES = product.urlSchemes
/** @param {string} bundleId */
export const urlSchemeName = (bundleId) => `${bundleId}.url`
/**
 * The start of the Developer ID signing name (TODO 951). Only the release build (`npm run release`) looks for it first. The shell
 * (`npm run app`) does not: a dev shell stays with the self-signed `aios dev` and is not notarized (todo/951.md). `Apple Development: …`
 * cannot be used for notarization, so it is not picked up.
 */
export const DEVELOPER_ID_PREFIX = 'Developer ID Application:'

/**
 * The Hardened Runtime entitlements (TODO 951, relative to the repo root). For the contents and for why they are needed, see the comments
 * in each plist and the section "Developer ID, Hardened Runtime and notarization" in docs/notes/app-shell.md.
 * - `app`: the shell's binary (`Contents/MacOS/aios`). The gateway runs the same binary with `ELECTRON_RUN_AS_NODE=1`, so it gets the same entitlements.
 * - `helper`: the four `Electron Helper*.app` (renderer, GPU, plugin, and the utility processes = the index process and plugin-host).
 * - Not applied to native `.node` files, framework dylibs, the two Swift helpers, `chrome_crashpad_handler`, or `ShipIt`.
 *   (`.node` files and dylibs are libraries, to which entitlements do not apply. The Swift helpers do not touch the microphone: recording
 *   goes through the renderer's `getUserMedia`, and speech-helper only reads an audio file that was already recorded.)
 *   `--options runtime` alone is applied to everything (a condition of notarization).
 */
export const ENTITLEMENTS = {
  app: 'build/entitlements.mac.plist',
  helper: 'build/entitlements.helper.plist',
}

/**
 * The operations on Info.plist. `set` means "Set if present, Add if not"; `delete` means "do nothing if absent";
 * `add` always Adds (the contents of an array, for which the parent is deleted and recreated just before).
 * `bundleId` is the shell's by default; the release build passes `RELEASE_BUNDLE_ID` (it decides `CFBundleURLName`; electron-builder writes the identifier from `appId`).
 * @param {{ version: string, bundleId?: string }} options
 * @returns {Array<{ op: 'set' | 'add', key: string, type: string, value: string } | { op: 'delete', key: string }>}
 */
export function infoPlistOps({ version, bundleId = SHELL_BUNDLE_ID }) {
  return [
    { op: 'set', key: 'CFBundleExecutable', type: 'string', value: EXECUTABLE },
    { op: 'set', key: 'CFBundleName', type: 'string', value: DISPLAY_NAME },
    { op: 'set', key: 'CFBundleDisplayName', type: 'string', value: DISPLAY_NAME },
    { op: 'set', key: 'CFBundleIdentifier', type: 'string', value: bundleId },
    { op: 'set', key: 'CFBundleIconFile', type: 'string', value: 'aios' },
    { op: 'set', key: 'CFBundleShortVersionString', type: 'string', value: version },
    { op: 'set', key: 'CFBundleVersion', type: 'string', value: version },
    { op: 'delete', key: 'NSHumanReadableCopyright' },
    // Since default_app.asar is deleted, its integrity record is deleted too (it has no effect because the fuse is off, but
    // a record that points at a file that does not exist should not be left behind).
    { op: 'delete', key: 'ElectronAsarIntegrity' },
    // Voice input (item 226, wave 14 bundle M). The microphone prompt is shown with the app's name, so the purpose sentence is replaced
    // with this app's own text (Electron's default is "This app needs access to the microphone"). The speech-recognition key is needed when
    // the helper falls back to SFSpeechRecognizer (before macOS 26): TCC checks the "responsible process", which is this .app's Info.plist,
    // and without the key it denies the request without showing a prompt, so the helper aborts (spike 28).
    {
      op: 'set',
      key: 'NSMicrophoneUsageDescription',
      type: 'string',
      value: `"${DISPLAY_NAME} uses the microphone for voice input in the prompt. The audio is transcribed on this Mac and is not saved."`,
    },
    {
      op: 'set',
      key: 'NSSpeechRecognitionUsageDescription',
      type: 'string',
      value: `"${DISPLAY_NAME} transcribes your voice input on this Mac. The audio is not saved or sent anywhere."`,
    },
    // Declarations to receive a drop onto the Dock icon and `open -a aios.app <folder>` (item 98 (c)).
    // The role is Viewer (it only opens files, it does not edit them). It also accepts files, so public.item is listed too.
    { op: 'delete', key: 'CFBundleDocumentTypes' },
    { op: 'add', key: 'CFBundleDocumentTypes', type: 'array', value: '' },
    { op: 'add', key: 'CFBundleDocumentTypes:0', type: 'dict', value: '' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:CFBundleTypeName', type: 'string', value: 'Folder' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:CFBundleTypeRole', type: 'string', value: 'Viewer' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:LSHandlerRank', type: 'string', value: 'Alternate' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:LSItemContentTypes', type: 'array', value: '' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:LSItemContentTypes:0', type: 'string', value: 'public.folder' },
    { op: 'add', key: 'CFBundleDocumentTypes:0:LSItemContentTypes:1', type: 'string', value: 'public.item' },
    // The `aios://` URL scheme (TODO 976 stage 3, ARCHITECTURE 3.3). On macOS, `app.setAsDefaultProtocolClient` does not work unless
    // this declaration is in Info.plist. Both the shell (make-app.mjs) and the release build (`extendInfo` in release-config.mjs) use this list.
    { op: 'delete', key: 'CFBundleURLTypes' },
    { op: 'add', key: 'CFBundleURLTypes', type: 'array', value: '' },
    { op: 'add', key: 'CFBundleURLTypes:0', type: 'dict', value: '' },
    { op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLName', type: 'string', value: urlSchemeName(bundleId) },
    { op: 'add', key: 'CFBundleURLTypes:0:CFBundleTypeRole', type: 'string', value: 'Viewer' },
    { op: 'add', key: 'CFBundleURLTypes:0:CFBundleURLSchemes', type: 'array', value: '' },
    ...URL_SCHEMES.map((scheme, index) => ({
      op: /** @type {const} */ ('add'),
      key: `CFBundleURLTypes:0:CFBundleURLSchemes:${index}`,
      type: 'string',
      value: scheme,
    })),
  ]
}

/**
 * Decides the signing order. The input is a path relative to the bundle root (separator `/`).
 *
 * - `machos`: the real Mach-O files inside the bundle (symlinks are not included).
 * - `bundles`: the `.app` / `.framework` inside, and that bundle's own executable (`executable`).
 *   The executable is signed together with its bundle, so it is not signed on its own.
 * - `mainExecutable`: the path of the outermost (shell) binary (`Contents/MacOS/aios`). It is signed with the shell.
 *
 * The order is from deep to shallow (inside out). At the same depth, files come before bundles, and within a group, by name.
 * Last, the shell itself (`path: ''`) is signed with `--identifier local.aios`. If the shell's `Contents/MacOS` has a Mach-O
 * other than the binary (the old form `aios-bin`), it gets the same identifier too, because notifications find aios.app by that
 * signature (the form that worked when applied by hand on 2026-10-03).
 *
 * If `hardened` (TODO 951) is passed, every item gets `--options runtime` (and `--timestamp` if `timestamp` is set). The shell binary
 * (and the old form `aios-bin`) gets the `hardened.app` entitlements, and the `.app` bundles (Helpers) get `hardened.helper`.
 * If it is not passed, nothing changes: no Hardened Runtime and no entitlements (self-signed `aios dev`, ad-hoc shells, and the
 * distributed build).
 *
 * @param {{ machos: string[], bundles: Array<{ path: string, executable: string | null }>, mainExecutable: string }} layout
 * @param {{ identity: string, bundleId?: string, hardened?: { app: string, helper: string, timestamp: boolean } | null }} options
 * @returns {Array<{ path: string, kind: 'file' | 'bundle' | 'app', args: string[], entitlements: string | null }>}
 */
export function planSigning(layout, { identity, bundleId = SHELL_BUNDLE_ID, hardened = null }) {
  const bundleMains = new Set(layout.bundles.map((b) => b.executable).filter((e) => e !== null))
  bundleMains.add(layout.mainExecutable)
  const depth = (/** @type {string} */ p) => p.split('/').length
  /** @type {Array<{ path: string, kind: 'file' | 'bundle' }>} */
  const items = [
    ...layout.machos.filter((m) => !bundleMains.has(m)).map((path) => ({ path, kind: /** @type {const} */ ('file') })),
    ...layout.bundles.map((b) => ({ path: b.path, kind: /** @type {const} */ ('bundle') })),
  ]
  items.sort((a, b) => {
    const d = depth(b.path) - depth(a.path)
    if (d !== 0) return d
    if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  const inShellMacOS = (/** @type {string} */ p) => p.startsWith('Contents/MacOS/') && depth(p) === 3
  /** @param {string | null} entitlements */
  const base = (entitlements) => {
    const args = ['--force', '--sign', identity]
    if (hardened === null) return args
    args.push('--options', 'runtime')
    if (hardened.timestamp) args.push('--timestamp')
    if (entitlements !== null) args.push('--entitlements', entitlements)
    return args
  }
  /** @param {{ path: string, kind: 'file' | 'bundle' }} item */
  const entitlementsOf = (item) => {
    if (hardened === null) return null
    if (item.kind === 'file' && inShellMacOS(item.path)) return hardened.app
    if (item.kind === 'bundle' && item.path.endsWith('.app')) return hardened.helper
    return null
  }
  return [
    ...items.map((item) => {
      const entitlements = entitlementsOf(item)
      return {
        ...item,
        args:
          item.kind === 'file' && inShellMacOS(item.path)
            ? [...base(entitlements), '--identifier', bundleId, item.path]
            : [...base(entitlements), item.path],
        entitlements,
      }
    }),
    {
      path: '',
      kind: /** @type {const} */ ('app'),
      args: [...base(hardened?.app ?? null), '--identifier', bundleId, ''],
      entitlements: hardened?.app ?? null,
    },
  ]
}

/**
 * Decides the identity used for signing (TODO 375, item 2).
 *
 * - If `AIOS_SIGN_IDENTITY` is not empty, use it (`-` means ad-hoc, explicitly).
 * - If not, look for `aios dev` in the output of `security find-identity -v -p codesigning`, and if it is there, sign with its SHA-1
 *   (two entries with the same name make codesign stop with "ambiguous", so the name is not used).
 * - If neither, fall back to ad-hoc (`-`) with a warning. Even ad-hoc, the identifier is set to local.aios (planSigning).
 *
 * TODO 951: with `preferDeveloperId` (the release build only), look for `Developer ID Application: … (<Team ID>)` before `aios dev`.
 * The returned `developerId` / `teamId` are also decided by matching the value given in `AIOS_SIGN_IDENTITY` (name or SHA-1) against the
 * keychain list (a name that is not in the list is not treated as a Developer ID: Hardened Runtime and notarization apply only to a Developer ID).
 *
 * @param {{ env: string | undefined, findIdentityOutput: string | null, preferDeveloperId?: boolean }} input
 * @returns {{ identity: string, label: string, adhoc: boolean, warning: string | null, developerId: boolean, teamId: string | null }}
 */
export function resolveSignIdentity({ env, findIdentityOutput, preferDeveloperId = false }) {
  /** @type {Array<{ hash: string, name: string }>} */
  const identities = []
  for (const line of (findIdentityOutput ?? '').split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"\s*$/.exec(line)
    if (m) identities.push({ hash: m[1], name: m[2] })
  }
  /** @param {string | null} name */
  const developerIdOf = (name) => {
    if (name === null || !name.startsWith(DEVELOPER_ID_PREFIX)) return { developerId: false, teamId: null }
    return { developerId: true, teamId: /\(([0-9A-Z]{10})\)\s*$/.exec(name)?.[1] ?? null }
  }
  if (env !== undefined && env.trim() !== '') {
    const identity = env.trim()
    const known = identities.find((i) => i.hash === identity || i.name === identity)?.name ?? null
    return {
      identity,
      label: identity === '-' ? 'ad-hoc (AIOS_SIGN_IDENTITY=-)' : identity,
      adhoc: identity === '-',
      warning: null,
      ...developerIdOf(identity === '-' ? null : known),
    }
  }
  /** @param {string} name @param {(n: string) => boolean} test */
  const pick = (name, test) => {
    const matches = identities.filter((i) => test(i.name))
    if (matches.length === 0) return null
    const first = matches[0]
    return {
      identity: first.hash,
      label: `${first.name} (${first.hash})`,
      adhoc: false,
      warning:
        matches.length > 1 ? `キーチェーンに "${name}" が ${matches.length} 個ある。最初の 1 つ (${first.hash}) で署名する。` : null,
      ...developerIdOf(first.name),
    }
  }
  const chosen =
    (preferDeveloperId ? pick(DEVELOPER_ID_PREFIX, (n) => n.startsWith(DEVELOPER_ID_PREFIX)) : null) ??
    pick(DEFAULT_SIGN_NAME, (n) => n === DEFAULT_SIGN_NAME)
  if (chosen !== null) return chosen
  return {
    identity: '-',
    label: 'ad-hoc',
    adhoc: true,
    warning:
      `キーチェーンに署名用の "${DEFAULT_SIGN_NAME}" が無いので ad-hoc で署名する。` +
      '作り直すたびに「aios Safe Storage」の確認が出る。証明書は bash scripts/verify-selfsign.sh cert で作れる。',
    developerId: false,
    teamId: null,
  }
}

// ---- From here down, the code touches files and external commands ------------------------------------------

const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca])

/** Checks whether the first 4 bytes are a Mach-O header (fat included). @param {string} file */
function isMachO(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(4)
    if (readSync(fd, buf, 0, 4, 0) !== 4) return false
    return MACHO_MAGICS.has(buf.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Walks the inside of the shell and builds the input for `planSigning`. Symlinks are not followed (`Resources/app` is a symlink to the repo,
 * and framework items such as `Versions/Current` are symlinks too).
 * @param {string} app
 * @param {string} mainExecutable the relative path of the shell's binary
 */
export function scanAppLayout(app, mainExecutable) {
  /** @type {string[]} */
  const machos = []
  /** @type {Array<{ path: string, executable: string | null }>} */
  const bundles = []
  const rel = (/** @type {string} */ p) => relative(app, p).split(sep).join('/')
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (name.endsWith('.app')) {
          bundles.push({ path: rel(full), executable: bundleExecutable(full, 'app') })
        } else if (name.endsWith('.framework')) {
          bundles.push({ path: rel(full), executable: bundleExecutable(full, 'framework') })
        }
        walk(full)
      } else if (st.isFile() && isMachO(full)) {
        machos.push(rel(full))
      }
    }
  }
  walk(join(app, 'Contents'))
  return { machos, bundles, mainExecutable }

  /** @param {string} bundle @param {'app' | 'framework'} kind */
  function bundleExecutable(bundle, kind) {
    if (kind === 'app') {
      // An Electron Helper's Info.plist has no CFBundleExecutable. If it has none, the bundle name (without .app) is the binary.
      let exe = bundle.slice(bundle.lastIndexOf('/') + 1, -'.app'.length)
      try {
        exe = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(bundle, 'Contents', 'Info.plist')], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch { /* No key */ }
      return rel(join(bundle, 'Contents', 'MacOS', exe))
    }
    // The framework's binary is at Versions/<version>/<name>. For the version, look for the real directory (Current is a symlink).
    const name = bundle.slice(bundle.lastIndexOf('/') + 1, -'.framework'.length)
    try {
      for (const version of readdirSync(join(bundle, 'Versions'))) {
        const candidate = join(bundle, 'Versions', version, name)
        if (!lstatSync(join(bundle, 'Versions', version)).isSymbolicLink() && isMachO(candidate)) return rel(candidate)
      }
    } catch { /* A framework without Versions (the iOS form) has its binary directly under it */ }
    return rel(join(bundle, name))
  }
}

/** Reads `security find-identity` (it does not write). Returns null on failure. */
export function readCodesigningIdentities() {
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * Signs the shell from the inside out. Throws on failure (the caller turns it into a warning).
 * @param {string} app the shell's path
 * @param {string} identity the value passed to codesign's --sign
 * `hardened` (TODO 951) is the same as in `planSigning` (the entitlements are passed as absolute paths). Only when signing the distributed build with a Developer ID.
 * `bundleId` (TODO 1263) is the shell's by default; the release build passes `RELEASE_BUNDLE_ID`.
 * @param {{ mainExecutable?: string, bundleId?: string, log?: (line: string) => void, hardened?: { app: string, helper: string, timestamp: boolean } | null }} [options]
 */
export function signApp(app, identity, options = {}) {
  const mainExecutable = options.mainExecutable ?? `Contents/MacOS/${EXECUTABLE}`
  const plan = planSigning(scanAppLayout(app, mainExecutable), {
    identity,
    bundleId: options.bundleId ?? SHELL_BUNDLE_ID,
    hardened: options.hardened ?? null,
  })
  for (const step of plan) {
    const args = step.args.slice(0, -1).concat(join(app, step.path))
    options.log?.(`codesign ${step.kind === 'app' ? '(殻)' : step.path}`)
    execFileSync('codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  }
  return plan
}
