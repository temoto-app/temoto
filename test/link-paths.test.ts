/**
 * @vitest-environment jsdom
 *
 * TODO 548 (wave 27 bundle D): finding the paths and URLs in an answer that cannot be clicked, and fixing them (`src/shared/markdown/link-paths.ts`).
 * The table is bundle D in `docs/notes/wave27.md`. This file pins the fixtures to the hrefs after the fix. How a link is resolved when pressed,
 * the choke point, and existence are in main's `fs.resolveLink` (`test/link-resolve.test.ts`); they are not checked here.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import { findPaths, inlineCodeHref, pathHref } from '../src/shared/markdown/link-paths.js'
import { linkAction } from '../src/shared/link.js'
import { parseHref } from '../src/main/fs/link.js'

/** A pair of [href, link text]. */
const linksOf = (source: string, linkPaths = true): Array<[string, string]> => {
  const box = document.createElement('div')
  box.innerHTML = renderMarkdown(source, { linkPaths }).html
  return Array.from(box.querySelectorAll('a')).map((a) => [a.getAttribute('href') ?? '', a.textContent ?? ''])
}

describe('TODO 548: forms picked out (with linkPaths = an answer in ThreadPane)', () => {
  const cases: Array<[string, Array<[string, string]>]> = [
    // A raw URL (linkify, which already works)
    ['see https://example.com/a?b=1 for details', [['https://example.com/a?b=1', 'https://example.com/a?b=1']]],
    ['see https://example.com/a。次へ', [['https://example.com/a', 'https://example.com/a']]],
    ['URL（https://example.com/a）を参照', [['https://example.com/a', 'https://example.com/a']]],
    // A URL inside inline code
    ['`https://example.com/a`', [['https://example.com/a', 'https://example.com/a']]],
    // A raw absolute path
    ['file /Users/alice/a.txt here', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    // The owner's real example (2026-10-08): a path at the start of a paragraph or list item, followed by Japanese text at the end
    [
      '/tmp/shiramadu/in_results/shimadu02_res.png は案内どおりの手順で出た元のグレースケール出力。',
      [['/tmp/shiramadu/in_results/shimadu02_res.png', '/tmp/shiramadu/in_results/shimadu02_res.png']]
    ],
    [
      '- /tmp/shiramadu/shimadu02_inverse.png と _inverse_color.png は逆深度表示。',
      [['/tmp/shiramadu/shimadu02_inverse.png', '/tmp/shiramadu/shimadu02_inverse.png']]
    ],
    // ~/
    ['~/Desktop/memo.md を見て', [['~/Desktop/memo.md', '~/Desktop/memo.md']]],
    // A path inside inline code
    ['`/Users/alice/a.txt`', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    ['`~/x/y.md`', [['~/x/y.md', '~/x/y.md']]],
    ['`src/main/fs/link.ts:42`', [['src/main/fs/link.ts:42', 'src/main/fs/link.ts:42']]],
    ['`./x.md`', [['./x.md', './x.md']]],
    // A path containing Japanese (the href is percent-encoded; main decodes it)
    [
      '/Users/alice/書類/メモ.md を開く',
      [[`/Users/alice/${encodeURIComponent('書類')}/${encodeURIComponent('メモ')}.md`, '/Users/alice/書類/メモ.md']]
    ],
    // A path with spaces: picked up inside code
    ['`/Users/alice/My Docs/a.md`', [['/Users/alice/My%20Docs/a.md', '/Users/alice/My Docs/a.md']]],
    ['`/Users/alice/a b/c (1).png`', [['/Users/alice/a%20b/c%20(1).png', '/Users/alice/a b/c (1).png']]],
    // Trailing punctuation
    [
      '保存先は /Users/alice/a.txt、次に /Users/alice/b.txt。',
      [
        ['/Users/alice/a.txt', '/Users/alice/a.txt'],
        ['/Users/alice/b.txt', '/Users/alice/b.txt']
      ]
    ],
    ['(/Users/alice/a.txt)', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    ['See /Users/alice/a.txt.', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    ['出力は/tmp/a.pngは元', [['/tmp/a.png', '/tmp/a.png']]],
    // file:// and line numbers
    ['file:///Users/alice/a.txt', [['/Users/alice/a.txt', 'file:///Users/alice/a.txt']]],
    ['/Users/alice/a.ts:42', [['/Users/alice/a.ts:42', '/Users/alice/a.ts:42']]],
    [
      '/Users/alice/a.ts#L42 と /Users/alice/a.ts:3:1.',
      [
        ['/Users/alice/a.ts#L42', '/Users/alice/a.ts#L42'],
        ['/Users/alice/a.ts:3:1', '/Users/alice/a.ts:3:1']
      ]
    ],
    // Inside emphasis and tables
    ['**/Users/alice/a.txt**', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    ['| a | /Users/alice/a.txt |\n|---|---|\n| b | c |', [['/Users/alice/a.txt', '/Users/alice/a.txt']]],
    // Do not double-wrap something that is already inside a link
    [
      '[a](/Users/x.md) /Users/y.md',
      [
        ['/Users/x.md', 'a'],
        ['/Users/y.md', '/Users/y.md']
      ]
    ],
    ['[/Users/alice/a.txt](https://example.com)', [['https://example.com', '/Users/alice/a.txt']]],
    ['/tmp/a.png /tmp/b.png', [['/tmp/a.png', '/tmp/a.png'], ['/tmp/b.png', '/tmp/b.png']]],
    // % and # in names (encoded to match main, which uses decodeURIComponent and cuts at #)
    ['/Users/alice/a%20b#c.md', [['/Users/alice/a%2520b%23c.md', '/Users/alice/a%20b#c.md']]]
  ]
  for (const [source, expected] of cases) {
    it(JSON.stringify(source), () => {
      expect(linksOf(source)).toEqual(expected)
    })
  }
})

describe('TODO 548: forms not made into links', () => {
  const none = [
    // Inside a code block (owner decision 2026-10-09)
    '```\n/Users/alice/a.txt\nhttps://example.com\n`/Users/alice/b.txt`\n```',
    '    /Users/alice/indented.txt',
    // Slash commands, API paths, fractions, and/or
    '/compact を使う',
    'GET /api/v1/users',
    'and/or',
    '1/2',
    'km/h',
    // A relative path in body text (many false positives; picked up inside code)
    'src/a.ts',
    // A path with spaces is not picked up in body text (so it does not become a link with only its head)
    '/Users/alice/My Docs/a.md',
    // Top-level folders only
    '/Users と /tmp',
    // Inside code: commands, expressions, MIME types
    '`/usr/bin/env node`',
    '`/bin/rm -rf /tmp/x y.txt`',
    '`console.log`',
    '`text/plain`',
    '`a/b`',
    // Image alt text
    '![alt /Users/a/b.png](x.png)'
  ]
  for (const source of none) {
    it(JSON.stringify(source), () => {
      expect(linksOf(source).filter(([href]) => href !== 'x.png')).toEqual([])
    })
  }

  it('without linkPaths (the aios.markdown viewer, the default) paths do not become links as before', () => {
    expect(linksOf('/Users/alice/a.txt と `~/x.md` と `https://example.com`', false)).toEqual([])
  })
})

describe("TODO 548: the href goes straight onto click routing and main's resolution", () => {
  it('linkAction is resolve / external', () => {
    expect(linkAction('/Users/alice/a.txt')).toBe('resolve')
    expect(linkAction('~/x/y.md')).toBe('resolve')
    expect(linkAction('src/a.ts:42')).toBe('resolve')
    expect(linkAction(inlineCodeHref('https://example.com/a'))).toBe('external')
  })

  it("main's parseHref restores the original path (Japanese, spaces, names containing % and #, lines)", () => {
    const home = '/Users/me'
    const back = (raw: string): string | undefined => parseHref(pathHref(raw), home)?.paths[0]?.path
    expect(back('/Users/alice/書類/メモ.md')).toBe('/Users/alice/書類/メモ.md')
    expect(back('/Users/alice/My Docs/a.md')).toBe('/Users/alice/My Docs/a.md')
    expect(back('/Users/alice/a%20b#c.md')).toBe('/Users/alice/a%20b#c.md')
    expect(back('/Users/alice/q?.md')).toBe('/Users/alice/q?.md')
    expect(back('~/x.md')).toBe('/Users/me/x.md')
    expect(back('file:///Users/alice/%E6%9B%B8.md')).toBe('/Users/alice/書.md')
    const withLine = parseHref(pathHref('/Users/alice/a.ts#L42'), home)
    expect(withLine?.paths[0]).toEqual({ path: '/Users/alice/a.ts', position: { line: 42, column: null } })
  })

  it('findPaths returns positions', () => {
    expect(findPaths('x /tmp/a.txt。')).toEqual([{ start: 2, end: 12, href: '/tmp/a.txt' }])
  })

  it('TODO 862: even a long run of symbols finishes within 100 ms, and trailing punctuation is dropped', () => {
    const t0 = performance.now()
    findPaths('/Users/' + '.'.repeat(100000) + 'あ')
    findPaths('/tmp/a.txt' + '.'.repeat(100000))
    expect(performance.now() - t0).toBeLessThan(100)
    expect(findPaths('x /tmp/a.txt...')[0]?.href).toBe('/tmp/a.txt')
  })
})
