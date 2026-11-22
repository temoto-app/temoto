// TODO 1263: the data name is decided once per launch from the legacy userData (`src/common/app-identity.ts`), and every user-visible
// location follows that one decision (owner decision 2026-11-20: two names side by side, no key re-seal, no DB move).
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CURRENT_IDENTITY,
  LEGACY_IDENTITY,
  USER_DATA_DB_FILE,
  appIdentity,
  chooseAppIdentity,
  currentUserDataPath,
  defaultInstallRootFor,
  homeDataDir,
  homeDataDirDisplay,
  initAppIdentity,
  keychainItemName,
  legacyUserDataPath,
  probeCurrentUserDataDb,
  probeLegacyUserData,
  probeUserData,
  type LegacyUserDataState,
  type UserDataProbe
} from '../src/common/app-identity.js'
import { DB_FILE } from '../src/main/db/index.js'
import { scratchCwd, scratchRoot } from '../src/main/session/scratch.js'
import { helpExportDir, syncHelpDocs } from '../src/main/help-sync.js'
import { fillHelpNames } from '../src/shared/help.js'
import { appIntroductionText, loadCompatTable } from '../src/main/session/adapter/compat.js'
import { findAppUrlInArgv, isAppUrl, parseAppUrl } from '../src/common/app-url.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) removeTestDir(dir)
})
function tempDir(name: string): string {
  const dir = makeTestDir(name)
  dirs.push(dir)
  return dir
}

describe('deciding the data name (TODO 1263)', () => {
  it("aios if the previous name's userData is a real directory, Temoto otherwise", () => {
    const legacy = (state: LegacyUserDataState): UserDataProbe => ({ currentHasDb: false, legacy: state })
    expect(chooseAppIdentity(legacy('directory'))).toEqual({ kind: 'legacy', dataName: 'aios' })
    expect(chooseAppIdentity(legacy('absent'))).toEqual({ kind: 'current', dataName: 'Temoto' })
    // A symlink or a file is not the legacy userData (not followed)
    expect(chooseAppIdentity(legacy('other'))).toBe(CURRENT_IDENTITY)
    // Could not look (permissions): the data is probably there, so the legacy name is kept
    expect(chooseAppIdentity(legacy('unknown'))).toBe(LEGACY_IDENTITY)
  })

  it("code-review: if a DB already exists on the Temoto side, stays Temoto even if the previous name's userData appears later", () => {
    for (const state of ['directory', 'absent', 'other', 'unknown'] as const) {
      expect(chooseAppIdentity({ currentHasDb: true, legacy: state })).toBe(CURRENT_IDENTITY)
    }
  })

  // The four cases on disk, and the two shell copies (install-temoto.sh / dev-instance.sh) make the same decision for each
  const cases: Array<{ name: string; temoto: 'db' | 'empty' | 'none'; legacy: boolean; expected: string }> = [
    { name: 'Temoto に DB あり + 前の名前あり → Temoto', temoto: 'db', legacy: true, expected: 'Temoto' },
    { name: 'Temoto は空のディレクトリ + 前の名前あり → aios', temoto: 'empty', legacy: true, expected: 'aios' },
    { name: '両方なし → Temoto', temoto: 'none', legacy: false, expected: 'Temoto' },
    { name: '前の名前だけ → aios (開発機・dogfood・招待者の機械)', temoto: 'none', legacy: true, expected: 'aios' }
  ]
  function makeHome(c: (typeof cases)[number]): { home: string; appData: string } {
    const home = tempDir('identity-case')
    const appData = join(home, 'Library', 'Application Support')
    mkdirSync(appData, { recursive: true })
    if (c.temoto !== 'none') mkdirSync(join(appData, 'Temoto'))
    if (c.temoto === 'db') writeFileSync(join(appData, 'Temoto', USER_DATA_DB_FILE), '')
    if (c.legacy) mkdirSync(join(appData, 'aios'))
    return { home, appData }
  }
  const script = (name: string): string => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8')
  // The decision lines of each script, lifted out of the text and run alone with a temporary HOME
  const installBlock = /^DATA_NAME=Temoto$[\s\S]*?then DATA_NAME="\$LEGACY_DATA_NAME"; fi$/m.exec(script('install-temoto.sh'))?.[0] ?? ''
  const devBlock = /^current=[\s\S]*?then real="\$legacy"; fi$/m.exec(script('dev-instance.sh'))?.[0] ?? ''
  const runShell = (shell: string, body: string, home: string): string =>
    execFileSync(shell, ['-c', body], { encoding: 'utf8', env: { ...process.env, HOME: home } }).trim()

  for (const c of cases) {
    it(`code-review: ${c.name} (TS, install-temoto.sh, and dev-instance.sh agree)`, () => {
      const { home, appData } = makeHome(c)
      expect(chooseAppIdentity(probeUserData(appData)).dataName).toBe(c.expected)
      expect(installBlock).not.toBe('')
      expect(runShell('bash', `set -euo pipefail\n${installBlock}\necho "$DATA_NAME"`, home)).toBe(c.expected)
      expect(devBlock).not.toBe('')
      expect(runShell('sh', `set -eu\n${devBlock}\necho "$real"`, home)).toBe(join(appData, c.expected))
    })
  }

  it('code-review: also looks at the Temoto side DB with lstat (a symlinked DB or folder does not count)', () => {
    const linkedDb = tempDir('identity-db-symlink')
    mkdirSync(join(linkedDb, 'Temoto'))
    writeFileSync(join(linkedDb, 'real.db'), '')
    symlinkSync(join(linkedDb, 'real.db'), join(linkedDb, 'Temoto', USER_DATA_DB_FILE))
    mkdirSync(join(linkedDb, 'aios'))
    expect(probeCurrentUserDataDb(linkedDb)).toBe(false)
    expect(chooseAppIdentity(probeUserData(linkedDb))).toBe(LEGACY_IDENTITY)

    const linkedDir = tempDir('identity-dir-symlink')
    mkdirSync(join(linkedDir, 'elsewhere'))
    writeFileSync(join(linkedDir, 'elsewhere', USER_DATA_DB_FILE), '')
    symlinkSync(join(linkedDir, 'elsewhere'), join(linkedDir, 'Temoto'))
    expect(probeCurrentUserDataDb(linkedDir)).toBe(false)

    // A directory named like the DB is not the DB
    const dirDb = tempDir('identity-db-dir')
    mkdirSync(join(dirDb, 'Temoto', USER_DATA_DB_FILE), { recursive: true })
    expect(probeCurrentUserDataDb(dirDb)).toBe(false)

    // Could not look: counts as "no", so the legacy rule decides as before
    const denied = (): never => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    expect(probeCurrentUserDataDb('/x', denied)).toBe(false)
    expect(currentUserDataPath('/x')).toBe(join('/x', 'Temoto'))
    expect(DB_FILE).toBe(USER_DATA_DB_FILE)
  })

  it('looks with lstat: real directory / missing / symlink / file', () => {
    const appData = tempDir('identity-appdata')
    expect(legacyUserDataPath(appData)).toBe(join(appData, 'aios'))
    expect(probeLegacyUserData(appData)).toBe('absent')
    mkdirSync(join(appData, 'aios'))
    expect(probeLegacyUserData(appData)).toBe('directory')

    const linked = tempDir('identity-symlink')
    const elsewhere = join(linked, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(linked, 'aios'))
    expect(probeLegacyUserData(linked)).toBe('other')
    expect(chooseAppIdentity(probeUserData(linked))).toBe(CURRENT_IDENTITY)

    const file = tempDir('identity-file')
    writeFileSync(join(file, 'aios'), '')
    expect(probeLegacyUserData(file)).toBe('other')

    const denied = (): never => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    expect(probeLegacyUserData('/x', denied)).toBe('unknown')
  })

  it('even with --user-data-dir (dev:instance, proxy verification) the decision is made in the userData inside appData (not the target of --user-data-dir)', () => {
    // `appData` is the OS location, which --user-data-dir does not change; the copy is sealed with the key of the machine's name
    const appData = tempDir('identity-instance')
    mkdirSync(join(appData, 'aios'))
    const copy = join(appData, 'aios-dev-data')
    mkdirSync(copy)
    expect(chooseAppIdentity(probeUserData(appData))).toBe(LEGACY_IDENTITY)
  })

  it('once decided it cannot be switched to another name (the path does not change mid-launch)', () => {
    // test/setup/app-identity.ts fixed the legacy name, as main does at launch
    expect(appIdentity()).toBe(LEGACY_IDENTITY)
    expect(initAppIdentity(LEGACY_IDENTITY)).toBe(LEGACY_IDENTITY)
    expect(() => initAppIdentity(CURRENT_IDENTITY)).toThrow()
    expect(appIdentity()).toBe(LEGACY_IDENTITY)
  })

  it('the keychain item name, ~/<name>, and the version location all come from the same single name', () => {
    expect(keychainItemName(LEGACY_IDENTITY)).toBe('aios Safe Storage')
    expect(keychainItemName(CURRENT_IDENTITY)).toBe('Temoto Safe Storage')
    expect(homeDataDir('/Users/u', 'Temoto')).toBe('/Users/u/Temoto')
    expect(homeDataDir('/Users/u')).toBe('/Users/u/aios')
    expect(defaultInstallRootFor('/Users/u', 'Temoto')).toBe('/Users/u/.local/share/Temoto')
    expect(homeDataDirDisplay('Temoto')).toBe('~/Temoto')
    expect(scratchRoot('/Users/u')).toBe('/Users/u/aios/scratch')
    expect(scratchRoot('/Users/u', 'Temoto')).toBe('/Users/u/Temoto/scratch')
    expect(scratchCwd('/Users/u', 'abc')).toBe('/Users/u/aios/scratch/abc')
    expect(helpExportDir('/Users/u', 'Temoto')).toBe('/Users/u/Temoto/help')
  })

  it('the Help copy is written to ~/Temoto/help for the new name and fills in {{app.dataName}}', () => {
    const base = tempDir('identity-help')
    const root = join(base, 'bundled')
    const home = join(base, 'home')
    mkdirSync(root)
    mkdirSync(home)
    writeFileSync(join(root, 'index.html'), '<p>{{app.dataName}} Safe Storage / ~/Library/Logs/{{app.dataName}}/</p>')
    writeFileSync(join(root, 'ai-guide.md'), '# guide')
    expect(syncHelpDocs({ root, home, version: '1', names: {}, dataName: 'Temoto' })).toBe('written')
    expect(helpExportDir(home, 'Temoto')).toBe(join(home, 'Temoto', 'help'))
    expect(fillHelpNames('{{app.dataName}} Safe Storage', {}, 'aios')).toBe('aios Safe Storage')
  })

  it("the extra instructions for the AI fill the Help copy's location ({helpDir}) with that machine's name", () => {
    const table = loadCompatTable()
    const legacy = appIntroductionText(table) ?? ''
    expect(legacy).toContain('~/aios/help/ai-guide.md')
    expect(legacy).not.toContain('{helpDir}')
    expect(appIntroductionText(table, '~/Temoto/help') ?? '').toContain('~/Temoto/help/ai-guide.md')
  })
})

describe('URL scheme alias temoto:// (TODO 1263)', () => {
  it('accepts aios:// and temoto:// the same way', () => {
    expect(isAppUrl('temoto://new')).toBe(true)
    expect(isAppUrl('TEMOTO:new')).toBe(true)
    expect(isAppUrl('aios://new')).toBe(true)
    expect(isAppUrl('temotox://new')).toBe(false)
    const parsed = parseAppUrl('temoto://new?cwd=/tmp&text=hi')
    expect(parsed).toEqual({ ok: true, request: { action: 'new', cwd: '/tmp', text: 'hi', files: [], dropped: [] } })
    expect(findAppUrlInArgv(['--flag', 'temoto://new'])).toBe('temoto://new')
  })
})
