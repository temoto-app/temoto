/**
 * Ancestor calculation for opening the tree down to cwd (item 49). It is a pure renderer function, so no DOM is needed.
 */
import { describe, expect, it } from 'vitest'
import { revealChain } from '../src/renderer/src/reveal.js'

const HOME = 'file:///Users/alice'

describe('revealChain', () => {
  it('orders from root to the target URI, from the top', () => {
    expect(revealChain([HOME], 'file:///Users/alice/git/obj2c')).toEqual([
      HOME,
      'file:///Users/alice/git',
      'file:///Users/alice/git/obj2c'
    ])
  })

  it('for the root itself, just that one root', () => {
    expect(revealChain([HOME], HOME)).toEqual([HOME])
    expect(revealChain([HOME], `${HOME}/`)).toEqual([HOME])
  })

  it('ignores a trailing slash (the form of the scratch area)', () => {
    expect(revealChain([HOME], 'file:///Users/alice/aios/scratch/abc-1/')).toEqual([
      HOME,
      'file:///Users/alice/aios',
      'file:///Users/alice/aios/scratch',
      'file:///Users/alice/aios/scratch/abc-1'
    ])
  })

  it('null if it is under no root', () => {
    expect(revealChain([HOME], 'file:///Volumes/Data/x')).toBeNull()
    expect(revealChain([], HOME)).toBeNull()
    // False match on a prefix: `/Users/alice2` is not under `/Users/alice`
    expect(revealChain([HOME], 'file:///Users/alice2/x')).toBeNull()
  })

  it('with multiple roots it picks the longest match (if under both `/` and `~`, the home tree)', () => {
    expect(revealChain(['file:///', HOME], 'file:///Users/alice/git')).toEqual([
      HOME,
      'file:///Users/alice/git'
    ])
    expect(revealChain([HOME, 'file:///'], 'file:///Users/alice/git')?.[0]).toBe(HOME)
  })

  it('can also handle paths under the root `file:///`', () => {
    expect(revealChain(['file:///'], 'file:///usr/local/bin')).toEqual([
      'file:///',
      'file:///usr',
      'file:///usr/local',
      'file:///usr/local/bin'
    ])
    expect(revealChain(['file:///'], 'file:///')).toEqual(['file:///'])
  })

  it('under an allowed volume (a root outside home)', () => {
    expect(revealChain([HOME, 'file:///Volumes/Data'], 'file:///Volumes/Data/a/b')).toEqual([
      'file:///Volumes/Data',
      'file:///Volumes/Data/a',
      'file:///Volumes/Data/a/b'
    ])
  })

  it('percent-encoding is carried along as is (the renderer does not decode)', () => {
    expect(revealChain([HOME], 'file:///Users/alice/My%20Docs/%E8%B3%87%E6%96%99')).toEqual([
      HOME,
      'file:///Users/alice/My%20Docs',
      'file:///Users/alice/My%20Docs/%E8%B3%87%E6%96%99'
    ])
  })

  it('an empty separator (`a//b`) is null as a broken URI', () => {
    expect(revealChain([HOME], 'file:///Users/alice/a//b')).toBeNull()
  })
})
