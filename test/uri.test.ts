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
  it('往復して同じパスに戻る', () => {
    for (const path of ['/Users/tester/a.txt', '/Users/tester/日本語 と 空白/x.md', '/a/b#c']) {
      expect(uriToPath(pathToUri(path))).toBe(path)
    }
  })

  it('file: 以外のスキームを拒否する', () => {
    expect(() => uriToPath('thread://abc/def')).toThrow()
    expect(() => uriToPath('aios-res:///etc/passwd')).toThrow()
  })

  it('畳み込みは大文字小文字を無視する', () => {
    expect(foldPath('/Users/Tester/Library')).toBe(foldPath('/users/tester/library'))
  })
})

describe('shared/uri の純粋関数', () => {
  it('basename / dirname / extension', () => {
    const uri = pathToUri('/Users/tester/docs/report.MD')
    expect(uriBasename(uri)).toBe('report.MD')
    expect(uriExtension(uri)).toBe('md')
    expect(uriDirname(uri)).toBe(pathToUri('/Users/tester/docs'))
  })

  it('パーセントエンコードされた名前を戻す', () => {
    expect(uriBasename(pathToUri('/Users/tester/日本語 ファイル.txt'))).toBe('日本語 ファイル.txt')
  })

  it('拡張子の無いファイルは空文字', () => {
    expect(uriExtension(pathToUri('/Users/tester/Makefile'))).toBe('')
    expect(uriExtension(pathToUri('/Users/tester/.gitignore'))).toBe('')
  })

  it('resource スキームの URL は authority を必ず置き、パスを載せない (A-4)', () => {
    // With an empty authority, Chromium reads the first path segment as the host and everything shifts by one level
    const token = '0123456789abcdef0123456789abcdef'
    const url = tokenResourceUrl(token, '日本語 と 空白.png')
    expect(url.startsWith(`aios-res://local/${token}/`)).toBe(true)
    expect(resourceTokenOf(url)).toBe(token)
  })

  it('旧形式 (パスを載せた aios-res://local/<path>) からはトークンが取れない (項目 132 の残り)', () => {
    expect(resourceTokenOf('aios-res://local/Users/t/a.png')).toBeNull()
  })

  it('ホーム配下を ~ に畳む', () => {
    const home = pathToUri('/Users/tester')
    expect(displayPath(pathToUri('/Users/tester/docs/a.txt'), home)).toBe('~/docs/a.txt')
    expect(displayPath(home, home)).toBe('~')
    expect(displayPath(pathToUri('/opt/x'), home)).toBe('/opt/x')
  })
})
