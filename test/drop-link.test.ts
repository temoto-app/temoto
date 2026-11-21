/**
 * TODO 366 (wave 20 bundle E): turn a file dropped onto the viewer into a Markdown link.
 *
 *  - Building the string (`shared/drop-link.ts`): images become `![name](file:///…)`, others `[name](file:///…)`,
 *    several files one per line. file:// URLs are `encodeURI`-like, plus `#` `?` `(` `)`. In names, `[` `]` and `\` are escaped.
 *  - The main choke point (`checkDropLinks`): re-checks from the type and returns only what passes `assertAllowed` (read). Paths under an excluded tree, a non-`file:` scheme, relative paths and missing files are rejected with a reason code. Folders are passed again as folders. Also checked against the real FsAccess.
 *
 *  - TODO 407 (wave 21 bundle B): the format depends on the plugin (`dropInsertFormat`). Only `aios.markdown` gets a Markdown link; everything else gets the raw full path (`plainPathFor`, no quotes and no escapes, one per line). Checks the values in the trace log (`sanitizeDropTrace`).
 *
 * It wakes neither the model nor Electron.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_DROP_LINKS,
  dropInsertFormat,
  dropInsertText,
  dropLinkText,
  escapeLinkText,
  filePathOfUri,
  isImageName,
  markdownFileUrl,
  markdownLinkFor,
  plainPathFor,
  sanitizeDropTrace
} from '../src/shared/drop-link.js'
import { checkDropLinks } from '../src/main/fs/drop-links.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { pathToUri } from '../src/common/uri.js'
import { FsAccess } from '../src/main/fs/access.js'
import { parseReason } from '../src/shared/reason.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

describe('string building (shared/drop-link.ts)', () => {
  it('an image is ![name](file:///…), anything else is [name](file:///…)', () => {
    expect(markdownLinkFor({ uri: 'file:///Users/alice/Desktop/shot.png', isDirectory: false })).toBe(
      '![shot.png](file:///Users/alice/Desktop/shot.png)'
    )
    expect(markdownLinkFor({ uri: 'file:///Users/alice/doc/spec.pdf', isDirectory: false })).toBe(
      '[spec.pdf](file:///Users/alice/doc/spec.pdf)'
    )
  })

  it('an image is decided by extension (uppercase too); a name that merely starts with a dot and a folder are not images', () => {
    for (const name of ['a.png', 'A.PNG', 'b.jpeg', 'c.JPG', 'd.webp', 'e.svg', 'f.gif', 'g.heic', 'h.tiff', 'x.y.avif']) {
      expect(isImageName(name), name).toBe(true)
    }
    for (const name of ['a.txt', 'png', '.png', 'a.png.md', 'Makefile', 'a.']) {
      expect(isImageName(name), name).toBe(false)
    }
    expect(markdownLinkFor({ uri: 'file:///work/assets.png', isDirectory: true })).toBe(
      '[assets.png](file:///work/assets.png)'
    )
  })

  it('whitespace, non-ASCII and % use encodeURI, and # ? ( ) are encoded too (the link target does not break)', () => {
    expect(markdownFileUrl('/Users/alice/My Pictures/スクリーンショット 1.png')).toBe(
      `file://${encodeURI('/Users/alice/My Pictures/スクリーンショット 1.png')}`
    )
    expect(markdownFileUrl('/a b/c#1?(2).png')).toBe('file:///a%20b/c%231%3F%282%29.png')
    expect(markdownFileUrl('/x/100%.txt')).toBe('file:///x/100%25.txt')
    // ~ = , + @ : are not encoded (kept as encodeURI leaves them).
    expect(markdownFileUrl('/x/a~b=c,d+e@f:g.md')).toBe('file:///x/a~b=c,d+e@f:g.md')
  })

  it('restores the original path from the Drop URI (made by preload with encodeURIComponent) and then rebuilds', () => {
    const path = '/Users/alice/Desktop/画面 (1).png'
    const preloadUri = `file://${path.split('/').map(encodeURIComponent).join('/')}`
    expect(filePathOfUri(preloadUri)).toBe(path)
    expect(markdownLinkFor({ uri: preloadUri, isDirectory: false })).toBe(
      '![画面 (1).png](file:///Users/alice/Desktop/%E7%94%BB%E9%9D%A2%20%281%29.png)'
    )
  })

  it('escapes [ ] \\ in the name, and folds newlines into spaces', () => {
    expect(escapeLinkText('a[1]\\b')).toBe('a\\[1\\]\\\\b')
    expect(escapeLinkText('a\nb')).toBe('a b')
    expect(markdownLinkFor({ uri: pathToUri('/w/[draft].md'), isDirectory: false })).toBe(
      '[\\[draft\\].md](file:///w/%5Bdraft%5D.md)'
    )
  })

  it('several go one per line with no trailing newline; drops non-file: and relative ones', () => {
    expect(
      dropLinkText([
        { uri: 'file:///a/x.png', isDirectory: false },
        { uri: 'https://example.com/y.png', isDirectory: false },
        { uri: 'file:///b/y.md', isDirectory: false },
        { uri: 'file://rel/z.md', isDirectory: false }
      ])
    ).toBe('![x.png](file:///a/x.png)\n[y.md](file:///b/y.md)')
    expect(dropLinkText([])).toBe('')
  })

  it('for a folder, drops the trailing / and takes the name', () => {
    expect(markdownLinkFor({ uri: 'file:///work/src/', isDirectory: true })).toBe('[src](file:///work/src)')
  })
})

describe("main's choke point (checkDropLinks)", () => {
  const gate = (deny: Record<string, 'excluded' | 'not-a-file-uri'>) => ({
    calls: [] as { uri: string; asDirectory: boolean; access: string | undefined }[],
    assertAllowed(uri: string, asDirectory: boolean, access?: string): string {
      this.calls.push({ uri, asDirectory, access })
      const reason = deny[uri]
      if (reason !== undefined) throw new PathDenied(reason)
      return decodeURIComponent(uri.slice('file://'.length))
    }
  })

  it('those that passed rebuild the URI from the logical path and return it, and refused ones give a reason code', () => {
    const g = gate({ 'file:///Users/k/.ssh/id_rsa': 'excluded', 'http://x/y': 'not-a-file-uri' })
    const result = checkDropLinks(
      ['file:///Users/k/a%20b.png', 'file:///Users/k/.ssh/id_rsa', 'http://x/y', 'file:///Users/k/dir', 'file:///gone'],
      {
        gate: g,
        kindOf: (path) => (path === '/gone' ? null : path.endsWith('dir'))
      }
    )
    expect(result.allowed).toEqual([
      { uri: 'file:///Users/k/a%20b.png', isDirectory: false },
      { uri: 'file:///Users/k/dir', isDirectory: true }
    ])
    expect(result.denied).toEqual([
      { uri: 'file:///Users/k/.ssh/id_rsa', reason: 'path-excluded' },
      { uri: 'http://x/y', reason: 'path-invalid-uri' },
      { uri: 'file:///gone', reason: 'path-not-found' }
    ])
    // Pass through as a read, and check folders again as folders.
    expect(g.calls.every((call) => call.access === 'read')).toBe(true)
    expect(g.calls.filter((call) => call.uri === 'file:///Users/k/dir').map((call) => call.asDirectory)).toEqual([
      false,
      true
    ])
  })

  it('a wrong shape gives invalid-value without throwing; duplicates are one, and anything over the limit is not looked at', () => {
    const g = gate({})
    const bad = checkDropLinks('file:///a', { gate: g, kindOf: () => false })
    expect(bad.allowed).toEqual([])
    expect(parseReason(bad.denied[0]?.reason)?.code).toBe('invalid-value')
    const mixed = checkDropLinks([1, 'file:///a', 'file:///a'], { gate: g, kindOf: () => false })
    expect(mixed.allowed).toEqual([{ uri: 'file:///a', isDirectory: false }])
    expect(parseReason(mixed.denied[0]?.reason)?.code).toBe('invalid-value')
    const many = Array.from({ length: MAX_DROP_LINKS + 10 }, (_, i) => `file:///f${i}`)
    expect(checkDropLinks(many, { gate: g, kindOf: () => false }).allowed).toHaveLength(MAX_DROP_LINKS)
  })

  describe('the real FsAccess', () => {
    // The main body excludes `~/.aios-test`, so measure with a FsAccess whose home is there (same as folder-notice.test.ts).
    const home = realpathSync(makeTestDir('drop-link-test'))
    afterAll(() => removeTestDir(home))
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret')
    mkdirSync(join(home, 'pics'))
    writeFileSync(join(home, 'pics', 'a b.png'), 'png')

    it('under an exclusion is path-excluded, and normal files and folders pass', () => {
      const fs = new FsAccess(home)
      const result = checkDropLinks(
        [pathToUri(join(home, 'pics', 'a b.png')), pathToUri(join(home, '.ssh', 'id_rsa')), pathToUri(join(home, 'pics'))],
        { gate: fs }
      )
      expect(result.allowed).toEqual([
        { uri: pathToUri(join(home, 'pics', 'a b.png')), isDirectory: false },
        { uri: pathToUri(join(home, 'pics')), isDirectory: true }
      ])
      expect(result.denied).toEqual([{ uri: pathToUri(join(home, '.ssh', 'id_rsa')), reason: 'path-excluded' }])
      expect(dropLinkText(result.allowed)).toBe(
        `![a b.png](${markdownFileUrl(join(home, 'pics', 'a b.png'))})\n[pics](${markdownFileUrl(join(home, 'pics'))})`
      )
    })
  })
})

describe('format and plain path (TODO 407)', () => {
  it('dropInsertFormat: only aios.markdown gets a link; aios.text and an unknown plugin get a plain path', () => {
    expect(dropInsertFormat('aios.markdown')).toBe('markdown-link')
    expect(dropInsertFormat('aios.text')).toBe('path')
    expect(dropInsertFormat('acme.viewer')).toBe('path')
    expect(dropInsertFormat('')).toBe('path')
  })

  it('plainPathFor: the logical path restored from the URI as is (whitespace, Japanese, parentheses and # stay raw); drops the trailing / of a folder', () => {
    expect(plainPathFor({ uri: 'file:///Users/k/a%20b%20(1)%23.txt', isDirectory: false })).toBe('/Users/k/a b (1)#.txt')
    expect(plainPathFor({ uri: 'file:///Users/k/%E8%B3%87%E6%96%99/', isDirectory: true })).toBe('/Users/k/資料')
    expect(plainPathFor({ uri: 'file:///', isDirectory: true })).toBe('/')
    expect(plainPathFor({ uri: 'https://x/', isDirectory: false })).toBeNull()
  })

  it('dropInsertText: one per line with no trailing newline; the link format is the same as dropLinkText', () => {
    const targets = [
      { uri: 'file:///p/a.png', isDirectory: false },
      { uri: 'https://bad/', isDirectory: false },
      { uri: 'file:///p/dir', isDirectory: true }
    ]
    expect(dropInsertText(targets, 'path')).toBe('/p/a.png\n/p/dir')
    expect(dropInsertText(targets, 'markdown-link')).toBe(dropLinkText(targets))
    expect(dropInsertText([], 'path')).toBe('')
  })

  it('sanitizeDropTrace: step names only from the table, counts are integers 0 to 10000, extra fields (paths) are dropped', () => {
    expect(sanitizeDropTrace({ stage: 'overlay-drop', files: 2, uris: 1, emptyPaths: 1, path: '/etc/x' })).toEqual({
      stage: 'overlay-drop',
      files: 2,
      uris: 1,
      emptyPaths: 1
    })
    // TODO 563: the drop action (`action`) is limited to the three entries in the table.
    expect(sanitizeDropTrace({ stage: 'pane-drop', files: 1, action: 'open' })).toEqual({ stage: 'pane-drop', files: 1, action: 'open' })
    expect(sanitizeDropTrace({ stage: 'pane-drop', action: '/etc/x' })).toEqual({ stage: 'pane-drop' })
    expect(sanitizeDropTrace({ stage: 'insert', format: 'path', lines: 3, sent: true })).toEqual({
      stage: 'insert',
      format: 'path',
      lines: 3,
      sent: true
    })
    expect(sanitizeDropTrace({ stage: 'drag-seen', source: 'guest', files: -1, lines: 1.5, format: 'x' })).toEqual({
      stage: 'drag-seen',
      source: 'guest'
    })
    expect(sanitizeDropTrace({ stage: 'nope' })).toBeNull()
    expect(sanitizeDropTrace(null)).toBeNull()
    expect(sanitizeDropTrace('insert')).toBeNull()
  })

  it('sanitizeDropTrace (429): the caller of end, the dropped reason, the received element and dropEffect are only table values, and cloneFailed is only a boolean', () => {
    expect(sanitizeDropTrace({ stage: 'end', reason: 'pointer' })).toEqual({ stage: 'end', reason: 'pointer' })
    expect(sanitizeDropTrace({ stage: 'guest-drop-skipped', reason: 'stale', files: 1 })).toEqual({
      stage: 'guest-drop-skipped',
      reason: 'stale',
      files: 1
    })
    expect(
      sanitizeDropTrace({ stage: 'overlay-dragover', target: 'body', dropEffect: 'copy', effectAllowed: 'copyMove' })
    ).toEqual({ stage: 'overlay-dragover', target: 'body', dropEffect: 'copy', effectAllowed: 'copyMove' })
    expect(
      sanitizeDropTrace({
        stage: 'guest-drop',
        cloneFailed: true,
        reason: '/etc/passwd',
        target: 'iframe',
        dropEffect: '/x',
        effectAllowed: 'x'
      })
    ).toEqual({ stage: 'guest-drop', cloneFailed: true })
  })
})
