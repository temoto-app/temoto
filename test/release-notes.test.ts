/**
 * Release notes (TODO 1186, `docs/notes/public-repo.md` section 5.).
 *
 * - Cutting out a version's section from `CHANGELOG.md`; the repository's `CHANGELOG.md` has the section for the current version and no backend name.
 * - Automatic display happens once, at the first launch after the version goes up. The second time it does not open; it can be turned off in settings; a new install does not show it.
 * - Reading the bundled copy (`readChangelog`): does not read past the limit, or a symlink that leaves appPath.
 * - The wiring of the entry points (menu, settings, startup), and that the bundled copy (release's files) remains.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractVersionSection, shouldAutoShowReleaseNotes } from '../src/shared/release-notes.js'
import { ReleaseNotesService, readChangelog } from '../src/main/release-notes.js'
import { RELEASE_NOTES_AUTO, RELEASE_NOTES_LAST_SHOWN, agentSettingAccess, type SettingKey } from '../src/common/settings-keys.js'
import type { AppSettingsStore } from '../src/common/settings.js'
import { NATIVE_DICTIONARIES } from '../src/main/i18n-native.js'
import { RELEASE_NOTES_ITEM } from '../src/main/menu-model.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const repoRoot = join(__dirname, '..')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) removeTestDir(dir)
})

const SAMPLE = `# Changelog

## [0.79.0] - 2026-11-20

### Fixed

- Something fixed.

## [0.78.0] - 2026-11-08

Initial public release.

### Added

- Things.
`

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

function appWith(changelog: string | null): string {
  const dir = makeTestDir('release-notes')
  dirs.push(dir)
  if (changelog !== null) writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
  return dir
}

function service(options: { settings?: MemorySettings; version?: string; justUpdated?: boolean; changelog?: string | null }) {
  const settings = options.settings ?? new MemorySettings()
  const appPath = appWith(options.changelog === undefined ? SAMPLE : options.changelog)
  return {
    settings,
    service: new ReleaseNotesService({
      // Uses only readTyped / writeTyped (the round trip of the table key is handled by the real `defineKey`).
      settings: settings as unknown as AppSettingsStore,
      appPath,
      currentVersion: options.version ?? '0.79.0',
      justUpdated: () => options.justUpdated ?? false
    })
  }
}

describe('extractVersionSection', () => {
  it('その版の見出しから次の版の見出しの手前までを切り出す', () => {
    const section = extractVersionSection(SAMPLE, '0.79.0')
    expect(section).toContain('## [0.79.0] - 2026-11-20')
    expect(section).toContain('Something fixed.')
    expect(section).not.toContain('0.78.0')
    expect(extractVersionSection(SAMPLE, '0.78.0')).toContain('Initial public release.')
  })

  it('無い版は null', () => {
    expect(extractVersionSection(SAMPLE, '0.80.0')).toBeNull()
    expect(extractVersionSection('', '0.78.0')).toBeNull()
  })
})

describe('shouldAutoShowReleaseNotes', () => {
  const base = { enabled: true, lastShown: '0.78.0', current: '0.79.0', justUpdated: false }
  it('記録より新しい版でだけ出す', () => {
    expect(shouldAutoShowReleaseNotes(base)).toBe(true)
    expect(shouldAutoShowReleaseNotes({ ...base, lastShown: '0.79.0' })).toBe(false)
    expect(shouldAutoShowReleaseNotes({ ...base, lastShown: '0.80.0' })).toBe(false)
  })
  it('設定が切れていれば出さない', () => {
    expect(shouldAutoShowReleaseNotes({ ...base, enabled: false })).toBe(false)
  })
  it('記録が無いときは、更新の仕組みが版の上昇を見たときだけ出す (新規の入れ方では出さない)', () => {
    expect(shouldAutoShowReleaseNotes({ ...base, lastShown: null, justUpdated: false })).toBe(false)
    expect(shouldAutoShowReleaseNotes({ ...base, lastShown: null, justUpdated: true })).toBe(true)
  })
})

describe('ReleaseNotesService.takeAuto', () => {
  it('更新後の初回の起動で今の版の節だけを返し、2 回目は返さない', () => {
    const settings = new MemorySettings()
    settings.writeTyped(RELEASE_NOTES_LAST_SHOWN, '0.78.0')
    const { service: s } = service({ settings })
    const first = s.takeAuto()
    expect(first?.name).toBe('Release Notes 0.79.0.md')
    expect(first?.text).toContain('Something fixed.')
    expect(first?.text).not.toContain('Initial public release.')
    expect(settings.readTyped(RELEASE_NOTES_LAST_SHOWN)).toBe('0.79.0')
    expect(s.takeAuto()).toBeNull()
    // Does not show after a restart either (another service, the same record).
    expect(service({ settings }).service.takeAuto()).toBeNull()
  })

  it('設定で止めると出さない。記録は進むので、後で ON に戻しても古い節は出ない', () => {
    const settings = new MemorySettings()
    settings.writeTyped(RELEASE_NOTES_LAST_SHOWN, '0.78.0')
    const { service: s } = service({ settings })
    expect(s.setAuto(false)).toBe(false)
    expect(s.getAuto()).toBe(false)
    expect(s.takeAuto()).toBeNull()
    expect(settings.readTyped(RELEASE_NOTES_LAST_SHOWN)).toBe('0.79.0')
    s.setAuto(true)
    expect(s.takeAuto()).toBeNull()
    expect(settings.readTyped(RELEASE_NOTES_AUTO)).toBe(true)
  })

  it('記録が無い起動: 新規の入れ方では出さずに記録だけ残し、更新で来たなら出す', () => {
    const fresh = service({ justUpdated: false })
    expect(fresh.service.takeAuto()).toBeNull()
    expect(fresh.settings.readTyped(RELEASE_NOTES_LAST_SHOWN)).toBe('0.79.0')
    const updated = service({ justUpdated: true })
    expect(updated.service.takeAuto()?.text).toContain('Something fixed.')
  })

  it('同梱の変更履歴に今の版の節が無い・ファイルが無いときは null (落ちない)', () => {
    const settings = new MemorySettings()
    settings.writeTyped(RELEASE_NOTES_LAST_SHOWN, '0.70.0')
    expect(service({ settings, version: '0.90.0' }).service.takeAuto()).toBeNull()
    const s2 = new MemorySettings()
    s2.writeTyped(RELEASE_NOTES_LAST_SHOWN, '0.70.0')
    expect(service({ settings: s2, changelog: null }).service.takeAuto()).toBeNull()
  })

  it('版を下げて起動しても記録は後ろへ動かない。再び上げても見た節はまた開かない', () => {
    const settings = new MemorySettings()
    settings.writeTyped(RELEASE_NOTES_LAST_SHOWN, '0.79.0')
    expect(service({ settings, version: '0.78.0' }).service.takeAuto()).toBeNull()
    expect(settings.readTyped(RELEASE_NOTES_LAST_SHOWN)).toBe('0.79.0')
    expect(service({ settings, version: '0.79.0' }).service.takeAuto()).toBeNull()
  })

  it('読めない版の文字列では何もしない', () => {
    const { service: s, settings } = service({ version: 'dev' })
    expect(s.takeAuto()).toBeNull()
    expect(settings.values.size).toBe(0)
  })
})

describe('open / readChangelog', () => {
  it('全文を返す。ファイルが無ければ null', () => {
    expect(service({}).service.open()).toEqual({ name: 'Release Notes.md', text: SAMPLE })
    expect(service({ changelog: null }).service.open()).toBeNull()
  })

  it('appPath の外を指す symlink と、上限を超えるファイルは読まない', () => {
    const outsideDir = appWith('# secret\n')
    const app = appWith(null)
    symlinkSync(join(outsideDir, 'CHANGELOG.md'), join(app, 'CHANGELOG.md'))
    expect(readChangelog(app)).toBeNull()
    const big = appWith('x'.repeat(1024 * 1024 + 1))
    expect(readChangelog(big)).toBeNull()
  })

  it('appPath の中への symlink は読む', () => {
    const app = appWith(null)
    mkdirSync(join(app, 'real'))
    writeFileSync(join(app, 'real', 'c.md'), '# ok\n')
    symlinkSync(join(app, 'real', 'c.md'), join(app, 'CHANGELOG.md'))
    expect(readChangelog(app)).toBe('# ok\n')
  })
})

describe('リポジトリの CHANGELOG.md', () => {
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }

  it('今の版の節がある (波の締めで足す約束)', () => {
    const section = extractVersionSection(changelog, pkg.version)
    expect(section, `CHANGELOG.md に ${pkg.version} の節が無い`).not.toBeNull()
    expect(section).toMatch(/^## \[[\d.]+\] - \d{4}-\d{2}-\d{2}/)
    expect(section).toMatch(/### (Added|Changed|Fixed)/)
  })

  it('公開する文書なので、バックエンドの名前・TODO の番号・波の番号を書かない', () => {
    const terms = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8')) as { terms: string[] }
    for (const term of terms.terms) expect(changelog.toLowerCase()).not.toContain(term)
    expect(changelog).not.toMatch(/TODO\s*\d+/i)
    expect(changelog).not.toMatch(/第\s*\d+\s*波|\bwave\s*\d+/i)
  })
})

describe('入口と同梱の配線', () => {
  it('メニュー「ヘルプ > リリースノート」はキーを持たず openReleaseNotes を送り、EN / JA の語がある。menu.ts は role help の中に置く', () => {
    expect(RELEASE_NOTES_ITEM).toEqual({ command: 'openReleaseNotes', label: 'menu.releaseNotes' })
    expect(NATIVE_DICTIONARIES.en['menu.releaseNotes']).toBe('Release Notes')
    expect(NATIVE_DICTIONARIES.ja['menu.releaseNotes']).toBe('リリースノート')
    const source = readFileSync(join(repoRoot, 'src/main/menu.ts'), 'utf8')
    expect(source).toMatch(/role: 'help'[\s\S]*RELEASE_NOTES_ITEM/)
  })

  it('設定の「更新」の項目、「バージョン情報」のボタン、起動時の自動表示が繋がっている', () => {
    const model = readFileSync(join(repoRoot, 'src/renderer/src/settings-model.ts'), 'utf8')
    expect(model).toMatch(/item\('releaseNotesAuto', 'update', 'checkbox', 'releaseNotesAuto', 'releaseNotes\.auto'\)/)
    const about = readFileSync(join(repoRoot, 'src/renderer/src/components/BuildInfoSection.tsx'), 'utf8')
    expect(about).toContain("t('help.releaseNotes')")
    expect(about).toContain('onClick={openReleaseNotes}')
    const app = readFileSync(join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
    expect(app).toContain('showReleaseNotesIfUpdated()')
    // review Y-1: does not open until the thread restore (the viewer's memory closes the temporary view) is done.
    expect(app).toMatch(/releaseNotesReady = appInfoReady && initialOpenSettled/)
    const threadStore = readFileSync(join(repoRoot, 'src/renderer/src/threadStore.ts'), 'utf8')
    expect(threadStore).toMatch(/takeOpenRequest\(\)\.then\(settle, settle\)/)
    expect(app).toContain("command === 'openReleaseNotes'")
  })

  it('自動表示の設定は見た目の好み (display) で、AI が変えても関門は緩まない。記録の鍵は道具から見えない', () => {
    expect(agentSettingAccess(RELEASE_NOTES_AUTO)).toBe('display')
    expect(agentSettingAccess(RELEASE_NOTES_LAST_SHOWN)).toBeNull()
  })
})
