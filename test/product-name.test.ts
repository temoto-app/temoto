// TODO 1254: the public product name (Temoto) and the public repository come from one place, `src/shared/product.json`.
// This test checks that every copy agrees with it, and that user-visible text does not hard-code the name (the old
// name `aios` stays only as an internal identifier).
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import product from '../src/shared/product.json' with { type: 'json' }
import { DATA_NAME, INSTALL_SCRIPT_NAME, LEGACY_DATA_NAME, PRODUCT_APP_BUNDLE, PRODUCT_NAME, PUBLIC_RELEASE_REPO, RELEASE_BUNDLE_ID } from '../src/shared/product.js'
import { APP_BUNDLE_NAME, APP_EXECUTABLE_NAME } from '../src/common/os/app-bundle.js'
import { USER_DATA_DB_FILE } from '../src/common/app-identity.js'
import { DEFAULT_RELEASE_REPO, releaseZipName } from '../src/main/update/layout.js'
import { NATIVE_DICTIONARIES, nativeText } from '../src/main/i18n-native.js'
import { DICTIONARIES } from '../src/renderer/src/i18n/index.js'
import { fillHelpNames, fillProductName } from '../src/shared/help.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { APP_BUNDLE, PRODUCT_NAME as SCRIPT_PRODUCT_NAME, RELEASE_REPO, dmgName, ghReleaseCommand, releaseConfig, zipName } from '../scripts/release-config.mjs'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { DISPLAY_NAME, infoPlistOps } from '../scripts/app-shell.mjs'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { PUBLIC_REPO } from '../scripts/publish-copy.mjs'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/**
 * `aios` used as the product name: not part of an identifier (`aios.diff`, `aios://`, `install-temoto.sh`, `~/aios/`,
 * `Logs/aios/`, `aios-reason`, `window.aios`) and not the keychain item `aios Safe Storage` (Electron's internal app name).
 */
const NAME_AS_WORD = /(?<![\w/.\-:"“「])aios(?![\w/:-]| Safe Storage|\.(?!app\b)[A-Za-z])/

/** Messages that mention `aios` as an identifier on purpose (the MCP server name, the development shell's file name). */
const IDENTIFIER_KEYS = new Set(['thread.mcp.gatewayConflict', 'update.unsupported.dev-shell'])

describe('the product name and the public repo values are in one place (TODO 1254)', () => {
  it('values of product.json', () => {
    expect(product.name).toBe('Temoto')
    expect(product.releaseRepo).toBe('temoto-app/temoto')
    expect(PRODUCT_NAME).toBe(product.name)
    expect(PUBLIC_RELEASE_REPO).toBe(product.releaseRepo)
    expect(PRODUCT_APP_BUNDLE).toBe('Temoto.app')
    // TODO 1263 (owner decisions 2026-11-20)
    expect(product.bundleId).toBe('io.github.temoto-app.temoto')
    expect(product.dataName).toBe('Temoto')
    expect(product.legacyDataName).toBe('aios')
    expect(product.urlSchemes).toEqual(['aios', 'temoto'])
    expect(product.installScript).toBe('install-temoto.sh')
    expect(existsSync(new URL('../scripts/install-aios.sh', import.meta.url))).toBe(false)
    expect(read('README.md')).not.toContain('install-aios.sh')
  })

  it('main, auto-update, and the build scripts take the same value', () => {
    expect(APP_BUNDLE_NAME).toBe(PRODUCT_APP_BUNDLE)
    expect(APP_EXECUTABLE_NAME).toBe(PRODUCT_NAME)
    expect(DEFAULT_RELEASE_REPO).toBe(PUBLIC_RELEASE_REPO)
    expect(SCRIPT_PRODUCT_NAME).toBe(PRODUCT_NAME)
    expect(APP_BUNDLE).toBe(PRODUCT_APP_BUNDLE)
    expect(DISPLAY_NAME).toBe(PRODUCT_NAME)
    expect(RELEASE_REPO).toBe(PUBLIC_RELEASE_REPO)
    expect(PUBLIC_REPO).toBe(PUBLIC_RELEASE_REPO)
    expect(zipName('1.2.3')).toBe(releaseZipName('1.2.3'))
    expect(zipName('1.2.3')).toBe('Temoto-1.2.3-arm64-mac.zip')
    expect(dmgName('1.2.3')).toBe('Temoto-1.2.3-arm64.dmg')
    const config = releaseConfig({ version: '1.2.3' }) as { productName: string; dmg: { title: string } }
    expect(config.productName).toBe(PRODUCT_NAME)
    expect(config.dmg.title).toBe('Temoto ${version}')
    expect(ghReleaseCommand({ version: '1.2.3', commit: null })).toContain('--title "Temoto 1.2.3"')
  })

  it('the display name in Info.plist of the shell and the distributed build (Dock, menu bar)', () => {
    const ops = infoPlistOps({ version: '1.2.3' }) as Array<{ op: string; key: string; value?: string }>
    const value = (key: string): string | undefined => ops.find((o) => o.op === 'set' && o.key === key)?.value
    expect(value('CFBundleName')).toBe(PRODUCT_NAME)
    expect(value('CFBundleDisplayName')).toBe(PRODUCT_NAME)
    // The identifier and the executable of the development shell keep the internal name (TODO 1263: the distributed build passes RELEASE_BUNDLE_ID)
    expect(value('CFBundleIdentifier')).toBe('local.aios')
    expect(value('CFBundleExecutable')).toBe('aios')
  })

  it('the copy in a shell that cannot read JSON is the same as product.json', () => {
    const installAios = read('scripts/install-temoto.sh')
    expect(installAios).toMatch(new RegExp(`^PRODUCT=${PRODUCT_NAME}$`, 'm'))
    expect(installAios).toMatch(new RegExp(`^PUBLIC_REPO=${PUBLIC_RELEASE_REPO}$`, 'm'))
    expect(installAios).toContain(`gh release download -R ${PUBLIC_RELEASE_REPO} -p ${INSTALL_SCRIPT_NAME}`)
    expect(installAios).toContain(`curl -fsSLO https://github.com/${PUBLIC_RELEASE_REPO}/releases/latest/download/${INSTALL_SCRIPT_NAME}`)
    // TODO 1263: the identifiers and the data-name decision
    expect(installAios).toMatch(new RegExp(`^BUNDLE_ID=${RELEASE_BUNDLE_ID}$`, 'm'))
    expect(installAios).toMatch(new RegExp(`^DATA_NAME=${DATA_NAME}$`, 'm'))
    expect(installAios).toMatch(new RegExp(`^LEGACY_DATA_NAME=${LEGACY_DATA_NAME}$`, 'm'))
    expect(installAios).toContain('LEGACY_USER_DATA="$HOME/Library/Application Support/$LEGACY_DATA_NAME"')
    // code-review: the new name's userData that already holds the DB wins (the same order as chooseAppIdentity; the decision itself is
    // run against the TS one for every case in test/app-identity.test.ts)
    expect(installAios).toContain('CURRENT_USER_DATA="$HOME/Library/Application Support/$DATA_NAME"')
    expect(installAios).toMatch(new RegExp(`^USER_DATA_DB=${USER_DATA_DB_FILE.replace('.', '\\.')}$`, 'm'))
    expect(installAios).toContain(
      'current_has_db() { [ -d "$CURRENT_USER_DATA" ] && [ ! -L "$CURRENT_USER_DATA" ] && [ -f "$CURRENT_USER_DATA/$USER_DATA_DB" ] && [ ! -L "$CURRENT_USER_DATA/$USER_DATA_DB" ]; }'
    )
    expect(installAios).toContain(
      'if ! current_has_db && [ -d "$LEGACY_USER_DATA" ] && [ ! -L "$LEGACY_USER_DATA" ]; then DATA_NAME="$LEGACY_DATA_NAME"; fi'
    )
    expect(read('scripts/verify-sign.sh')).toMatch(new RegExp(`^BUNDLE_ID=${RELEASE_BUNDLE_ID}$`, 'm'))
    const devInstance = read('scripts/dev-instance.sh')
    expect(devInstance).toContain(`current="$HOME/Library/Application Support/${DATA_NAME}"`)
    expect(devInstance).toContain(`legacy="$HOME/Library/Application Support/${LEGACY_DATA_NAME}"`)
    expect(devInstance).toContain(
      `if ! { [ -d "$current" ] && [ ! -L "$current" ] && [ -f "$current/${USER_DATA_DB_FILE}" ] && [ ! -L "$current/${USER_DATA_DB_FILE}" ]; } && [ -d "$legacy" ] && [ ! -L "$legacy" ]; then real="$legacy"; fi`
    )
    const installSh = read('scripts/install.sh')
    expect(installSh).toContain(`REPO="\${AIOS_REPO:-${PUBLIC_RELEASE_REPO}}"`)
  })

  it('the previous public repo name (aios-desktop) does not remain in the destination', () => {
    for (const path of [
      'README.md',
      'EULA.md',
      'CLA.md',
      'CONTRIBUTING.md',
      '.github/workflows/cla.yml',
      'scripts/install-temoto.sh',
      'scripts/install.sh',
      'scripts/release-config.mjs',
      'src/main/update/layout.ts'
    ]) {
      expect(read(path), path).not.toContain('aios-desktop')
    }
  })
})

describe('user-visible text does not hardcode the product name (TODO 1254)', () => {
  it('the renderer dictionary is written with {app}', () => {
    for (const [locale, table] of Object.entries(DICTIONARIES)) {
      for (const [key, text] of Object.entries(table)) {
        if (IDENTIFIER_KEYS.has(key)) continue
        expect(text, `${locale} ${key}`).not.toMatch(NAME_AS_WORD)
      }
    }
  })

  it('the native UI table is written with {app} and nativeText fills it in', () => {
    for (const [locale, table] of Object.entries(NATIVE_DICTIONARIES)) {
      for (const [key, text] of Object.entries(table)) {
        expect(text, `${locale} ${key}`).not.toMatch(NAME_AS_WORD)
        expect(text, `${locale} ${key}`).not.toContain(PRODUCT_NAME)
      }
    }
    expect(nativeText('en', 'menu.helpItem')).toBe('Temoto Help')
    expect(nativeText('ja', 'menu.about')).toBe('Temoto について')
    expect(nativeText('en', 'menu.quit')).toBe('Quit Temoto')
  })

  it('the bundled Help is written with {{app.name}} and is filled in when opened and when exported', () => {
    for (const path of ['resources/help/index.html', 'resources/help/ai-guide.md']) {
      // Skip the notes for developers (HTML comments) and the script that only runs when opened in an ordinary browser
      const shown = read(path).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/g, '')
      expect(shown, path).not.toMatch(NAME_AS_WORD)
      expect(shown, path).not.toContain(PRODUCT_NAME)
      expect(shown, path).toContain('{{app.name}}')
      expect(fillHelpNames(shown, {}, 'Temoto'), path).not.toContain('{{app.name}}')
      expect(fillHelpNames(shown, {}, 'Temoto'), path).not.toContain('{{app.dataName}}')
    }
    expect(fillProductName('<title>{{app.name}} Help</title>')).toBe('<title>Temoto Help</title>')
  })

  it('the window title has %PRODUCT_NAME% in index.html filled in by electron-vite', () => {
    expect(read('src/renderer/index.html')).toContain('<title>%PRODUCT_NAME%</title>')
    expect(read('electron.vite.config.ts')).toContain("replaceAll('%PRODUCT_NAME%', PRODUCT_NAME)")
  })

  it('the top of the README is a one-sentence English statement of the name and what it does, and a line saying it is unrelated to the different Temoto', () => {
    const readme = read('README.md')
    expect(readme.startsWith('# Temoto\n')).toBe(true)
    expect(readme).toMatch(/^Temoto is a macOS desktop app that runs the AI coding agent CLI/m)
    expect(readme).toContain('is not related to the TeMoto robotics framework or to other projects named Temoto')
  })
})
