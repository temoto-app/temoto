#!/usr/bin/env node
// Makes an aios.app that points at the repo. Not for distribution: a thin shell to start from Finder / Spotlight /
// BetterTouchTool and check that it works.
//
//   node scripts/make-app.mjs [output directory]   the default is ~/Applications
//
// The contents are the node_modules Electron.app, duplicated with clonefile, with only the binary's name, Info.plist and the icon
// replaced, and then signed again (the shape and the signing order are in scripts/app-shell.mjs).
// Contents/Resources/app is a symlink to the repo, so after a code change, npm run build is all that is needed; the .app does not have to be remade.
//
// Environment variable AIOS_SIGN_IDENTITY: the signing name (by default the "aios dev" in the keychain, or ad-hoc if there is none).
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, mkdirSync, symlinkSync, copyFileSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXECUTABLE, infoPlistOps, readCodesigningIdentities, resolveSignIdentity, signApp } from './app-shell.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (process.platform !== 'darwin') {
  console.error('このスクリプトは macOS 専用。')
  process.exit(1)
}

const electronApp = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
// The npm package of Electron 44 has no postinstall, and the binary is downloaded the first time it is launched.
// In a fresh clone (scripts/install.sh), dist/ does not exist even after npm ci, so it is downloaded here.
const electronInstall = join(root, 'node_modules', 'electron', 'install.js')
if (!existsSync(electronApp) && existsSync(electronInstall)) {
  console.log('Electron の本体が無いので落とす (node_modules/electron/install.js)')
  execFileSync(process.execPath, [electronInstall], { cwd: root, stdio: 'inherit' })
}
if (!existsSync(electronApp)) {
  console.error(`Electron が見つからない: ${electronApp}\nnpm install を先に実行する。`)
  process.exit(1)
}

const entry = join(root, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error(`ビルド成果物が無い: ${entry}\nnpm run build を先に実行する。`)
  process.exit(1)
}

const icns = join(root, 'build', 'icon.icns')
if (!existsSync(icns)) {
  console.error(`アイコンが無い: ${icns}\nnpm run icon を先に実行する。`)
  process.exit(1)
}

const defaultOutDir = join(homedir(), 'Applications')
const outDir = resolve(process.argv[2] ?? defaultOutDir)
const app = join(outDir, 'aios.app')

mkdirSync(outDir, { recursive: true })
if (existsSync(app)) {
  // Deleting and remaking a running shell pulls the ground out from under the running binary, Helper and gateway (TODO 375).
  let running = false
  try {
    execFileSync('pgrep', ['-f', `${join(app, 'Contents', 'MacOS')}/`], { stdio: 'ignore' })
    running = true
  } catch { /* pgrep returned 1: not running */ }
  if (running) {
    console.error(`${app} が動いている。終了してからもう一度走らせる。`)
    process.exit(1)
  }
  rmSync(app, { recursive: true, force: true })
}

// With APFS clonefile, nothing is copied, so it finishes instantly and takes almost no disk space.
try {
  execFileSync('cp', ['-Rc', electronApp, app])
} catch {
  execFileSync('cp', ['-R', electronApp, app])
}

const contents = join(app, 'Contents')
const macos = join(contents, 'MacOS')
// TODO 375 (wave 20 bundle J): the shape of an ordinary Electron app. The binary itself is the CFBundleExecutable.
// Before, CFBundleExecutable was a shell script (which ran `env -u ELECTRON_RUN_AS_NODE` and then `exec`ed `aios-bin`), but the signature of the
// binary that posts notifications was not tied to the shell, so macOS refused the notifications (docs/notes/app-shell.md).
// The handling of ELECTRON_RUN_AS_NODE is in the same note.
renameSync(join(macos, 'Electron'), join(macos, EXECUTABLE))

const resources = join(contents, 'Resources')
rmSync(join(resources, 'electron.icns'), { force: true })
rmSync(join(resources, 'default_app.asar'), { force: true })
copyFileSync(icns, join(resources, 'aios.icns'))
// Since app is a symlink, rebuilding the repo makes the .app read the new code as it is.
symlinkSync(root, join(resources, 'app'))

const plist = join(contents, 'Info.plist')
const plistBuddy = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'ignore' })
for (const op of infoPlistOps({ version: pkg.version })) {
  if (op.op === 'delete') {
    try {
      plistBuddy(`Delete :${op.key}`)
    } catch { /* If it was not there in the first place, that is fine */ }
  } else if (op.op === 'add') {
    plistBuddy(`Add :${op.key} ${op.type}${op.value === '' ? '' : ` ${op.value}`}`)
  } else {
    // A key that already exists is Set; if not, it is Added. This is so as not to depend on the contents of Electron's Info.plist.
    try {
      plistBuddy(`Set :${op.key} ${op.value}`)
    } catch {
      plistBuddy(`Add :${op.key} ${op.type} ${op.value}`)
    }
  }
}

// Rewriting Info.plist breaks Electron's signature so that it cannot launch, so it is signed again.
// TODO 375: the default is `aios dev` in the keychain if it is there, otherwise ad-hoc + a warning.
// It can be changed with `AIOS_SIGN_IDENTITY` (`-` means ad-hoc explicitly). Either way, the binary's identifier is local.aios.
// With a self-signed build, the "aios Safe Storage" confirmation is not expected to appear even when the shell is remade (stage 1 of TODO 103).
const sign = resolveSignIdentity({
  env: process.env.AIOS_SIGN_IDENTITY,
  findIdentityOutput: process.env.AIOS_SIGN_IDENTITY ? null : readCodesigningIdentities(),
})
if (sign.warning) console.warn(`警告: ${sign.warning}`)
console.log(`署名: ${sign.label}`)
try {
  signApp(app, sign.identity)
} catch (error) {
  const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error)
  console.warn(`codesign に失敗した。起動できないか、通知が出ないかもしれない。\n${detail}`)
}

// Have LaunchServices learn it again (so that the icon does not stay stale). Only for the default location.
// If a shell made for checking, in /tmp or the like, is registered, there are two entries with the same CFBundleIdentifier (local.aios), and
// the target of `tell application id "local.aios"` and of notifications could be garbled to point at that one (TODO 375).
if (outDir === defaultOutDir) {
  try {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app],
      { stdio: 'ignore' },
    )
  } catch { /* It is not fatal if it is missing */ }
} else {
  console.log(`LaunchServices には登録しない (出力先が既定の ${defaultOutDir} でない)`)
}

console.log(`できた: ${app}`)
// When launching from a terminal (a terminal made with VS Code / Electron), drop ELECTRON_RUN_AS_NODE.
// `open` passes the caller's environment variables to the app (docs/notes/app-shell.md).
console.log(`起動:   env -u ELECTRON_RUN_AS_NODE open -a ${app}`)
