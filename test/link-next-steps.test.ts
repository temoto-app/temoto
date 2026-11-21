/**
 * wave 44 bundle B: the next step when a link in an answer could not be opened.
 *
 * - TODO 808: a file that really exists in an excluded place (`~/Library`, OS areas, generated output, ...) is not put into the viewer;
 *   instead it gets `link-excluded` and a URI to hand outside (external editor / Finder). The choke point is `'handoff'` (`classifyAccess`).
 *   Credentials are never handed outside either (a symlink pointing at a credential is also dropped by re-checking the real file).
 *   `.vscode/settings.json` is not excluded (it opens from cwd; if it is gone, `link-not-found` plus the paths tried).
 * - TODO 816: a partial path is tried against cwd → the directories the shell `cd`'d into (`shellDirsOf`, saved tool calls) → the index's
 *   file-name search (`resolveLinkWithSearch`). One match opens; several give `choices`, ordered by closeness to cwd.
 *
 * The tree is built under a fake home inside `~/.aios-test` (`tmpdir()` falls under the exclusions). The real `~/.claude` is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { classifyAccess, createMacosExclusions } from '../src/common/exclusions.js'
import { runMigrations } from '../src/common/migrations.js'
import { pathToUri } from '../src/common/uri.js'
import { FsAccess } from '../src/main/fs/access.js'
import {
  rankByCwd,
  resolveLink,
  resolveLinkRequest,
  resolveLinkWithSearch,
  searchSegmentsOf,
  type LinkSearchDeps
} from '../src/main/fs/link.js'
import { revealInFolder } from '../src/main/editor/reveal.js'
import { createEditorLaunchers, type ExecFileLike } from '../src/main/editor/launcher.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import { cdTargetsOf, shellDirsOf, type StoredToolUse } from '../src/main/session/adapter/shell-dirs.js'
import { ThreadStore } from '../src/main/session/store.js'
import { parseReason } from '../src/shared/reason.js'
import type { AiosEvent } from '../src/shared/agent.js'
import type { LinkResolution } from '../src/shared/link.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

let home: string
let cwd: string
let other: string
let backendDir: string
let fsAccess: FsAccess

const codeOf = (result: LinkResolution): string | null =>
  result.ok ? null : (parseReason(result.reason)?.code ?? result.reason)

beforeAll(() => {
  home = realpathSync(makeTestDir('link-next'))
  cwd = join(home, 'git', 'proj')
  other = join(home, 'git', 'uC3.ag6r')
  mkdirSync(join(cwd, '.vscode'), { recursive: true })
  writeFileSync(join(cwd, '.vscode', 'settings.json'), '{}\n')
  mkdirSync(join(other, 'uC3', 'Driver', 'GCC'), { recursive: true })
  writeFileSync(join(other, 'uC3', 'Driver', 'GCC', 'MMU.S'), '; mmu\n')
  // A file in an excluded place (`~/Library` = app-internal) that is not a credential.
  mkdirSync(join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true })
  writeFileSync(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), '{}\n')
  // The credential directory (the same shape under the fake home).
  backendDir = join(home, (loadBackendPaths().credentialDirs[0] ?? '~/.x').slice(2))
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, '.credentials.json'), '{"secret":"TOP"}')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host x\n')
  // A symlink from a place that is not excluded, pointing at a credential.
  symlinkSync(join(home, '.ssh', 'config'), join(cwd, 'ssh-config-link'))
  fsAccess = new FsAccess(home, [home])
})

afterAll(() => {
  removeTestDir(home)
})

describe("TODO 808: 外へ渡すだけの関門 ('handoff')", () => {
  const rules = (): ReturnType<typeof createMacosExclusions> => createMacosExclusions(home)
  const verdict = (path: string, isDirectory = false): boolean =>
    classifyAccess(path, path.split('/').at(-1) ?? '', isDirectory, rules(), 'handoff').excluded

  it('資格情報以外の除外 (~/Library・OS 領域・生成物・キャッシュ) は通す', () => {
    expect(verdict(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'))).toBe(false)
    expect(verdict('/etc/hosts')).toBe(false)
    expect(verdict('/usr/include/stdio.h')).toBe(false)
    expect(verdict(join(cwd, 'node_modules'), true)).toBe(false)
    expect(verdict(join(home, '.cache', 'x.log'))).toBe(false)
  })

  it('資格情報の置き場とファイル名 (.netrc・id_rsa) は通さない。auto memory の .md の読み取りの例外も効かない', () => {
    expect(verdict(join(home, '.ssh', 'config'))).toBe(true)
    expect(verdict(join(backendDir, '.credentials.json'))).toBe(true)
    expect(verdict(join(backendDir, 'projects', '-x', 'memory', 'MEMORY.md'))).toBe(true)
    expect(verdict(join(cwd, '.netrc'))).toBe(true)
    expect(verdict(join(cwd, 'id_rsa'))).toBe(true)
  })

  it('FsAccess: 資格情報を指す symlink は実体の再検査で落ちる (read でも handoff でも)', () => {
    const uri = pathToUri(join(cwd, 'ssh-config-link'))
    expect(() => fsAccess.assertAllowed(uri, false, 'read')).toThrow()
    expect(() => fsAccess.assertAllowed(uri, false, 'handoff')).toThrow()
  })

  it('Finder で表示: read で断られても handoff なら見せる。資格情報は見せない', () => {
    const shown: string[] = []
    const deps = {
      assertAllowed: (value: string, isDirectory: boolean): string => {
        try {
          return fsAccess.assertAllowed(value, isDirectory, 'read')
        } catch {
          return fsAccess.assertAllowed(value, isDirectory, 'handoff')
        }
      },
      show: (path: string) => shown.push(path)
    }
    const library = join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    expect(revealInFolder(deps, pathToUri(library), false)).toBe(true)
    expect(revealInFolder(deps, pathToUri(join(home, '.ssh', 'config')), false)).toBe(false)
    expect(shown).toEqual([library])
  })
})

describe('TODO 808: リンクの解決の次の手', () => {
  const context = { baseDir: cwd, memoryDirs: [] as readonly string[], home: '' }
  const open = (href: string): LinkResolution => resolveLink(href, { ...context, baseDir: cwd, home }, fsAccess)

  it('`.vscode/settings.json` は除外ではない — cwd にあれば開く', () => {
    expect(open('.vscode/settings.json')).toEqual({ ok: true, uri: pathToUri(join(cwd, '.vscode', 'settings.json')) })
  })

  it('消えた (git diff の削除) なら link-not-found + 試したパス + 名前で検索の語', () => {
    const result = open('.vscode/gone.json')
    expect(codeOf(result)).toBe('link-not-found')
    if (!result.ok) {
      expect(result.tried).toEqual([join(cwd, '.vscode', 'gone.json')])
      expect(result.searchName).toBe('gone.json')
    }
  })

  it('除外の場所に実在するファイルは link-excluded + 外へ渡す URI (viewer には入れない)', () => {
    const library = join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    const result = open(library)
    expect(codeOf(result)).toBe('link-excluded')
    if (!result.ok) {
      expect(result.handoffUri).toBe(pathToUri(library))
      expect(result.handoffDirectory).toBeUndefined()
    }
    // The `~/` form works the same way.
    expect(codeOf(open('~/Library/Application Support/Code/User/settings.json'))).toBe('link-excluded')
  })

  it('資格情報は今までどおり path-excluded で、外へ渡す URI は付かない', () => {
    for (const href of [join(home, '.ssh', 'config'), join(backendDir, '.credentials.json'), 'ssh-config-link']) {
      const result = open(href)
      expect(result.ok, href).toBe(false)
      if (!result.ok) {
        expect(result.handoffUri, href).toBeUndefined()
        expect(codeOf(result), href).not.toBe('link-excluded')
      }
    }
  })

  it('除外の場所に無いファイル (実在しない) は link-excluded にしない', () => {
    const result = open(join(home, 'Library', 'nothing.json'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.handoffUri).toBeUndefined()
  })
})

describe('TODO 816: シェルが `cd` した先 (adapter/shell-dirs.ts)', () => {
  it('cd / pushd の行き先を順に辿る (相対は直前の場所から、~ と $HOME を展開)', () => {
    expect(cdTargetsOf('cd /a/b && ls', '/w', '/h').visited).toEqual(['/a/b'])
    expect(cdTargetsOf('cd /a; cd sub && make', '/w', '/h')).toEqual({ visited: ['/a', '/a/sub'], last: '/a/sub' })
    expect(cdTargetsOf('cd ~/git/x', '/w', '/h').visited).toEqual(['/h/git/x'])
    expect(cdTargetsOf('cd "$HOME/My Docs"', '/w', '/h').visited).toEqual(['/h/My Docs'])
    expect(cdTargetsOf("cd '/p q' && pushd ../r", '/w', '/h').visited).toEqual(['/p q', '/r'])
    expect(cdTargetsOf('cd /a\\ b', '/w', '/h').visited).toEqual(['/a b'])
    expect(cdTargetsOf('(cd /sub && ls)', '/w', '/h').visited).toEqual(['/sub'])
  })

  it('形で決まらない行き先は捨てる (cd -・引数なし・変数・コマンド置換・cd の語でないもの)', () => {
    for (const command of ['cd -', 'cd', 'cd $DIR', 'cd "$(git rev-parse --show-toplevel)"', 'echo cd /x', 'abcd /x', 'cd `pwd`']) {
      expect(cdTargetsOf(command, '/w', '/h').visited, command).toEqual([])
    }
  })

  it('呼び出しをまたいで場所を持ち越し、新しい順に重複なく返す (cwd 自身とシェル以外のツールは除く)', () => {
    const uses: StoredToolUse[] = [
      { name: 'Bash', input: { command: 'cd /Users/x/git' } },
      { name: 'Bash', input: { command: 'cd uC3.ag6r && git log' } },
      { name: 'Read', input: { file_path: '/elsewhere/a.c' } },
      { name: 'Bash', input: { command: 'cd /w' } },
      { name: 'Bash', input: { command: 'cd /Users/x/git' } },
      { name: 'Bash', input: 'broken' }
    ]
    expect(shellDirsOf(uses, '/w', '/h')).toEqual(['/Users/x/git', '/Users/x/git/uC3.ag6r'])
  })

  it('ThreadStore.recentToolUses は古い順に名前と引数を返す (壊れた行は飛ばす)', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      const thread = store.createThread({
        id: 't1',
        title: 't',
        cwd: '/Users/tester/w',
        allowedDirs: ['/Users/tester/w'],
        retention: 'forever',
        backend: 'agent-cli',
        modelId: null,
        thinking: null
      })
      const use = (id: string, command: string): AiosEvent =>
        ({
          id,
          sessionId: 's1',
          threadId: 't1',
          ts: Date.now(),
          actor: 'main',
          kind: 'tool_use',
          payload: { toolUseId: id, name: 'Bash', summary: command, input: { command }, truncated: false }
        }) as AiosEvent
      store.appendEvents(thread, 's1', [use('u1', 'cd /a'), use('u2', 'cd /b')])
      expect(store.recentToolUses('t1')).toEqual([
        { name: 'Bash', input: { command: 'cd /a' } },
        { name: 'Bash', input: { command: 'cd /b' } }
      ])
      expect(store.recentToolUses('t1', 1)).toEqual([{ name: 'Bash', input: { command: 'cd /b' } }])
      expect(store.recentToolUses('missing')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('resolveLinkRequest: cwd に無い相対パスは cd した先で解く (絶対パスでは cd の先を読まない)', () => {
    let reads = 0
    const deps = {
      gate: fsAccess,
      home,
      threadContext: (id: string) =>
        id === 't'
          ? {
              cwd,
              memoryDirs: [],
              shellDirs: () => {
                reads += 1
                return [other]
              }
            }
          : null
    }
    expect(resolveLinkRequest({ href: 'uC3/Driver/GCC/MMU.S:12', threadId: 't', baseUri: null }, deps)).toEqual({
      ok: true,
      uri: pathToUri(join(other, 'uC3', 'Driver', 'GCC', 'MMU.S')),
      line: 12
    })
    expect(reads).toBe(1)
    resolveLinkRequest({ href: join(cwd, '.vscode', 'settings.json'), threadId: 't', baseUri: null }, deps)
    expect(reads).toBe(1)
  })
})

describe('TODO 816: 索引のファイル名検索 (resolveLinkWithSearch)', () => {
  const repoA = (): string => join(home, 'git', 'repoA')
  const repoB = (): string => join(home, 'git', 'repoB')
  const deep = (root: string): string => join(root, 'uC3', 'Driver', 'Standard', 'src', 'GCC', 'DDR_CortexA_MMU.S')
  const libraryCopy = (): string => deep(join(home, 'Library', 'copy'))

  beforeAll(() => {
    for (const root of [repoA(), repoB()]) {
      mkdirSync(join(root, 'uC3', 'Driver', 'Standard', 'src', 'GCC'), { recursive: true })
      writeFileSync(deep(root), '; ddr\n')
    }
    // A copy of the same shape in an excluded place (`~/Library`). Even if a stale index hits it, the choke point drops it.
    mkdirSync(join(libraryCopy(), '..'), { recursive: true })
    writeFileSync(libraryCopy(), '; excluded copy\n')
    writeFileSync(join(home, 'git', 'lonely_name.c'), 'int x;\n')
  })

  const depsWith = (index: readonly string[], queries: string[] = []): LinkSearchDeps => ({
    gate: fsAccess,
    home,
    threadContext: (id) => (id === 't' ? { cwd: join(repoB(), 'uC3'), memoryDirs: [] } : null),
    searchByName: async (query) => {
      queries.push(query)
      return index
    }
  })

  it('部分パスの末尾が一致する 1 件なら開く (語は小文字、行は残す)', async () => {
    const queries: string[] = []
    const result = await resolveLinkWithSearch(
      { href: 'Standard/src/GCC/DDR_CortexA_MMU.S:7', threadId: null, baseUri: null },
      depsWith([deep(repoA()), join(home, 'git', 'x', 'DDR_CortexA_MMU.S')], queries)
    )
    expect(result).toEqual({ ok: true, uri: pathToUri(deep(repoA())), line: 7 })
    expect(queries).toEqual(['standard/src/gcc/ddr_cortexa_mmu.s'])
  })

  it('複数なら link-ambiguous と cwd に近い順の choices。除外の場所の当たりは落とす', async () => {
    const result = await resolveLinkWithSearch(
      { href: 'uC3/Driver/Standard/src/GCC/DDR_CortexA_MMU.S', threadId: 't', baseUri: null },
      depsWith([deep(repoA()), libraryCopy(), deep(repoB())])
    )
    expect(codeOf(result)).toBe('link-ambiguous')
    expect(result.ok ? null : parseReason(result.reason)?.params).toEqual({ name: 'DDR_CortexA_MMU.S', count: 2 })
    if (!result.ok) expect(result.choices).toEqual([{ uri: pathToUri(deep(repoB())) }, { uri: pathToUri(deep(repoA())) }])
  })

  it('末尾が一致しなければ名前で探し直す (名前が一致するものだけ)', async () => {
    const queries: string[] = []
    const result = await resolveLinkWithSearch(
      { href: 'wrong/dir/lonely_name.c', threadId: null, baseUri: null },
      {
        ...depsWith([], queries),
        searchByName: async (query) => {
          queries.push(query)
          return query === 'lonely_name.c' ? [join(home, 'git', 'lonely_name.c'), join(home, 'git', 'lonely_name.cpp')] : []
        }
      }
    )
    expect(result).toEqual({ ok: true, uri: pathToUri(join(home, 'git', 'lonely_name.c')) })
    expect(queries).toEqual(['wrong/dir/lonely_name.c', 'lonely_name.c'])
  })

  it('索引にも無ければ最初の結果 (link-not-found + 試したパス)。検索が投げても同じ', async () => {
    const result = await resolveLinkWithSearch(
      { href: 'no/such/file.txt', threadId: 't', baseUri: null },
      { ...depsWith([]), searchByName: async () => Promise.reject(new Error('index down')) }
    )
    expect(codeOf(result)).toBe('link-not-found')
    if (!result.ok) expect(result.tried).toEqual([join(repoB(), 'uC3', 'no', 'such', 'file.txt')])
  })

  it('絶対パス・cwd で解けたもの・資格情報の拒否は索引に聞かない', async () => {
    const queries: string[] = []
    const deps = depsWith([deep(repoA())], queries)
    await resolveLinkWithSearch({ href: join(home, 'nowhere', 'DDR_CortexA_MMU.S'), threadId: null, baseUri: null }, deps)
    await resolveLinkWithSearch({ href: 'DDR_CortexA_MMU.S', threadId: null, baseUri: pathToUri(deep(repoA())) }, deps)
    await resolveLinkWithSearch({ href: join(home, '.ssh', 'config'), threadId: null, baseUri: null }, deps)
    expect(queries).toEqual([])
  })

  it('探す形と並べ方', () => {
    expect(searchSegmentsOf('./a/b.c')).toEqual(['a', 'b.c'])
    expect(searchSegmentsOf('../../x/y.c')).toEqual(['x', 'y.c'])
    expect(searchSegmentsOf('..')).toBeNull()
    expect(rankByCwd(['/u/a/x/f.c', '/u/b/f.c', '/u/b/deep/f.c', '/v/f.c'], '/u/b/sub')).toEqual([
      '/u/b/f.c',
      '/u/b/deep/f.c',
      '/u/a/x/f.c',
      '/v/f.c'
    ])
  })
})

describe('第 44 波の code-review の直し (束 Y)', () => {
  it('1: リンクの探し直し (lane link) は利用者の検索を打ち切らず、打ち切られもしない', async () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), home, [home])
    // A fake that only checks when to stop: after everyone has started running, it asks whether to stop.
    const waiting: (() => void)[] = []
    const fake = {
      search: async (_query: string, _max: number, shouldStop: () => boolean) => {
        await new Promise<void>((done) => waiting.push(done))
        const cancelled = shouldStop()
        return { ids: [], total: 0, truncated: false, scanTruncated: false, cwd: null, caseSensitive: false, cancelled, tookMs: 0 }
      }
    }
    ;(indexer as unknown as { nameSearch: typeof fake }).nameSearch = fake
    try {
      const user = indexer.searchFiles('mmu', 10)
      const link = indexer.searchFiles('mmu.s', 10, null, null, 'link')
      const userNext = indexer.searchFiles('mmu.', 10)
      const linkLater = indexer.searchFiles('mmu.s', 10, null, null, 'link')
      while (waiting.length < 4) await new Promise((done) => setTimeout(done, 0))
      for (const done of waiting) done()
      const [a, b, c, d] = await Promise.all([user, link, userNext, linkLater])
      // User searches still let the later one win, as before. A link search has no effect on either.
      expect(a.cancelled).toBe(true)
      expect(b.cancelled).toBe(false)
      expect(c.cancelled).toBe(false)
      expect(d.cancelled).toBe(false)
    } finally {
      await indexer.stop()
      db.close()
    }
  })

  it('2: シェルの cd の先は、cwd で解けない相対リンクのときだけ読む (画像・cwd で解けるリンクでは読まない)', () => {
    let reads = 0
    const deps = {
      gate: fsAccess,
      home,
      threadContext: (id: string) =>
        id === 't'
          ? {
              cwd,
              memoryDirs: [],
              shellDirs: () => {
                reads += 1
                return [other]
              }
            }
          : null
    }
    expect(resolveLinkRequest({ href: '.vscode/settings.json', threadId: 't', baseUri: null }, deps).ok).toBe(true)
    expect(resolveLinkRequest({ href: './.vscode/settings.json#L3', threadId: 't', baseUri: null }, deps).ok).toBe(true)
    expect(reads).toBe(0)
    expect(resolveLinkRequest({ href: 'uC3/Driver/GCC/MMU.S', threadId: 't', baseUri: null }, deps).ok).toBe(true)
    expect(reads).toBe(1)
    // Even when nothing is found, it is one resolution, counted once.
    expect(codeOf(resolveLinkRequest({ href: 'nothing/here.png', threadId: 't', baseUri: null }, deps))).toBe('link-not-found')
    expect(reads).toBe(2)
  })

  it('3: 読み取りの関門が断った候補は handoff の関門を通るまで stat しない。他の利用者の home・許していないボリューム・autofs は handoff でも断る', () => {
    const touched: string[] = []
    const exists = (path: string): boolean => {
      touched.push(path)
      return false
    }
    const isDirectory = (path: string): boolean => {
      touched.push(path)
      return false
    }
    const context = { baseDir: cwd, memoryDirs: [] as readonly string[], home }
    const elsewhere = [
      '/Users/someone-else-aios-test/notes.md',
      '/Volumes/aios-test-not-allowed/a.txt',
      '/net/host/share/a.txt',
      join(home, '.ssh', 'config')
    ]
    for (const href of elsewhere) {
      const result = resolveLink(href, context, fsAccess, exists, isDirectory)
      expect(result.ok, href).toBe(false)
      if (!result.ok) expect(result.handoffUri, href).toBeUndefined()
    }
    expect(touched).toEqual([])
    const rules = createMacosExclusions(home)
    for (const path of elsewhere) {
      expect(classifyAccess(path, path.split('/').at(-1) ?? '', false, rules, 'handoff').excluded, path).toBe(true)
    }
    // An excluded place that passes (~/Library) is still stat'ed and reported as link-excluded, as before.
    const library = join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    expect(codeOf(resolveLink(library, context, fsAccess))).toBe('link-excluded')
  })

  it('4: editor.open は除外の場所を外部エディタに渡さない。帯だけの口 (handoff) は渡す。資格情報はどちらも渡さない', async () => {
    const opened: string[] = []
    const run: ExecFileLike = (_bin, args, _options, callback) => {
      opened.push(args.at(-1) ?? '')
      callback(null)
    }
    const { editor, handoff } = createEditorLaunchers({
      assertAllowed: (uri, asDirectory, kind) => fsAccess.assertAllowed(uri, asDirectory, kind),
      getEditorId: () => 'vscode',
      run
    })
    const library = join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    expect(await editor.open(pathToUri(library))).toBe(false)
    expect(await handoff.open(pathToUri(library))).toBe(true)
    expect(await editor.open(pathToUri(join(home, '.ssh', 'config')))).toBe(false)
    expect(await handoff.open(pathToUri(join(home, '.ssh', 'config')))).toBe(false)
    // Both open from an ordinary place.
    expect(await editor.open(pathToUri(join(cwd, '.vscode', 'settings.json')))).toBe(true)
    expect(opened).toEqual([library, join(cwd, '.vscode', 'settings.json')])
  })
})
