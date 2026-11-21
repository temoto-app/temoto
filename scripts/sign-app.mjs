#!/usr/bin/env node
// Re-signs an existing aios.app shell without remaking it (TODO 375, wave 20 bundle J).
//
//   node scripts/sign-app.mjs [shell path]   the default is ~/Applications/aios.app
//
// The target of `Contents/Resources/app` (aios-stable and the like) is not changed. `npm run app` remakes the shell and points it at that repo,
// so when you want only to change the signature, use this instead (the sign stage of scripts/verify-selfsign.sh calls it). The way the signing
// name is chosen is the same as in make-app.mjs (AIOS_SIGN_IDENTITY → "aios dev" in the keychain → ad-hoc + a warning).
//
// It can also be used on an old-form shell (CFBundleExecutable is a shell script and the binary is `aios-bin`): `aios-bin` also gets the
// identifier local.aios (the form that showed notifications when applied by hand on 2026-10-03). But the correct form is to remake it with
// make-app.mjs. The signature of a running shell is not changed (that would rewrite a binary that is running).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readCodesigningIdentities, resolveSignIdentity, signApp } from './app-shell.mjs'

if (process.platform !== 'darwin') {
  console.error('このスクリプトは macOS 専用。')
  process.exit(1)
}

const app = resolve(process.argv[2] ?? join(homedir(), 'Applications', 'aios.app'))
const plist = join(app, 'Contents', 'Info.plist')
if (!existsSync(plist)) {
  console.error(`殻が見つからない: ${app}`)
  process.exit(1)
}

let executable
try {
  executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  console.error(`Info.plist に CFBundleExecutable が無い: ${plist}`)
  process.exit(1)
}

// If the executable inside the shell is running, stop. (pgrep -f takes a regular expression, so passing the `.` through as it is would only match too broadly.)
try {
  execFileSync('pgrep', ['-f', `${join(app, 'Contents', 'MacOS')}/`], { stdio: 'ignore' })
  console.error(`${app} が動いている。終了してからもう一度走らせる。`)
  process.exit(1)
} catch { /* pgrep returned 1: not running */ }

if (existsSync(join(app, 'Contents', 'MacOS', 'aios-bin'))) {
  console.warn('旧い形の殻 (aios-bin)。署名だけ直すが、正しい形にするには make-app.mjs で作り直す。')
}

const sign = resolveSignIdentity({
  env: process.env.AIOS_SIGN_IDENTITY,
  findIdentityOutput: process.env.AIOS_SIGN_IDENTITY ? null : readCodesigningIdentities(),
})
if (sign.warning) console.warn(`警告: ${sign.warning}`)
console.log(`署名: ${sign.label}`)
try {
  const plan = signApp(app, sign.identity, { mainExecutable: `Contents/MacOS/${executable}` })
  console.log(`署名した: ${plan.length} 件 (${app})`)
} catch (error) {
  const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error)
  console.error(`codesign に失敗した。\n${detail}`)
  process.exit(1)
}
