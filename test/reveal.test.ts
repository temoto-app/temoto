/**
 * Ancestor calculation for opening the tree down to cwd (item 49). It is a pure renderer function, so no DOM is needed.
 */
import { describe, expect, it } from 'vitest'
import { revealChain } from '../src/renderer/src/reveal.js'

const HOME = 'file:///Users/alice'

describe('revealChain', () => {
  it('root から目的の URI まで、上から順に並べる', () => {
    expect(revealChain([HOME], 'file:///Users/alice/git/obj2c')).toEqual([
      HOME,
      'file:///Users/alice/git',
      'file:///Users/alice/git/obj2c'
    ])
  })

  it('root 自身なら root 1 つ', () => {
    expect(revealChain([HOME], HOME)).toEqual([HOME])
    expect(revealChain([HOME], `${HOME}/`)).toEqual([HOME])
  })

  it('末尾のスラッシュ (捨て場の形) を無視する', () => {
    expect(revealChain([HOME], 'file:///Users/alice/aios/scratch/abc-1/')).toEqual([
      HOME,
      'file:///Users/alice/aios',
      'file:///Users/alice/aios/scratch',
      'file:///Users/alice/aios/scratch/abc-1'
    ])
  })

  it('どの root の配下でもなければ null', () => {
    expect(revealChain([HOME], 'file:///Volumes/Data/x')).toBeNull()
    expect(revealChain([], HOME)).toBeNull()
    // False match on a prefix: `/Users/alice2` is not under `/Users/alice`
    expect(revealChain([HOME], 'file:///Users/alice2/x')).toBeNull()
  })

  it('複数の root では最長一致を選ぶ (`/` と `~` の両方にあるならホームの木)', () => {
    expect(revealChain(['file:///', HOME], 'file:///Users/alice/git')).toEqual([
      HOME,
      'file:///Users/alice/git'
    ])
    expect(revealChain([HOME, 'file:///'], 'file:///Users/alice/git')?.[0]).toBe(HOME)
  })

  it('ルート `file:///` の配下も扱える', () => {
    expect(revealChain(['file:///'], 'file:///usr/local/bin')).toEqual([
      'file:///',
      'file:///usr',
      'file:///usr/local',
      'file:///usr/local/bin'
    ])
    expect(revealChain(['file:///'], 'file:///')).toEqual(['file:///'])
  })

  it('許可ボリューム (root がホーム外) の配下', () => {
    expect(revealChain([HOME, 'file:///Volumes/Data'], 'file:///Volumes/Data/a/b')).toEqual([
      'file:///Volumes/Data',
      'file:///Volumes/Data/a',
      'file:///Volumes/Data/a/b'
    ])
  })

  it('パーセント符号化はそのまま持ち回る (renderer は復号しない)', () => {
    expect(revealChain([HOME], 'file:///Users/alice/My%20Docs/%E8%B3%87%E6%96%99')).toEqual([
      HOME,
      'file:///Users/alice/My%20Docs',
      'file:///Users/alice/My%20Docs/%E8%B3%87%E6%96%99'
    ])
  })

  it('空の区切り (`a//b`) は壊れた URI として null', () => {
    expect(revealChain([HOME], 'file:///Users/alice/a//b')).toBeNull()
  })
})
