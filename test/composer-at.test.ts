/**
 * Pure functions for specifying a file with `@` in the prompt field (item 114, ARCHITECTURE.md 4.5.8).
 * Uses neither the DOM nor IPC.
 */
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../src/shared/types.js'
import {
  atDirectoryPart,
  atInsertPath,
  atReferencePath,
  atReferenceOrPlain,
  atReferenceText,
  atSearchKey,
  atSearchTerm,
  atTokenAt,
  completeAt,
  mergeAtCandidates,
  rankAtCandidates,
  type AtCandidate
} from '../src/renderer/src/composer-at.js'

/** The token when the caret is placed at the end of the input. */
const tokenAtEnd = (text: string): ReturnType<typeof atTokenAt> => atTokenAt(text, text.length)

function entry(path: string, isDirectory = false): FileEntry {
  const uri = new URL(`file://${path}`).href
  return {
    uri,
    parentUri: null,
    name: path.slice(path.lastIndexOf('/') + 1),
    isDirectory,
    size: 0,
    mtimeMs: 0,
    ext: ''
  }
}

describe('atTokenAt: where to show completion (item 114)', () => {
  it('shows for an @ at line start and after whitespace', () => {
    expect(tokenAtEnd('@comp')).toEqual({ start: 0, end: 5, query: 'comp' })
    expect(tokenAtEnd('これを見て @Comp')).toEqual({ start: 6, end: 11, query: 'Comp' })
    expect(tokenAtEnd('a\n@x')).toEqual({ start: 2, end: 4, query: 'x' })
  })

  it('returns the position even for a bare @ (the search word is empty so no lookup)', () => {
    expect(tokenAtEnd('見て @')).toEqual({ start: 3, end: 4, query: '' })
  })

  it('shows right after Japanese punctuation too (same condition the backend picks up)', () => {
    expect(tokenAtEnd('これ、@foo')?.query).toBe('foo')
    expect(tokenAtEnd('どう？@foo')?.query).toBe('foo')
  })

  it('does not show for an email address or an @ in the middle of a word', () => {
    expect(tokenAtEnd('mail me at a@b.com')).toBeNull()
    expect(tokenAtEnd('foo@bar')).toBeNull()
    expect(tokenAtEnd('@foo@bar')).toBeNull()
  })

  it('does not show after a finished @path (after whitespace)', () => {
    expect(tokenAtEnd('@src/a.ts ')).toBeNull()
    expect(tokenAtEnd('@src/a.ts を読んで')).toBeNull()
  })

  it('does not complete @"…" that starts with a quote', () => {
    expect(tokenAtEnd('@"My Doc')).toBeNull()
  })

  it('when the caret is in the middle of a reference, the reference ends just before the next whitespace', () => {
    const text = '@srcfoo bar'
    expect(atTokenAt(text, 4)).toEqual({ start: 0, end: 7, query: 'src' })
  })

  it('returns null when the caret is out of range', () => {
    expect(atTokenAt('@a', 0)).toBeNull()
    expect(atTokenAt('@a', 5)).toBeNull()
  })
})

describe('search word and directory filter', () => {
  it('the search word is after the last /, the filter is before it', () => {
    expect(atSearchTerm('src/comp')).toBe('comp')
    expect(atDirectoryPart('src/comp')).toBe('src')
    expect(atSearchTerm('comp')).toBe('comp')
    expect(atDirectoryPart('comp')).toBe('')
    expect(atSearchTerm('src/')).toBe('')
    expect(atDirectoryPart('/comp')).toBe('')
    expect(atDirectoryPart('/Users/me/x')).toBe('/Users/me')
  })
})

describe('atReferencePath: relative inside cwd, absolute outside', () => {
  const cwd = new URL('file:///Users/me/proj').href
  it('relative when inside, and . for cwd itself', () => {
    expect(atReferencePath(entry('/Users/me/proj/src/a.ts').uri, cwd)).toBe('src/a.ts')
    expect(atReferencePath(entry('/Users/me/proj').uri, cwd)).toBe('.')
  })

  it('absolute when outside; does not misfire on separators (proj and projx)', () => {
    expect(atReferencePath(entry('/Users/me/projx/a.ts').uri, cwd)).toBe('/Users/me/projx/a.ts')
    expect(atReferencePath(entry('/etc/hosts').uri, cwd)).toBe('/etc/hosts')
  })

  it('ignores case differences when deciding inside (APFS does not distinguish)', () => {
    expect(atReferencePath(entry('/users/ME/Proj/b.ts').uri, cwd)).toBe('b.ts')
  })

  it('also restores paths containing whitespace or Japanese from the URI', () => {
    expect(atReferencePath(entry('/Users/me/proj/設計 メモ.md').uri, cwd)).toBe('設計 メモ.md')
  })

  it('absolute when there is no cwd', () => {
    expect(atReferencePath(entry('/Users/me/proj/a.ts').uri, null)).toBe('/Users/me/proj/a.ts')
  })

  it('null for a URI that is not file:', () => {
    expect(atReferencePath('thread://x/y', cwd)).toBeNull()
  })
})

describe('completeAt: the string to insert and the input position', () => {
  it('replaces @query with @path and puts one space after it', () => {
    const text = '見て @comp'
    const token = tokenAtEnd(text)!
    expect(completeAt(text, token, 'src/Composer.tsx')).toEqual({
      text: '見て @src/Composer.tsx ',
      caret: '見て @src/Composer.tsx '.length
    })
  })

  it('does not add one when whitespace already follows, and puts the input position after it', () => {
    const text = '@co と @x'
    const token = atTokenAt(text, 3)!
    const done = completeAt(text, token, 'a.ts')
    expect(done.text).toBe('@a.ts と @x')
    expect(done.caret).toBe('@a.ts '.length)
  })

  it('choosing in the middle of a reference replaces the whole reference', () => {
    const text = '@srcfoo bar'
    const token = atTokenAt(text, 4)!
    expect(completeAt(text, token, 'src/x.ts').text).toBe('@src/x.ts bar')
  })

  it('wraps a path containing whitespace in quotes', () => {
    expect(atReferenceText('a b.md')).toBe('@"a b.md"')
    expect(atReferenceText('/tmp/x')).toBe('@/tmp/x')
    // A path containing both a space and " cannot escape to the CLI's @"…", so it cannot be referenced: null. Completion inserts it as a path without @.
    expect(atReferenceText('a "b" c.md')).toBeNull()
    expect(atReferenceText('a"b.md')).toBe('@a"b.md')
    expect(atReferenceOrPlain('a "b" c.md')).toBe('a "b" c.md')
    expect(atReferenceOrPlain('a b.md')).toBe('@"a b.md"')
  })

  it('TODO 436: a folder candidate is inserted with a trailing `/` (`.` and ones already ending in `/` are left as is)', () => {
    expect(atInsertPath({ path: 'src', isDirectory: true })).toBe('src/')
    expect(atInsertPath({ path: '/tmp/x', isDirectory: true })).toBe('/tmp/x/')
    expect(atInsertPath({ path: 'src/', isDirectory: true })).toBe('src/')
    expect(atInsertPath({ path: '.', isDirectory: true })).toBe('.')
    expect(atInsertPath({ path: 'src/a.ts', isDirectory: false })).toBe('src/a.ts')
    const text = '@sr'
    expect(completeAt(text, tokenAtEnd(text)!, atInsertPath({ path: 'src', isDirectory: true })).text).toBe(
      '@src/ '
    )
  })
})

describe('mergeAtCandidates: cwd first, everywhere else after (same as item 100)', () => {
  const cwd = new URL('file:///Users/me/proj').href
  it('puts the cwd section first and merges the same URI into one', () => {
    const inside = entry('/Users/me/proj/src/a.ts')
    const outside = entry('/Users/me/other/a.ts')
    const merged = mergeAtCandidates([inside], [outside, inside], cwd, '')
    expect(merged.map((c) => c.path)).toEqual(['src/a.ts', '/Users/me/other/a.ts'])
    expect(merged.map((c) => c.inCwd)).toEqual([true, false])
  })

  it('filters by the directory part (case ignored)', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/src/a.ts'), entry('/Users/me/proj/test/a.ts')],
      [entry('/opt/SRC/a.ts')],
      cwd,
      'src'
    )
    expect(merged.map((c) => c.path)).toEqual(['src/a.ts', '/opt/SRC/a.ts'])
  })

  it('cuts at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`/Users/me/proj/f${i}.ts`))
    expect(mergeAtCandidates(many, [], cwd, '', 8)).toHaveLength(8)
  })

  it('even for a response without a cwd section, treats inside paths as relative and inside', () => {
    const merged = mergeAtCandidates([], [entry('/Users/me/proj/a.ts')], cwd, '')
    expect(merged[0]).toMatchObject({ path: 'a.ts', inCwd: true })
  })

  // Wave 13 bundle F (small observation from items 138 / 147): `.git/logs/…` and `.claude/worktrees/…/venv/…` were listed above the direct candidates.
  // The sections (contents first) are kept; the order within each section is changed.
  it('paths through a hidden directory or a generated directory drop back within the same section', () => {
    const merged = mergeAtCandidates(
      [
        entry('/Users/me/proj/.git/logs/HEAD'),
        entry('/Users/me/proj/.claude/worktrees/x/venv/lib/site.py'),
        entry('/Users/me/proj/src/a.ts')
      ],
      [],
      cwd,
      ''
    )
    expect(merged.map((c) => c.path)).toEqual(['src/a.ts', '.git/logs/HEAD', '.claude/worktrees/x/venv/lib/site.py'])
  })

  it('puts shallower ones from cwd first within the same section', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/a/b/c/deep.ts'), entry('/Users/me/proj/shallow.ts')],
      [],
      cwd,
      ''
    )
    expect(merged.map((c) => c.path)).toEqual(['shallow.ts', 'a/b/c/deep.ts'])
  })

  it('even through a hidden directory, the everywhere section stays after the cwd section', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/.git/logs/HEAD')],
      [entry('/Users/me/other/shallow.ts')],
      cwd,
      ''
    )
    expect(merged.map((c) => c.inCwd)).toEqual([true, false])
  })
})

describe('rankAtCandidates: hidden directories / generated output / depth (the weak point of item 114, wave 13 bundle F)', () => {
  const candidate = (path: string, isDirectory = false): AtCandidate => ({
    uri: new URL(`file:///Users/me/proj/${path}`).href,
    name: path.slice(path.lastIndexOf('/') + 1),
    isDirectory,
    path,
    inCwd: true
  })

  it("on a tie, keeps the order received (main's relevance order)", () => {
    const list = [candidate('b.ts'), candidate('a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['b.ts', 'a.ts'])
  })

  it('paths through a hidden directory go back', () => {
    const list = [candidate('.git/logs/HEAD'), candidate('src/a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['src/a.ts', '.git/logs/HEAD'])
  })

  it('generated directories such as node_modules / venv go back too', () => {
    const list = [candidate('node_modules/x/index.js'), candidate('.venv/lib/site.py'), candidate('src/a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual([
      'src/a.ts',
      'node_modules/x/index.js',
      '.venv/lib/site.py'
    ])
  })

  it("does not demote by a hidden file's own name (when that is what is being searched for)", () => {
    const list = [candidate('src/a.ts'), candidate('.env')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['.env', 'src/a.ts'])
  })

  it('when the directory candidate itself is hidden / generated, it is demoted too', () => {
    const list = [candidate('src', true), candidate('node_modules', true)]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['src', 'node_modules'])
  })

  it('shallower first, and the order received for the same depth', () => {
    const list = [candidate('a/b/deep.ts'), candidate('shallow.ts'), candidate('a/b2.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['shallow.ts', 'a/b2.ts', 'a/b/deep.ts'])
  })
})

describe('atSearchKey (TODO 942)', () => {
  it('a different word, directory or cwd gives a different key (tells stale candidates apart)', () => {
    const base = atSearchKey('a', '', '/w')
    expect(atSearchKey('a.ts', '', '/w')).not.toBe(base)
    expect(atSearchKey('a', 'src/', '/w')).not.toBe(base)
    expect(atSearchKey('a', '', '/x')).not.toBe(base)
    expect(atSearchKey('a', '', '/w')).toBe(base)
  })
})
