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

describe('atTokenAt — 補完を出す位置 (項目 114)', () => {
  it('行頭と空白の後の @ で出す', () => {
    expect(tokenAtEnd('@comp')).toEqual({ start: 0, end: 5, query: 'comp' })
    expect(tokenAtEnd('これを見て @Comp')).toEqual({ start: 6, end: 11, query: 'Comp' })
    expect(tokenAtEnd('a\n@x')).toEqual({ start: 2, end: 4, query: 'x' })
  })

  it('@ だけでも位置は返す (検索語が空なので引かない)', () => {
    expect(tokenAtEnd('見て @')).toEqual({ start: 3, end: 4, query: '' })
  })

  it('和文の句読点の直後でも出す (バックエンドが拾う条件と同じ)', () => {
    expect(tokenAtEnd('これ、@foo')?.query).toBe('foo')
    expect(tokenAtEnd('どう？@foo')?.query).toBe('foo')
  })

  it('メールアドレスや語の途中の @ には出さない', () => {
    expect(tokenAtEnd('mail me at a@b.com')).toBeNull()
    expect(tokenAtEnd('foo@bar')).toBeNull()
    expect(tokenAtEnd('@foo@bar')).toBeNull()
  })

  it('打ち終えた @path の後ろ (空白の後) では出さない', () => {
    expect(tokenAtEnd('@src/a.ts ')).toBeNull()
    expect(tokenAtEnd('@src/a.ts を読んで')).toBeNull()
  })

  it('引用符で始めた @"…" は補完しない', () => {
    expect(tokenAtEnd('@"My Doc')).toBeNull()
  })

  it('caret が参照の途中なら、参照の終わりは次の空白の手前まで', () => {
    const text = '@srcfoo bar'
    expect(atTokenAt(text, 4)).toEqual({ start: 0, end: 7, query: 'src' })
  })

  it('caret が範囲の外なら null', () => {
    expect(atTokenAt('@a', 0)).toBeNull()
    expect(atTokenAt('@a', 5)).toBeNull()
  })
})

describe('検索語とディレクトリの絞り込み', () => {
  it('検索語は最後の / の後ろ、絞り込みは前', () => {
    expect(atSearchTerm('src/comp')).toBe('comp')
    expect(atDirectoryPart('src/comp')).toBe('src')
    expect(atSearchTerm('comp')).toBe('comp')
    expect(atDirectoryPart('comp')).toBe('')
    expect(atSearchTerm('src/')).toBe('')
    expect(atDirectoryPart('/comp')).toBe('')
    expect(atDirectoryPart('/Users/me/x')).toBe('/Users/me')
  })
})

describe('atReferencePath — cwd の中は相対、外は絶対', () => {
  const cwd = new URL('file:///Users/me/proj').href
  it('中なら相対、cwd そのものは .', () => {
    expect(atReferencePath(entry('/Users/me/proj/src/a.ts').uri, cwd)).toBe('src/a.ts')
    expect(atReferencePath(entry('/Users/me/proj').uri, cwd)).toBe('.')
  })

  it('外なら絶対。区切りの誤爆 (proj と projx) をしない', () => {
    expect(atReferencePath(entry('/Users/me/projx/a.ts').uri, cwd)).toBe('/Users/me/projx/a.ts')
    expect(atReferencePath(entry('/etc/hosts').uri, cwd)).toBe('/etc/hosts')
  })

  it('大文字小文字の違いは無視して中と判定する (APFS は区別しない)', () => {
    expect(atReferencePath(entry('/users/ME/Proj/b.ts').uri, cwd)).toBe('b.ts')
  })

  it('空白や日本語を含むパスも URI から戻す', () => {
    expect(atReferencePath(entry('/Users/me/proj/設計 メモ.md').uri, cwd)).toBe('設計 メモ.md')
  })

  it('cwd が無ければ絶対', () => {
    expect(atReferencePath(entry('/Users/me/proj/a.ts').uri, null)).toBe('/Users/me/proj/a.ts')
  })

  it('file: でない URI は null', () => {
    expect(atReferencePath('thread://x/y', cwd)).toBeNull()
  })
})

describe('completeAt — 入れる文字列と入力位置', () => {
  it('@query を @path に置き換え、後ろに空白を 1 つ置く', () => {
    const text = '見て @comp'
    const token = tokenAtEnd(text)!
    expect(completeAt(text, token, 'src/Composer.tsx')).toEqual({
      text: '見て @src/Composer.tsx ',
      caret: '見て @src/Composer.tsx '.length
    })
  })

  it('後ろに既に空白があれば足さず、その後ろに入力位置を置く', () => {
    const text = '@co と @x'
    const token = atTokenAt(text, 3)!
    const done = completeAt(text, token, 'a.ts')
    expect(done.text).toBe('@a.ts と @x')
    expect(done.caret).toBe('@a.ts '.length)
  })

  it('参照の途中で選んでも、参照全体を置き換える', () => {
    const text = '@srcfoo bar'
    const token = atTokenAt(text, 4)!
    expect(completeAt(text, token, 'src/x.ts').text).toBe('@src/x.ts bar')
  })

  it('空白を含むパスは引用符で包む', () => {
    expect(atReferenceText('a b.md')).toBe('@"a b.md"')
    expect(atReferenceText('/tmp/x')).toBe('@/tmp/x')
    // A path containing both a space and " cannot escape to the CLI's @"…", so it cannot be referenced: null. Completion inserts it as a path without @.
    expect(atReferenceText('a "b" c.md')).toBeNull()
    expect(atReferenceText('a"b.md')).toBe('@a"b.md')
    expect(atReferenceOrPlain('a "b" c.md')).toBe('a "b" c.md')
    expect(atReferenceOrPlain('a b.md')).toBe('@"a b.md"')
  })

  it('TODO 436: フォルダの候補は末尾に `/` を付けて入れる (`.` と既に `/` で終わるものはそのまま)', () => {
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

describe('mergeAtCandidates — cwd が先、全域が後 (項目 100 と同じ)', () => {
  const cwd = new URL('file:///Users/me/proj').href
  it('cwd の区画を先に並べ、同じ URI は 1 つにする', () => {
    const inside = entry('/Users/me/proj/src/a.ts')
    const outside = entry('/Users/me/other/a.ts')
    const merged = mergeAtCandidates([inside], [outside, inside], cwd, '')
    expect(merged.map((c) => c.path)).toEqual(['src/a.ts', '/Users/me/other/a.ts'])
    expect(merged.map((c) => c.inCwd)).toEqual([true, false])
  })

  it('ディレクトリの部分で絞る (大文字小文字は無視)', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/src/a.ts'), entry('/Users/me/proj/test/a.ts')],
      [entry('/opt/SRC/a.ts')],
      cwd,
      'src'
    )
    expect(merged.map((c) => c.path)).toEqual(['src/a.ts', '/opt/SRC/a.ts'])
  })

  it('上限で切る', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`/Users/me/proj/f${i}.ts`))
    expect(mergeAtCandidates(many, [], cwd, '', 8)).toHaveLength(8)
  })

  it('cwd の区画が無い応答でも、中のパスは相対・中として扱う', () => {
    const merged = mergeAtCandidates([], [entry('/Users/me/proj/a.ts')], cwd, '')
    expect(merged[0]).toMatchObject({ path: 'a.ts', inCwd: true })
  })

  // Wave 13 bundle F (small observation from items 138 / 147): `.git/logs/…` and `.claude/worktrees/…/venv/…` were listed above the direct candidates.
  // The sections (contents first) are kept; the order within each section is changed.
  it('隠しディレクトリ・生成物のディレクトリを含む経路は同じ区画内で後ろへ下がる', () => {
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

  it('cwd からの深さが浅いものを同じ区画内で前に置く', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/a/b/c/deep.ts'), entry('/Users/me/proj/shallow.ts')],
      [],
      cwd,
      ''
    )
    expect(merged.map((c) => c.path)).toEqual(['shallow.ts', 'a/b/c/deep.ts'])
  })

  it('隠しディレクトリでも全域の区画は cwd の区画より後ろのまま', () => {
    const merged = mergeAtCandidates(
      [entry('/Users/me/proj/.git/logs/HEAD')],
      [entry('/Users/me/other/shallow.ts')],
      cwd,
      ''
    )
    expect(merged.map((c) => c.inCwd)).toEqual([true, false])
  })
})

describe('rankAtCandidates — 隠しディレクトリ / 生成物 / 深さ (項目 114 の難点、第 13 波 束 F)', () => {
  const candidate = (path: string, isDirectory = false): AtCandidate => ({
    uri: new URL(`file:///Users/me/proj/${path}`).href,
    name: path.slice(path.lastIndexOf('/') + 1),
    isDirectory,
    path,
    inCwd: true
  })

  it('同点なら受け取った順を保つ (main の関連度順)', () => {
    const list = [candidate('b.ts'), candidate('a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['b.ts', 'a.ts'])
  })

  it('隠しディレクトリを通る経路は後ろへ', () => {
    const list = [candidate('.git/logs/HEAD'), candidate('src/a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['src/a.ts', '.git/logs/HEAD'])
  })

  it('node_modules / venv のような生成物のディレクトリも後ろへ', () => {
    const list = [candidate('node_modules/x/index.js'), candidate('.venv/lib/site.py'), candidate('src/a.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual([
      'src/a.ts',
      'node_modules/x/index.js',
      '.venv/lib/site.py'
    ])
  })

  it('隠しファイル自身の名前では下げない (探しているものがそれのとき)', () => {
    const list = [candidate('src/a.ts'), candidate('.env')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['.env', 'src/a.ts'])
  })

  it('ディレクトリの候補自身が隠し / 生成物なら、それ自体も下げる', () => {
    const list = [candidate('src', true), candidate('node_modules', true)]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['src', 'node_modules'])
  })

  it('浅いものを先に、同じ深さなら受け取った順', () => {
    const list = [candidate('a/b/deep.ts'), candidate('shallow.ts'), candidate('a/b2.ts')]
    expect(rankAtCandidates(list).map((c) => c.path)).toEqual(['shallow.ts', 'a/b2.ts', 'a/b/deep.ts'])
  })
})

describe('atSearchKey (TODO 942)', () => {
  it('語・ディレクトリ・cwd のどれかが違えば鍵も違う (古い候補を見分ける)', () => {
    const base = atSearchKey('a', '', '/w')
    expect(atSearchKey('a.ts', '', '/w')).not.toBe(base)
    expect(atSearchKey('a', 'src/', '/w')).not.toBe(base)
    expect(atSearchKey('a', '', '/x')).not.toBe(base)
    expect(atSearchKey('a', '', '/w')).toBe(base)
  })
})
