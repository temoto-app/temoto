/**
 * Item 253 / 258 (wave 15 bundle B): two pure functions for the two drop receivers.
 *
 * - `fileUriToPath`: a `file://` URI to an absolute path (undoes the % encoding; broken input gives null)
 * - `shellEscapePath`: the same `\ ` escaping as when dropped into macOS Terminal
 * - `pathsText`: several paths are separated by spaces; duplicates and URIs that cannot be turned back are dropped
 * - `insertPathsAtCursor`: insertion at the cursor position (how the surrounding spaces are filled in)
 *
 * Depends on neither the model nor electron. The DOM-based dispatch is in `test/pane-drop.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  fileUriToPath,
  insertPathsAtCursor,
  pathsText,
  shellEscapePath
} from '../src/renderer/src/drop-paths.js'

describe('fileUriToPath', () => {
  it('% 表記を戻す (空白・日本語・記号)', () => {
    expect(fileUriToPath('file:///Users/me/my%20file.png')).toBe('/Users/me/my file.png')
    expect(fileUriToPath('file:///Users/me/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt')).toBe('/Users/me/日本語.txt')
    expect(fileUriToPath("file:///a/it's%20(1)%20%26%20%22q%22.md")).toBe('/a/it\'s (1) & "q".md')
  })

  it('localhost は許し、他のホストと file: 以外は null', () => {
    expect(fileUriToPath('file://localhost/a/b')).toBe('/a/b')
    expect(fileUriToPath('file://server/a/b')).toBeNull()
    expect(fileUriToPath('https://example.com/a')).toBeNull()
    expect(fileUriToPath('thread://x')).toBeNull()
    expect(fileUriToPath('file:relative')).toBeNull()
    expect(fileUriToPath('file://')).toBeNull()
  })

  it('壊れた % 表記と NUL は null (例外を投げない)', () => {
    expect(fileUriToPath('file:///a/%E0%A4%A')).toBeNull()
    expect(fileUriToPath('file:///a/%00b')).toBeNull()
  })

  it('クエリとフラグメントは落とす', () => {
    expect(fileUriToPath('file:///a/b.txt?x=1#y')).toBe('/a/b.txt')
  })
})

describe('shellEscapePath (Terminal に落としたときの書き方)', () => {
  it('普通のパスはそのまま (日本語・~ = , + @ : % も逃がさない)', () => {
    expect(shellEscapePath('/Users/me/proj/a-b_c.d.png')).toBe('/Users/me/proj/a-b_c.d.png')
    expect(shellEscapePath('/Users/me/日本語/資料.md')).toBe('/Users/me/日本語/資料.md')
    expect(shellEscapePath('/a/b~c=d,e+f@g:h%i')).toBe('/a/b~c=d,e+f@g:h%i')
  })

  it('空白をバックスラッシュで逃がす', () => {
    expect(shellEscapePath('/Users/me/my file.png')).toBe('/Users/me/my\\ file.png')
    expect(shellEscapePath('/Users/me/日本語 の 資料.md')).toBe('/Users/me/日本語\\ の\\ 資料.md')
    expect(shellEscapePath('/a/b\tc')).toBe('/a/b\\\tc')
  })

  it("引用符・括弧・& ・ ; ・ | などを逃がす", () => {
    expect(shellEscapePath("/a/it's")).toBe("/a/it\\'s")
    expect(shellEscapePath('/a/say "hi"')).toBe('/a/say\\ \\"hi\\"')
    expect(shellEscapePath('/a/shot (1).png')).toBe('/a/shot\\ \\(1\\).png')
    expect(shellEscapePath('/a/a&b;c|d')).toBe('/a/a\\&b\\;c\\|d')
    expect(shellEscapePath('/a/$HOME `x` !y #z *?[]{}<>^')).toBe(
      '/a/\\$HOME\\ \\`x\\`\\ \\!y\\ \\#z\\ \\*\\?\\[\\]\\{\\}\\<\\>\\^'
    )
  })

  it('バックスラッシュ自身も逃がし、末尾の空白は残る (trim されない)', () => {
    expect(shellEscapePath('/a/b\\c')).toBe('/a/b\\\\c')
    expect(shellEscapePath('/a/b ')).toBe('/a/b\\ ')
  })

  it('シェルが読み戻すと元のパスになる (実物の /bin/sh に読ませる往復)', async () => {
    const { execFileSync } = await import('node:child_process')
    const paths = [
      '/Users/me/my file (1) & "q" \'s.png',
      '/a/日本語 の 資料 #1 $x `y` ;|<>*?[]{}!^.md',
      '/a/b\\c d'
    ]
    for (const path of paths) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellEscapePath(path)}`], {
        encoding: 'utf8'
      })
      expect(out).toBe(path)
    }
  })
})

describe('pathsText', () => {
  it('複数は空白 1 つで区切り、重複と戻せない URI は捨てる', () => {
    const text = pathsText([
      'file:///a/one%20two.png',
      'file:///b/3.txt',
      'file:///a/one%20two.png',
      'https://example.com/x',
      'file:///bad/%E0%A4%A'
    ])
    expect(text).toBe('/a/one\\ two.png /b/3.txt')
  })

  it('何も戻せなければ空文字', () => {
    expect(pathsText([])).toBe('')
    expect(pathsText(['thread://x'])).toBe('')
  })
})

describe('insertPathsAtCursor', () => {
  it('空の本文には、パスと末尾の空白 1 つ', () => {
    expect(insertPathsAtCursor('', 0, 0, '/a/b.png')).toEqual({ text: '/a/b.png ', caret: 9 })
  })

  it('本文の途中: 直前が空白以外なら前に、直後が空白以外なら後ろに空白を足す', () => {
    const r = insertPathsAtCursor('見てabc', 2, 2, '/a/b.png')
    expect(r.text).toBe('見て /a/b.png abc')
    expect(r.caret).toBe('見て /a/b.png '.length)
  })

  it('直前・直後が空白なら足さない', () => {
    expect(insertPathsAtCursor('see  end', 4, 4, '/a')).toEqual({ text: 'see /a end', caret: 6 })
  })

  it('選択範囲は置き換える (逆向きの選択も)', () => {
    expect(insertPathsAtCursor('x OLD y', 2, 5, '/p').text).toBe('x /p y')
    expect(insertPathsAtCursor('x OLD y', 5, 2, '/p').text).toBe('x /p y')
  })

  it('行頭 (改行の直後) では前に空白を足さない', () => {
    expect(insertPathsAtCursor('a\nb', 2, 2, '/p').text).toBe('a\n/p b')
  })

  it('範囲外・NaN は末尾に寄せる。空の text は何もしない', () => {
    expect(insertPathsAtCursor('ab', 99, 99, '/p').text).toBe('ab /p ')
    expect(insertPathsAtCursor('ab', Number.NaN, Number.NaN, '/p').text).toBe('ab /p ')
    expect(insertPathsAtCursor('ab', 1, 1, '')).toEqual({ text: 'ab', caret: 1 })
  })

  it('末尾が逃がした空白 (`\\ `) のパスも欠けない', () => {
    const r = insertPathsAtCursor('', 0, 0, shellEscapePath('/a/b '))
    expect(r.text).toBe('/a/b\\  ')
  })
})
