/**
 * Item 239: `cwdMatchKey` (the key that treats folders as the same via real path + folding).
 *
 * As measured in 233, the `cwd` in a CLI transcript is recorded as the real path, but the folder chosen in the create dialog can be spelled through a symlink
 * (on macOS `/tmp` / `/var` / `/etc` are symlinks). `cwdMatchKey` runs `realpath` on both and then folds (case + NFC), so even with different spellings
 * the same folder gives the same key. The temp directory is made under home (`tmpdir()` falls under the exclusion rules;
 * see the section in CLAUDE.md "macOS `os.tmpdir()` …").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { cwdMatchKey } from '../src/main/session/cwd-match.js'
import { foldPath } from '../src/common/uri.js'
import { makeTestDir } from './helpers/tmp.js'

let root: string

beforeEach(() => {
  root = realpathSync(makeTestDir('cwd-match-test'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('cwdMatchKey (item 239)', () => {
  it('an existing folder becomes a realpath + folded value', async () => {
    const dir = join(root, 'proj')
    mkdirSync(dir)
    expect(await cwdMatchKey(dir)).toBe(foldPath(realpathSync(dir)))
  })

  it('a spelling through a symlink gets the same key as a spelling that points at the target directly', async () => {
    const real = join(root, 'real-proj')
    mkdirSync(real)
    const link = join(root, 'via-link')
    symlinkSync(real, link)
    const direct = await cwdMatchKey(real)
    const viaSymlink = await cwdMatchKey(link)
    expect(viaSymlink).toBe(direct)
  })

  it('spellings that differ only in case get the same key (APFS does not distinguish case by default)', async () => {
    const dir = join(root, 'CaseProj')
    mkdirSync(dir)
    const lower = dir.replace('CaseProj', 'caseproj')
    // On APFS (the default), which does not distinguish case, a different spelling still points to the same real file.
    const upper = await cwdMatchKey(dir)
    const other = await cwdMatchKey(lower)
    expect(other).toBe(upper)
  })

  it('a nonexistent path gives up realpath and folds the given spelling as is (does not throw)', async () => {
    const missing = join(root, 'does-not-exist')
    expect(await cwdMatchKey(missing)).toBe(foldPath(missing))
  })
})
