/**
 * Judgment for scratch areas (T19 / TODO 24, ARCHITECTURE.md 4.3.2).
 *
 * `SessionManager.remove` deletes the cwd with its contents only when `isScratchCwd` is true.
 * What is pinned here is **no false hits**: the root itself, two levels down, a name that merely matches by prefix,
 * and another thread's scratch area must never be true.
 */
import { describe, expect, it } from 'vitest'
import {
  isScratchCwd,
  isScratchDirName,
  scratchCwd,
  scratchRoot,
  sweepableScratchDirs
} from '../src/main/session/scratch.js'

const HOME = '/Users/tester'
const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

describe('scratch — 場所 (T19)', () => {
  it('根は ~/aios/scratch、スレッドの捨て場はその直下の <threadId>', () => {
    expect(scratchRoot(HOME)).toBe('/Users/tester/aios/scratch')
    expect(scratchCwd(HOME, ID)).toBe(`/Users/tester/aios/scratch/${ID}`)
  })

  it('~/Library 配下ではない (除外規則に当たると自分の捨て場を開けない)', () => {
    expect(scratchRoot(HOME).startsWith('/Users/tester/Library')).toBe(false)
  })
})

describe('scratch — 消してよいのは直下 1 段・スレッド id と同名だけ', () => {
  it('自分の捨て場は真 (末尾の / と大文字小文字の違いは無視)', () => {
    expect(isScratchCwd(HOME, scratchCwd(HOME, ID), ID)).toBe(true)
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/`, ID)).toBe(true)
    expect(isScratchCwd(HOME, scratchCwd(HOME, ID).toUpperCase(), ID)).toBe(true)
    expect(isScratchCwd(`${HOME}/`, scratchCwd(HOME, ID), ID)).toBe(true)
  })

  it('根そのもの・ホーム・根の親は偽', () => {
    expect(isScratchCwd(HOME, scratchRoot(HOME), ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/`, ID)).toBe(false)
    expect(isScratchCwd(HOME, HOME, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios`, ID)).toBe(false)
    expect(isScratchCwd(HOME, '/', ID)).toBe(false)
  })

  it('2 段以上下は偽', () => {
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/sub`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchCwd(HOME, ID)}/a/b`, ID)).toBe(false)
  })

  it('前方一致だけの別名は偽 (~/aios/scratchy, ~/aios/scratch-old)', () => {
    expect(isScratchCwd(HOME, `${HOME}/aios/scratchy/${ID}`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios/scratch-old/${ID}`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${HOME}/aios/scratch${ID}`, ID)).toBe(false)
  })

  it('他スレッドの捨て場は偽 (「他のフォルダを選ぶ…」で選んだ cwd を巻き込まない)', () => {
    const other = 'ffffffff-0000-1111-2222-333333333333'
    expect(isScratchCwd(HOME, scratchCwd(HOME, other), ID)).toBe(false)
  })

  it('.. で根の外を指すパスは偽 (resolve してから比べる)', () => {
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/${ID}/../..`, ID)).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/../scratch/${ID}`, ID)).toBe(true)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/../../Documents`, ID)).toBe(false)
  })

  it('壊れた threadId (空 / . / .. / 区切りを含む) は偽', () => {
    expect(isScratchCwd(HOME, scratchRoot(HOME), '')).toBe(false)
    expect(isScratchCwd(HOME, scratchRoot(HOME), '.')).toBe(false)
    expect(isScratchCwd(HOME, HOME, '..')).toBe(false)
    expect(isScratchCwd(HOME, `${scratchRoot(HOME)}/a/b`, 'a/b')).toBe(false)
  })

  it('別のホームの捨て場は偽', () => {
    expect(isScratchCwd(HOME, scratchCwd('/Users/other', ID), ID)).toBe(false)
  })
})

describe('scratch — 掃いてよいものの一覧 (T23 / TODO 32)', () => {
  const dir = (name: string, isEmpty = true): { name: string; isDirectory: boolean; isEmpty: boolean } => ({
    name,
    isDirectory: true,
    isEmpty
  })
  const OTHER = 'ffffffff-0000-1111-2222-333333333333'

  it('名前が UUID の形のものだけを捨て場と見なす (人が置いたディレクトリを消さない)', () => {
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

  it('空・UUID・どのスレッドの id でもない、の 3 つが揃ったものだけ掃く', () => {
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

  it('生存スレッドが別の id なら掃く / 一覧は入力の順に返る', () => {
    expect(sweepableScratchDirs([dir(ID), dir(OTHER)], [OTHER])).toEqual([ID])
    expect(sweepableScratchDirs([dir(OTHER), dir(ID)], [])).toEqual([OTHER, ID])
  })

  it('空の入力・空の一覧でも落ちない', () => {
    expect(sweepableScratchDirs([], [ID])).toEqual([])
    expect(sweepableScratchDirs([], [])).toEqual([])
  })
})
