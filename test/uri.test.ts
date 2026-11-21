/** Unit tests for URI conversion. This is the boundary that keeps paths from leaking to the renderer. */
import { describe, expect, it } from 'vitest'
import { pathToUri, uriToPath, foldPath } from '../src/common/uri.js'
import {
  displayPath,
  resourceTokenOf,
  tokenResourceUrl,
  uriBasename,
  uriDirname,
  uriExtension
} from '../src/shared/uri.js'

describe('path ⇄ uri', () => {
  it('round-trips back to the same path', () => {
    for (const path of ['/Users/tester/a.txt', '/Users/tester/日本語 と 空白/x.md', '/a/b#c']) {
      expect(uriToPath(pathToUri(path))).toBe(path)
    }
  })

  it('rejects schemes other than file:', () => {
    expect(() => uriToPath('thread://abc/def')).toThrow()
    expect(() => uriToPath('aios-res:///etc/passwd')).toThrow()
  })

  it('folding ignores case', () => {
    expect(foldPath('/Users/Tester/Library')).toBe(foldPath('/users/tester/library'))
  })
})

describe('pure functions of shared/uri', () => {
  it('basename / dirname / extension', () => {
    const uri = pathToUri('/Users/tester/docs/report.MD')
    expect(uriBasename(uri)).toBe('report.MD')
    expect(uriExtension(uri)).toBe('md')
    expect(uriDirname(uri)).toBe(pathToUri('/Users/tester/docs'))
  })

  it('restores a percent-encoded name', () => {
    expect(uriBasename(pathToUri('/Users/tester/日本語 ファイル.txt'))).toBe('日本語 ファイル.txt')
  })

  it('a file without an extension gives an empty string', () => {
    expect(uriExtension(pathToUri('/Users/tester/Makefile'))).toBe('')
    expect(uriExtension(pathToUri('/Users/tester/.gitignore'))).toBe('')
  })

  it('a resource-scheme URL always has an authority and carries no path (A-4)', () => {
    // With an empty authority, Chromium reads the first path segment as the host and everything shifts by one level
    const token = '0123456789abcdef0123456789abcdef'
    const url = tokenResourceUrl(token, '日本語 と 空白.png')
    expect(url.startsWith(`aios-res://local/${token}/`)).toBe(true)
    expect(resourceTokenOf(url)).toBe(token)
  })

  it('a token cannot be taken from the old form (aios-res://local/<path> carrying a path) (the remainder of item 132)', () => {
    expect(resourceTokenOf('aios-res://local/Users/t/a.png')).toBeNull()
  })

  it('folds under home into ~', () => {
    const home = pathToUri('/Users/tester')
    expect(displayPath(pathToUri('/Users/tester/docs/a.txt'), home)).toBe('~/docs/a.txt')
    expect(displayPath(home, home)).toBe('~')
    expect(displayPath(pathToUri('/opt/x'), home)).toBe('/opt/x')
  })
})
