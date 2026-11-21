/**
 * TODO 370 (wave 20 bundle C): the main entry point for creating a new file or folder from the Files tree.
 *
 * - Checking the name (`checkNewEntryName`, a pure function shared by the renderer and main)
 * - `createEntry` in a **real temporary directory**: creating, intermediate folders, names that already exist, escapes (`..` / absolute path / NUL), symlinks (a symlink inside the parent points outside / an intermediate element is a symlink), exclusions (`node_modules` / `~/.ssh`)
 * - `createEntryGuarded`: after creating, asks the index process for `noteCreated`, and returns the creation result even if the index has crashed
 *
 * The temp folder is under `~/.aios-test` (macOS's `os.tmpdir()` hits the exclusion). Calls neither the model nor Electron.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { FsAccess } from '../src/main/fs/access.js'
import { createEntry } from '../src/main/fs/create.js'
import { createEntryGuarded } from '../src/main/ipc/handlers.js'
import { checkNewEntryName } from '../src/shared/new-entry.js'
import { pathToUri } from '../src/common/uri.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

describe('checkNewEntryName (TODO 370)', () => {
  it('ordinary names, and intermediate folders separated by /', () => {
    expect(checkNewEntryName('a.txt', 'file')).toEqual({ ok: true, segments: ['a.txt'] })
    expect(checkNewEntryName('  a/b/c.txt  ', 'file')).toEqual({ ok: true, segments: ['a', 'b', 'c.txt'] })
    expect(checkNewEntryName('.env', 'file')).toEqual({ ok: true, segments: ['.env'] })
    expect(checkNewEntryName('日本語 フォルダ', 'folder')).toEqual({ ok: true, segments: ['日本語 フォルダ'] })
  })

  it('a folder allows a trailing /, and a trailing / on a file is an empty segment', () => {
    expect(checkNewEntryName('dir/', 'folder')).toEqual({ ok: true, segments: ['dir'] })
    expect(checkNewEntryName('dir/', 'file')).toMatchObject({ ok: false, code: 'create-name-segment' })
  })

  it('rejects empty, absolute paths, control characters (NUL), empty segments, . / .., and names that are too long', () => {
    expect(checkNewEntryName('   ', 'file')).toMatchObject({ ok: false, code: 'create-name-empty' })
    expect(checkNewEntryName('/etc/passwd', 'file')).toMatchObject({ ok: false, code: 'create-name-absolute' })
    expect(checkNewEntryName('a\u0000b', 'file')).toEqual({
      ok: false,
      code: 'create-name-invalid-char',
      params: { char: 'U+0000' }
    })
    expect(checkNewEntryName('a\nb', 'folder')).toMatchObject({ ok: false, code: 'create-name-invalid-char' })
    expect(checkNewEntryName('a//b', 'file')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkNewEntryName('..', 'folder')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkNewEntryName('a/../../x', 'file')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkNewEntryName('./x', 'file')).toMatchObject({ ok: false, code: 'create-name-segment' })
    expect(checkNewEntryName('あ'.repeat(86), 'file')).toMatchObject({ ok: false, code: 'create-name-too-long' })
    expect(checkNewEntryName('あ'.repeat(85), 'file')).toMatchObject({ ok: true })
  })
})

describe('createEntry: real temporary directory (TODO 370)', () => {
  let home: string
  let outside: string
  let gate: FsAccess

  beforeAll(() => {
    home = makeTestDir('fs-create')
    outside = makeTestDir('fs-create-outside')
    gate = new FsAccess(home, [home])
    mkdirSync(join(home, 'proj'))
    writeFileSync(join(home, 'proj', 'exists.txt'), 'keep me\n')
    mkdirSync(join(home, 'proj', 'node_modules'))
    mkdirSync(join(home, '.ssh'))
    // A symlink placed inside the parent that points outside.
    symlinkSync(outside, join(home, 'proj', 'escape'))
    // A file symlink pointing outside (checks O_NOFOLLOW and that it already exists).
    writeFileSync(join(outside, 'target.txt'), 'outside\n')
    symlinkSync(join(outside, 'target.txt'), join(home, 'proj', 'link.txt'))
  })

  afterAll(() => {
    removeTestDir(home)
    removeTestDir(outside)
  })

  const proj = (): string => pathToUri(join(home, 'proj'))

  it('creates an empty file, the URI is the logical path, and returns the created path', () => {
    const result = createEntry(gate, 'file', proj(), 'new.txt')
    expect(result.reason).toBeNull()
    expect(result.uri).toBe(pathToUri(join(home, 'proj', 'new.txt')))
    expect(result.created).toEqual([join(home, 'proj', 'new.txt')])
    expect(readFileSync(join(home, 'proj', 'new.txt'), 'utf8')).toBe('')
  })

  it('creates a folder', () => {
    const result = createEntry(gate, 'folder', proj(), 'newdir')
    expect(result.reason).toBeNull()
    expect(lstatSync(join(home, 'proj', 'newdir')).isDirectory()).toBe(true)
  })

  it('a/b/c.txt also creates the intermediate folders; existing intermediate folders are reused as they are', () => {
    const result = createEntry(gate, 'file', proj(), 'deep/er/c.txt')
    expect(result.reason).toBeNull()
    expect(result.created).toEqual([
      join(home, 'proj', 'deep'),
      join(home, 'proj', 'deep', 'er'),
      join(home, 'proj', 'deep', 'er', 'c.txt')
    ])
    const again = createEntry(gate, 'file', proj(), 'deep/er/d.txt')
    expect(again.reason).toBeNull()
    expect(again.created).toEqual([join(home, 'proj', 'deep', 'er', 'd.txt')])
  })

  it('an existing name is refused with create-exists and its contents are left untouched (both files and folders)', () => {
    expect(createEntry(gate, 'file', proj(), 'exists.txt')).toMatchObject({
      uri: null,
      reason: 'create-exists',
      params: { name: 'exists.txt' }
    })
    expect(readFileSync(join(home, 'proj', 'exists.txt'), 'utf8')).toBe('keep me\n')
    expect(createEntry(gate, 'folder', proj(), 'newdir').reason).toBe('create-exists')
    expect(createEntry(gate, 'folder', proj(), 'exists.txt').reason).toBe('create-exists')
  })

  it('if an intermediate element is a file it fails with create-not-directory and no intermediate folder is left behind', () => {
    const result = createEntry(gate, 'file', proj(), 'exists.txt/x.txt')
    expect(result).toMatchObject({ reason: 'create-not-directory', params: { name: 'exists.txt' } })
  })

  it('when the last name already exists it is refused before creating intermediate folders (no garbage left)', () => {
    const before = readdirSync(join(home, 'proj')).sort()
    expect(createEntry(gate, 'file', proj(), 'deep/er/c.txt').reason).toBe('create-exists')
    expect(readdirSync(join(home, 'proj')).sort()).toEqual(before)
  })

  it('.. / absolute paths / NUL cannot escape the parent (the check is in main; the renderer is not trusted)', () => {
    expect(createEntry(gate, 'file', proj(), '../escaped.txt').reason).toBe('create-name-segment')
    expect(createEntry(gate, 'file', proj(), `${outside}/abs.txt`).reason).toBe('create-name-absolute')
    expect(createEntry(gate, 'file', proj(), 'nul\u0000.txt').reason).toBe('create-name-invalid-char')
    expect(existsSync(join(home, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(outside, 'abs.txt'))).toBe(false)
  })

  it("a value of the wrong type is invalid-value (the renderer's value is not trusted)", () => {
    expect(createEntry(gate, 'file', 42, 'a.txt')).toMatchObject({ reason: 'invalid-value', params: { field: 'parentUri' } })
    expect(createEntry(gate, 'file', proj(), null)).toMatchObject({ reason: 'invalid-value', params: { field: 'name' } })
    expect(createEntry(gate, 'file', 'https://example.com/', 'a.txt').reason).toBe('path-invalid-uri')
  })

  it('if a symlink inside the parent points outside, nothing is created in it (whether passed as the parent or as an intermediate element)', () => {
    const viaSegment = createEntry(gate, 'file', proj(), 'escape/x.txt')
    expect(viaSegment.reason).toBe('path-symlink-escape')
    expect(createEntry(gate, 'file', pathToUri(join(home, 'proj', 'escape')), 'y.txt').reason).not.toBeNull()
    expect(existsSync(join(outside, 'y.txt'))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('if the last name is a symlink, it is neither overwritten nor created at the link target', () => {
    // A symlink pointing outside is refused either by the choke point's canonical re-check or by the preliminary "already exists" check. Either way nothing is created.
    expect(createEntry(gate, 'file', proj(), 'link.txt').reason).not.toBeNull()
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('outside\n')
    // Even a symlink pointing inside (it passes the choke point) is refused as an existing name, and the link target is not touched.
    writeFileSync(join(home, 'proj', 'real.txt'), 'real\n')
    symlinkSync(join(home, 'proj', 'real.txt'), join(home, 'proj', 'inner-link.txt'))
    expect(createEntry(gate, 'file', proj(), 'inner-link.txt').reason).toBe('create-exists')
    expect(readFileSync(join(home, 'proj', 'real.txt'), 'utf8')).toBe('real\n')
  })

  it('an intermediate symlink is not followed even when it points inside: path-symlink-escape', () => {
    mkdirSync(join(home, 'other'))
    symlinkSync(join(home, 'other'), join(home, 'proj', 'inner-dir'))
    expect(createEntry(gate, 'file', proj(), 'inner-dir/x.txt').reason).toBe('path-symlink-escape')
    expect(existsSync(join(home, 'other', 'x.txt'))).toBe(false)
  })

  it('names inside excluded folders (node_modules, ~/.ssh) and names that would be excluded are refused', () => {
    expect(createEntry(gate, 'file', proj(), 'node_modules/x.js').reason).toBe('path-excluded')
    expect(createEntry(gate, 'file', pathToUri(join(home, 'proj', 'node_modules')), 'x.js').reason).toBe(
      'path-excluded'
    )
    expect(createEntry(gate, 'folder', proj(), 'sub/node_modules').reason).toBe('path-excluded')
    expect(existsSync(join(home, 'proj', 'sub'))).toBe(false)
    expect(createEntry(gate, 'file', pathToUri(join(home, '.ssh')), 'config').reason).toBe('path-excluded')
  })

  it('refuses when the parent is missing or is a file', () => {
    expect(createEntry(gate, 'file', pathToUri(join(home, 'nope')), 'a.txt').reason).toBe('path-not-found')
    expect(createEntry(gate, 'file', pathToUri(join(home, 'proj', 'exists.txt')), 'a.txt').reason).toBe(
      'create-not-directory'
    )
  })

  it('createEntryGuarded: when created, calls noteCreated (URI) on the index; when refused, does not ask', async () => {
    const index = { noteCreated: vi.fn(async () => undefined) }
    const ok = await createEntryGuarded(gate, index, 'folder', proj(), 'g1/g2')
    expect(ok).toEqual({ uri: pathToUri(join(home, 'proj', 'g1', 'g2')), reason: null })
    expect(index.noteCreated).toHaveBeenCalledWith([
      pathToUri(join(home, 'proj', 'g1')),
      pathToUri(join(home, 'proj', 'g1', 'g2'))
    ])
    index.noteCreated.mockClear()
    const ng = await createEntryGuarded(gate, index, 'folder', proj(), 'g1/g2')
    expect(ng.reason).toBe('create-exists')
    expect(index.noteCreated).not.toHaveBeenCalled()
  })

  it('createEntryGuarded: returns the created result even if the index is down (does not throw)', async () => {
    const index = {
      noteCreated: vi.fn(async () => {
        throw new Error('aios-reason:index-restarting')
      })
    }
    const result = await createEntryGuarded(gate, index, 'file', proj(), 'while-down.txt')
    expect(result.reason).toBeNull()
    expect(existsSync(join(home, 'proj', 'while-down.txt'))).toBe(true)
  })
})
