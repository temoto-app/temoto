/**
 * Judgment for scratch areas (T19 / TODO 24, ARCHITECTURE.md 4.3.2).
 *
 * `SessionManager.remove` deletes the cwd with its contents only when `isScratchCwd` is true.
 * What is pinned here is **no false hits**: the root itself, two levels down, a name that merely matches by prefix,
 * and another thread's scratch area must never be true.
 */
import { describe, expect, it } from 'vitest'
import {
  isOwnScratchCwd,
  isScratchChild,
  isScratchCwd,
  isScratchDirName,
  scratchCwd,
  scratchRoot,
  sweepableScratchDirs
} from '../src/main/session/scratch.js'

const HOME = '/Users/tester'
const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

describe('scratch - location (T19)', () => {
  it("the root is ~/aios/scratch and a thread's scratch area is the <threadId> directly under it", () => {
    expect(scratchRoot(HOME)).toBe('/Users/tester/aios/scratch')
    expect(scratchCwd(HOME, ID)).toBe(`/Users/tester/aios/scratch/${ID}`)
  })

  it('is not under ~/Library (an exclusion rule hit would make its own scratch area unopenable)', () => {
    expect(scratchRoot(HOME).startsWith('/Users/tester/Library')).toBe(false)
  })
})

describe('scratch - only a direct child, one level down, named like the thread id may be deleted', () => {
  it("a thread's own scratch area is true (a trailing / and case differences are ignored)", () => {
    expect(isScratchCwd(HOME, scratchCwd(HOME, ID), ID)).toBe(true)
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/`, ID)).toBe(true)
    expect(isScratchCwd(HOME, scratchCwd(HOME, ID).toUpperCase(), ID)).toBe(true)
    expect(isScratchCwd(`${HOME}/`, scratchCwd(HOME, ID), ID)).toBe(true)
  })

  it("the root itself, home and the root's parent are false", () => {
    expect(isScratchCwd(HOME, scratchRoot(HOME), ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/`, ID)).toBe(false)
    expect(isScratchCwd(HOME, HOME, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios`, ID)).toBe(false)
    expect(isScratchCwd(HOME, '/', ID)).toBe(false)
  })

  it('two or more levels down is false', () => {
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/sub`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/a/b`, ID)).toBe(false)
  })

  it('aliases that only share a prefix are false (~/aios/scratchy, ~/aios/scratch-old)', () => {
    expect(isScratchCwd(HOME, `${HOME}/aios/scratchy/${ID}`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios/scratch-old/${ID}`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios/scratch${ID}`, ID)).toBe(false)
  })

  it("another thread's scratch area is false (does not catch a cwd chosen via 「他のフォルダを選ぶ…」)", () => {
    const other = 'ffffffff-0000-1111-2222-333333333333'
    expect(isScratchCwd(HOME, scratchCwd(HOME, other), ID)).toBe(false)
  })

  it('a path with .. pointing outside the root is false (compared after resolve)', () => {
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/${ID}/../..`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/../scratch/${ID}`, ID)).toBe(true)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/../../Documents`, ID)).toBe(false)
  })

  it('a broken threadId (empty / . / .. / containing a separator) is false', () => {
    expect(isScratchCwd(HOME, scratchRoot(HOME), '')).toBe(false)
    expect(isScratchCwd(HOME, scratchRoot(HOME), '.')).toBe(false)
    expect(isScratchCwd(HOME, HOME, '..')).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/a/b`, 'a/b')).toBe(false)
  })

  it("another home's scratch area is false", () => {
    expect(isScratchCwd(HOME, scratchCwd('/Users/other', ID), ID)).toBe(false)
  })
})

describe('scratch - list of what may be swept (T23 / TODO 32)', () => {
  const dir = (name: string, isEmpty = true): { name: string; isDirectory: boolean; isEmpty: boolean } => ({
    name,
    isDirectory: true,
    isEmpty
  })
  const OTHER = 'ffffffff-0000-1111-2222-333333333333'

  it('treats only UUID-shaped names as scratch areas (does not delete directories a person placed)', () => {
    expect(isScratchDirName(ID)).toBe(true)
    expect(isScratchDirName(ID.toUpperCase())).toBe(true)
    expect(isScratchDirName('メモ')).toBe(false)
    expect(isScratchDirName('tmp')).toBe(false)
    expect(isScratchDirName('')).toBe(false)
    // Near misses: wrong digit count / extra digit / not hex / something before or after
    expect(isScratchDirName(ID.slice(0, -1))).toBe(false)
    expect(isScratchDirName(`${ID}0`)).toBe(false)
    expect(isScratchDirName(ID.replace('a', 'z'))).toBe(false)
    expect(isScratchDirName(`x-${ID}`)).toBe(false)
    expect(isScratchDirName(`${ID}.old`)).toBe(false)
    expect(isScratchDirName(ID.replace(/-/g, ''))).toBe(false)
  })

  it('sweeps only what is empty, a UUID and not the id of any thread, all three together', () => {
    expect(sweepableScratchDirs([dir(ID)], [])).toEqual([ID])
    // Has contents = do not touch
    expect(sweepableScratchDirs([dir(ID, false)], [])).toEqual([])
    // A live thread's scratch area = do not touch (case differences count as the same).
    expect(sweepableScratchDirs([dir(ID)], [ID])).toEqual([])
    expect(sweepableScratchDirs([dir(ID.toUpperCase())], [ID])).toEqual([])
    expect(sweepableScratchDirs([dir(ID)], [ID.toUpperCase()])).toEqual([])
    // A name that is not a UUID = do not touch
    expect(sweepableScratchDirs([dir('メモ')], [])).toEqual([])
    // Not a directory (file / symlink) = do not touch
    expect(sweepableScratchDirs([{ name: ID, isDirectory: false, isEmpty: true }], [])).toEqual([])
  })

  it('sweeps when the live thread has a different id / the list comes back in input order', () => {
    expect(sweepableScratchDirs([dir(ID), dir(OTHER)], [OTHER])).toEqual([ID])
    expect(sweepableScratchDirs([dir(OTHER), dir(ID)], [])).toEqual([OTHER, ID])
  })

  it('does not fail on empty input or an empty list', () => {
    expect(sweepableScratchDirs([], [ID])).toEqual([])
    expect(sweepableScratchDirs([], [])).toEqual([])
  })
})

describe('a profile with its own scratch root (TODO 1314)', () => {
  const OWN = '/tmp/userdata/scratch'

  it('new areas go under the own root; without one under the shared root', () => {
    expect(scratchCwd(HOME, ID, OWN)).toBe(`${OWN}/${ID}`)
    expect(scratchCwd(HOME, ID)).toBe(`/Users/tester/aios/scratch/${ID}`)
  })

  it('both roots count as scratch for display and protection', () => {
    expect(isScratchChild(HOME, `${OWN}/${ID}`, OWN)).toBe(true)
    expect(isScratchChild(HOME, scratchCwd(HOME, ID), OWN)).toBe(true)
    expect(isScratchChild(HOME, `${OWN}/${ID}`)).toBe(false)
    expect(isScratchCwd(HOME, `${OWN}/${ID}`, ID, OWN)).toBe(true)
    expect(isScratchCwd(HOME, scratchCwd(HOME, ID), ID, OWN)).toBe(true)
  })

  it('only the own root may be deleted from', () => {
    expect(isOwnScratchCwd(HOME, `${OWN}/${ID}`, ID, OWN)).toBe(true)
    expect(isOwnScratchCwd(HOME, scratchCwd(HOME, ID), ID, OWN)).toBe(false)
    expect(isOwnScratchCwd(HOME, scratchCwd(HOME, ID), ID)).toBe(true)
    expect(isOwnScratchCwd(HOME, `${OWN}/${ID}`, ID)).toBe(false)
    expect(isOwnScratchCwd(HOME, OWN, ID, OWN)).toBe(false)
  })
})
