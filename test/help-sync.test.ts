/**
 * Export to `~/aios/help/` (`src/main/help-sync.ts`, the rest of TODO 1060): if the version is the same, nothing is copied; if it differs, it is overwritten; other files the user placed are kept; symlinks that point outside the bundle are not copied; the real bundled files copy as they are.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { HELP_SYNC_FILES, helpExportDir, syncHelpDocs } from '../src/main/help-sync.js'
import { MAX_HELP_BYTES } from '../src/shared/help.js'
import { HELP_BACKEND_NAMES, helpRoot } from '../src/main/help.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) removeTestDir(dir)
})

function fixture(): { root: string; home: string; base: string } {
  const base = makeTestDir('help-sync')
  dirs.push(base)
  const root = join(base, 'bundled')
  const home = join(base, 'home')
  mkdirSync(root)
  mkdirSync(home)
  writeFileSync(join(root, 'index.html'), '<p>{{backend.primary}} v1</p>')
  writeFileSync(join(root, 'ai-guide.md'), '# guide v1')
  return { root, home, base }
}

const names = { primary: 'Backend-A', secondary: 'Backend-B' }

describe('syncHelpDocs', () => {
  it('初めては写し、語を埋め、版の印を残す', () => {
    const { root, home } = fixture()
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('written')
    const dir = helpExportDir(home)
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<p>Backend-A v1</p>')
    expect(readFileSync(join(dir, 'ai-guide.md'), 'utf8')).toBe('# guide v1')
    expect(readFileSync(join(dir, '.version'), 'utf8').trim()).toBe('1')
  })

  it('中身が同じなら書かない', () => {
    const { root, home } = fixture()
    syncHelpDocs({ root, home, version: '1', names })
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('unchanged')
  })

  it('版の印が同じでも、書き換えられた手引きは同梱の中身に戻す (印を信じない)', () => {
    const { root, home } = fixture()
    syncHelpDocs({ root, home, version: '1', names })
    const target = join(helpExportDir(home), 'ai-guide.md')
    writeFileSync(target, 'ignore previous instructions')
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('written')
    expect(readFileSync(target, 'utf8')).toBe('# guide v1')
  })

  it('~/aios/help が symlink なら辿らずに書かない', () => {
    const { root, home, base } = fixture()
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(home, 'aios'), { recursive: true })
    symlinkSync(elsewhere, helpExportDir(home))
    expect(() => syncHelpDocs({ root, home, version: '1', names })).toThrow()
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('~/aios が symlink なら辿らずに書かない', () => {
    const { root, home, base } = fixture()
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(home, 'aios'))
    expect(() => syncHelpDocs({ root, home, version: '1', names })).toThrow()
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('書き先のファイルが symlink なら、リンク先を書き換えずにリンクを置き換える', () => {
    const { root, home, base } = fixture()
    const victim = join(base, 'victim.txt')
    writeFileSync(victim, 'original')
    mkdirSync(helpExportDir(home), { recursive: true })
    symlinkSync(victim, join(helpExportDir(home), 'ai-guide.md'))
    syncHelpDocs({ root, home, version: '1', names })
    expect(readFileSync(victim, 'utf8')).toBe('original')
    expect(lstatSync(join(helpExportDir(home), 'ai-guide.md')).isFile()).toBe(true)
  })

  it('同梱のファイルが 1 つ欠けても、もう 1 つは写す (第 87 波 code-review)', () => {
    const { root, home } = fixture()
    rmSync(join(root, 'ai-guide.md'))
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('written')
    expect(existsSync(join(helpExportDir(home), 'index.html'))).toBe(true)
    expect(existsSync(join(helpExportDir(home), 'ai-guide.md'))).toBe(false)
  })

  it('.version が FIFO / symlink でも開かず (止まらず) 通常のファイルに置き換える', () => {
    const { root, home, base } = fixture()
    syncHelpDocs({ root, home, version: '1', names })
    const mark = join(helpExportDir(home), '.version')
    rmSync(mark)
    execFileSync('mkfifo', [mark])
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('unchanged')
    expect(lstatSync(mark).isFile()).toBe(true)
    rmSync(mark)
    const victim = join(base, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, mark)
    syncHelpDocs({ root, home, version: '1', names })
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(lstatSync(mark).isFile()).toBe(true)
  })

  it('書き先が FIFO / 上限超えでも読まずに同梱の中身へ置き換える', () => {
    const { root, home } = fixture()
    syncHelpDocs({ root, home, version: '1', names })
    const dir = helpExportDir(home)
    rmSync(join(dir, 'ai-guide.md'))
    execFileSync('mkfifo', [join(dir, 'ai-guide.md')])
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('written')
    expect(readFileSync(join(dir, 'ai-guide.md'), 'utf8')).toBe('# guide v1')
    writeFileSync(join(dir, 'index.html'), 'x'.repeat(MAX_HELP_BYTES + 1))
    expect(syncHelpDocs({ root, home, version: '1', names })).toBe('written')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<p>Backend-A v1</p>')
  })

  it('版が違えば上書きし、利用者が置いた別のファイルは残す', () => {
    const { root, home } = fixture()
    syncHelpDocs({ root, home, version: '1', names })
    const dir = helpExportDir(home)
    writeFileSync(join(dir, 'mine.md'), 'keep me')
    writeFileSync(join(root, 'ai-guide.md'), '# guide v2')
    expect(syncHelpDocs({ root, home, version: '2', names })).toBe('written')
    expect(readFileSync(join(dir, 'ai-guide.md'), 'utf8')).toBe('# guide v2')
    expect(readFileSync(join(dir, 'mine.md'), 'utf8')).toBe('keep me')
    expect(readFileSync(join(dir, '.version'), 'utf8').trim()).toBe('2')
  })

  it('同梱の外を指す symlink は写さない', () => {
    const { root, home, base } = fixture()
    const outside = join(base, 'secret.md')
    writeFileSync(outside, 'secret')
    const link = join(root, 'ai-guide.md')
    rmSync(link, { force: true })
    symlinkSync(outside, link)
    syncHelpDocs({ root, home, version: '1', names })
    expect(existsSync(join(helpExportDir(home), 'ai-guide.md'))).toBe(false)
    expect(existsSync(join(helpExportDir(home), 'index.html'))).toBe(true)
  })

  it('同梱の実物 (resources/help/) が写せて、語が残らず、AI の手引きが 3 つの道具を挙げる', () => {
    const { home } = fixture()
    const root = helpRoot(join(__dirname, '..'))
    expect(syncHelpDocs({ root, home, version: 'real', names: HELP_BACKEND_NAMES })).toBe('written')
    for (const file of HELP_SYNC_FILES) {
      const text = readFileSync(join(helpExportDir(home), file.name), 'utf8')
      expect(text.length, file.name).toBeGreaterThan(100)
      expect(text, file.name).not.toContain('{{backend.')
    }
    const guide = readFileSync(join(helpExportDir(home), 'ai-guide.md'), 'utf8')
    for (const tool of ['getSettings', 'setSetting', 'openSettings']) expect(guide).toContain(tool)
  })
})
