/**
 * TODO 1145: renaming in the Files tree (main's entry point `renameEntry`). In a real temporary directory:
 * changing a name, an existing name, `/` and empty, not escaping the same folder, changing only the case, the name of a symlink itself, exclusions, and a missing original.
 * The temp folder is under `~/.aios-test` (macOS's `os.tmpdir()` hits the exclusion). Calls neither the model nor Electron.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FsAccess } from '../src/main/fs/access.js'
import { renameEntry } from '../src/main/fs/rename.js'
import { checkRenameName } from '../src/shared/new-entry.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

describe('checkRenameName (TODO 1145)', () => {
  it('普通の名前は前後の空白を落として通し、/ ・空・. ・.. ・制御文字・長すぎる名前を断る', () => {
    expect(checkRenameName('  a.txt ')).toEqual({ ok: true, name: 'a.txt' })
    expect(checkRenameName('.env')).toEqual({ ok: true, name: '.env' })
    expect(checkRenameName('a/b')).toEqual({ ok: false, code: 'rename-name-slash' })
    expect(checkRenameName('/etc')).toEqual({ ok: false, code: 'rename-name-slash' })
    expect(checkRenameName('../x')).toEqual({ ok: false, code: 'rename-name-slash' })
    expect(checkRenameName('   ')).toMatchObject({ ok: false, code: 'create-name-empty' })
    expect(checkRenameName('..')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkRenameName('.')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkRenameName('a\u0000b')).toMatchObject({ ok: false, code: 'create-name-invalid-char' })
    expect(checkRenameName('あ'.repeat(86))).toMatchObject({ ok: false, code: 'create-name-too-long' })
  })
})

describe('renameEntry: 実物の一時ディレクトリ (TODO 1145)', () => {
  let home: string
  let outside: string
  let gate: FsAccess

  beforeAll(() => {
    home = makeTestDir('fs-rename')
    outside = makeTestDir('fs-rename-outside')
    gate = new FsAccess(home, [home])
    mkdirSync(join(home, 'proj'))
    mkdirSync(join(home, 'proj', 'sub'))
    writeFileSync(join(home, 'proj', 'sub', 'in.txt'), 'inner\n')
    writeFileSync(join(home, 'proj', 'a.txt'), 'A\n')
    writeFileSync(join(home, 'proj', 'b.txt'), 'B\n')
    writeFileSync(join(home, 'proj', 'case.txt'), 'case\n')
    writeFileSync(join(outside, 'target.txt'), 'outside\n')
    symlinkSync(join(outside, 'target.txt'), join(home, 'proj', 'link.txt'))
    mkdirSync(join(home, 'proj', 'node_modules'))
    writeFileSync(join(home, 'proj', 'plain.txt'), 'p\n')
  })

  afterAll(() => {
    removeTestDir(home)
    removeTestDir(outside)
  })

  const uriOf = (...parts: string[]): string => pathToUri(join(home, 'proj', ...parts))

  it('ファイルの名前を変える。新しい URI は同じ親の下、中身はそのまま', () => {
    const result = renameEntry(gate, uriOf('a.txt'), 'a2.txt')
    expect(result).toEqual({ uri: uriOf('a2.txt'), reason: null })
    expect(existsSync(join(home, 'proj', 'a.txt'))).toBe(false)
    expect(readFileSync(join(home, 'proj', 'a2.txt'), 'utf8')).toBe('A\n')
  })

  it('フォルダの名前を変える (中身はついてくる)', () => {
    const result = renameEntry(gate, uriOf('sub'), 'sub2')
    expect(result.reason).toBeNull()
    expect(readFileSync(join(home, 'proj', 'sub2', 'in.txt'), 'utf8')).toBe('inner\n')
  })

  it('既にある名前 (ファイルでもフォルダでも) は断り、どちらも変えない', () => {
    expect(renameEntry(gate, uriOf('b.txt'), 'a2.txt')).toEqual({
      uri: null,
      reason: 'create-exists',
      params: { name: 'a2.txt' }
    })
    expect(renameEntry(gate, uriOf('b.txt'), 'sub2')).toMatchObject({ uri: null, reason: 'create-exists' })
    expect(readFileSync(join(home, 'proj', 'b.txt'), 'utf8')).toBe('B\n')
    expect(readFileSync(join(home, 'proj', 'a2.txt'), 'utf8')).toBe('A\n')
  })

  it('空・/ を含む名前・.. は断る。別のフォルダへ動かす道はない', () => {
    expect(renameEntry(gate, uriOf('b.txt'), '')).toMatchObject({ uri: null, reason: 'create-name-empty' })
    expect(renameEntry(gate, uriOf('b.txt'), 'sub2/b.txt')).toMatchObject({ uri: null, reason: 'rename-name-slash' })
    expect(renameEntry(gate, uriOf('b.txt'), '../b.txt')).toMatchObject({ uri: null, reason: 'rename-name-slash' })
    expect(renameEntry(gate, uriOf('b.txt'), '..')).toMatchObject({ uri: null, reason: 'create-name-segment' })
    expect(existsSync(join(home, 'proj', 'b.txt'))).toBe(true)
    expect(existsSync(join(home, 'b.txt'))).toBe(false)
  })

  it('同じ名前は何もせず成功。大小だけの変更は通る', () => {
    expect(renameEntry(gate, uriOf('b.txt'), 'b.txt')).toEqual({ uri: uriOf('b.txt'), reason: null })
    expect(renameEntry(gate, uriOf('case.txt'), 'CASE.txt').reason).toBeNull()
    expect(existsSync(join(home, 'proj', 'CASE.txt'))).toBe(true)
  })

  it('review の直し: ハードリンクの兄弟 (同じ ino で名前が違う) への変更は create-exists で断る。両方の名前が残る', () => {
    writeFileSync(join(home, 'proj', 'hard-a.txt'), 'H\n')
    linkSync(join(home, 'proj', 'hard-a.txt'), join(home, 'proj', 'hard-b.txt'))
    expect(lstatSync(join(home, 'proj', 'hard-a.txt')).ino).toBe(lstatSync(join(home, 'proj', 'hard-b.txt')).ino)
    expect(renameEntry(gate, uriOf('hard-a.txt'), 'hard-b.txt')).toEqual({
      uri: null,
      reason: 'create-exists',
      params: { name: 'hard-b.txt' }
    })
    // A sibling whose name differs only in case is also refused on a case-insensitive FS, where the earlier lstat hits the sibling.
    if (existsSync(join(home, 'proj', 'HARD-B.txt'))) {
      expect(renameEntry(gate, uriOf('hard-a.txt'), 'HARD-B.txt')).toMatchObject({ uri: null, reason: 'create-exists' })
    }
    expect(existsSync(join(home, 'proj', 'hard-a.txt'))).toBe(true)
    expect(existsSync(join(home, 'proj', 'hard-b.txt'))).toBe(true)
    // Changing only the case of your own name still passes as before.
    expect(renameEntry(gate, uriOf('hard-a.txt'), 'HARD-A.txt').reason).toBeNull()
  })

  it('許可の中を指す symlink はリンクそのものの名前を変える (リンク先は動かない)。外を指すものは関門が断る', () => {
    symlinkSync(join(home, 'proj', 'plain.txt'), join(home, 'proj', 'inner-link.txt'))
    const result = renameEntry(gate, uriOf('inner-link.txt'), 'inner-link2.txt')
    expect(result.reason).toBeNull()
    expect(lstatSync(join(home, 'proj', 'inner-link2.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(home, 'proj', 'plain.txt'), 'utf8')).toBe('p\n')
    expect(renameEntry(gate, uriOf('link.txt'), 'link2.txt')).toMatchObject({ uri: null, reason: 'path-symlink-escape' })
    expect(lstatSync(join(home, 'proj', 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('outside\n')
  })

  it('除外の名前 (node_modules) への変更、除外の元、許可の外、存在しない元、型の違う値は断る', () => {
    expect(renameEntry(gate, uriOf('plain.txt'), 'node_modules')).toMatchObject({ uri: null })
    expect(existsSync(join(home, 'proj', 'plain.txt'))).toBe(true)
    expect(renameEntry(gate, uriOf('node_modules'), 'nm2')).toMatchObject({ uri: null })
    expect(existsSync(join(home, 'proj', 'node_modules'))).toBe(true)
    expect(renameEntry(gate, uriOf('nope.txt'), 'x.txt')).toEqual({ uri: null, reason: 'path-not-found' })
    expect(renameEntry(gate, 'relative/path', 'x')).toMatchObject({ uri: null })
    expect(renameEntry(gate, 'https://example.com/a', 'x')).toMatchObject({ uri: null })
    expect(renameEntry(gate, 42, 'x')).toMatchObject({ uri: null, reason: 'invalid-value' })
    expect(renameEntry(gate, uriOf('b.txt'), 42)).toMatchObject({ uri: null, reason: 'invalid-value' })
  })
})
