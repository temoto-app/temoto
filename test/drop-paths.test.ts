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
  it('restores % notation (whitespace, Japanese, symbols)', () => {
    expect(fileUriToPath('file:///Users/me/my%20file.png')).toBe('/Users/me/my file.png')
    expect(fileUriToPath('file:///Users/me/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt')).toBe('/Users/me/日本語.txt')
    expect(fileUriToPath("file:///a/it's%20(1)%20%26%20%22q%22.md")).toBe('/a/it\'s (1) & "q".md')
  })

  it('allows localhost, and null for other hosts and anything other than file:', () => {
    expect(fileUriToPath('file://localhost/a/b')).toBe('/a/b')
    expect(fileUriToPath('file://server/a/b')).toBeNull()
    expect(fileUriToPath('https://example.com/a')).toBeNull()
    expect(fileUriToPath('thread://x')).toBeNull()
    expect(fileUriToPath('file:relative')).toBeNull()
    expect(fileUriToPath('file://')).toBeNull()
  })

  it('a broken % notation and NUL give null (no exception thrown)', () => {
    expect(fileUriToPath('file:///a/%E0%A4%A')).toBeNull()
    expect(fileUriToPath('file:///a/%00b')).toBeNull()
  })

  it('drops the query and fragment', () => {
    expect(fileUriToPath('file:///a/b.txt?x=1#y')).toBe('/a/b.txt')
  })
})

describe('shellEscapePath (how to write it when dropped on the Terminal)', () => {
  it('a normal path as is (Japanese, ~ = , + @ : % are not escaped either)', () => {
    expect(shellEscapePath('/Users/me/proj/a-b_c.d.png')).toBe('/Users/me/proj/a-b_c.d.png')
    expect(shellEscapePath('/Users/me/日本語/資料.md')).toBe('/Users/me/日本語/資料.md')
    expect(shellEscapePath('/a/b~c=d,e+f@g:h%i')).toBe('/a/b~c=d,e+f@g:h%i')
  })

  it('escapes whitespace with a backslash', () => {
    expect(shellEscapePath('/Users/me/my file.png')).toBe('/Users/me/my\\ file.png')
    expect(shellEscapePath('/Users/me/日本語 の 資料.md')).toBe('/Users/me/日本語\\ の\\ 資料.md')
    expect(shellEscapePath('/a/b\tc')).toBe('/a/b\\\tc')
  })

  it("escapes quotes, parentheses, &, ;, | and so on", () => {
    expect(shellEscapePath("/a/it's")).toBe("/a/it\\'s")
    expect(shellEscapePath('/a/say "hi"')).toBe('/a/say\\ \\"hi\\"')
    expect(shellEscapePath('/a/shot (1).png')).toBe('/a/shot\\ \\(1\\).png')
    expect(shellEscapePath('/a/a&b;c|d')).toBe('/a/a\\&b\\;c\\|d')
    expect(shellEscapePath('/a/$HOME `x` !y #z *?[]{}<>^')).toBe(
      '/a/\\$HOME\\ \\`x\\`\\ \\!y\\ \\#z\\ \\*\\?\\[\\]\\{\\}\\<\\>\\^'
    )
  })

  it('also escapes the backslash itself, and a trailing space stays (not trimmed)', () => {
    expect(shellEscapePath('/a/b\\c')).toBe('/a/b\\\\c')
    expect(shellEscapePath('/a/b ')).toBe('/a/b\\ ')
  })

  it('when the shell reads it back it becomes the original path (a round trip through the real /bin/sh)', async () => {
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
  it('several are separated by one space, and duplicates and URIs that cannot be restored are dropped', () => {
    const text = pathsText([
      'file:///a/one%20two.png',
      'file:///b/3.txt',
      'file:///a/one%20two.png',
      'https://example.com/x',
      'file:///bad/%E0%A4%A'
    ])
    expect(text).toBe('/a/one\\ two.png /b/3.txt')
  })

  it('an empty string when nothing can be restored', () => {
    expect(pathsText([])).toBe('')
    expect(pathsText(['thread://x'])).toBe('')
  })
})

describe('insertPathsAtCursor', () => {
  it('for an empty body, the path and one trailing space', () => {
    expect(insertPathsAtCursor('', 0, 0, '/a/b.png')).toEqual({ text: '/a/b.png ', caret: 9 })
  })

  it('in the middle of the body: adds a space before if the preceding character is not whitespace, and after if the following one is not', () => {
    const r = insertPathsAtCursor('見てabc', 2, 2, '/a/b.png')
    expect(r.text).toBe('見て /a/b.png abc')
    expect(r.caret).toBe('見て /a/b.png '.length)
  })

  it('does not add when the preceding / following is whitespace', () => {
    expect(insertPathsAtCursor('see  end', 4, 4, '/a')).toEqual({ text: 'see /a end', caret: 6 })
  })

  it('a selection is replaced (also a backward selection)', () => {
    expect(insertPathsAtCursor('x OLD y', 2, 5, '/p').text).toBe('x /p y')
    expect(insertPathsAtCursor('x OLD y', 5, 2, '/p').text).toBe('x /p y')
  })

  it('at the line start (right after a newline) does not add a space before', () => {
    expect(insertPathsAtCursor('a\nb', 2, 2, '/p').text).toBe('a\n/p b')
  })

  it('out of range and NaN go to the end; an empty text does nothing', () => {
    expect(insertPathsAtCursor('ab', 99, 99, '/p').text).toBe('ab /p ')
    expect(insertPathsAtCursor('ab', Number.NaN, Number.NaN, '/p').text).toBe('ab /p ')
    expect(insertPathsAtCursor('ab', 1, 1, '')).toEqual({ text: 'ab', caret: 1 })
  })

  it('a path ending in an escaped space (`\\ `) is not cut either', () => {
    const r = insertPathsAtCursor('', 0, 0, shellEscapePath('/a/b '))
    expect(r.text).toBe('/a/b\\  ')
  })
})
