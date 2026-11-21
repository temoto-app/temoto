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

describe("TODO 808: the hand-off-only choke point ('handoff')", () => {
  const rules = (): ReturnType<typeof createMacosExclusions> => createMacosExclusions(home)
  const verdict = (path: string, isDirectory = false): boolean =>
    classifyAccess(path, path.split('/').at(-1) ?? '', isDirectory, rules(), 'handoff').excluded

  it('exclusions other than credentials (~/Library, OS areas, generated files, caches) pass', () => {
    expect(verdict(join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'))).toBe(false)
    expect(verdict('/etc/hosts')).toBe(false)
    expect(verdict('/usr/include/stdio.h')).toBe(false)
    expect(verdict(join(cwd, 'node_modules'), true)).toBe(false)
    expect(verdict(join(home, '.cache', 'x.log'))).toBe(false)
  })

  it('credential locations and file names (.netrc, id_rsa) do not pass; the read-only exception for auto memory .md does not apply either', () => {
    expect(verdict(join(home, '.ssh', 'config'))).toBe(true)
    expect(verdict(join(backendDir, '.credentials.json'))).toBe(true)
    expect(verdict(join(backendDir, 'projects', '-x', 'memory', 'MEMORY.md'))).toBe(true)
    expect(verdict(join(cwd, '.netrc'))).toBe(true)
    expect(verdict(join(cwd, 'id_rsa'))).toBe(true)
  })

  it('FsAccess: a symlink pointing at credentials fails the recheck of the real target (for both read and handoff)', () => {
    const uri = pathToUri(join(cwd, 'ssh-config-link'))
    expect(() => fsAccess.assertAllowed(uri, false, 'read')).toThrow()
    expect(() => fsAccess.assertAllowed(uri, false, 'handoff')).toThrow()
  })

  it('reveal in Finder: even if read refuses, handoff shows it; credentials are not shown', () => {
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

describe('TODO 808: next steps after link resolution', () => {
  const context = { baseDir: cwd, memoryDirs: [] as readonly string[], home: '' }
  const open = (href: string): LinkResolution => resolveLink(href, { ...context, baseDir: cwd, home }, fsAccess)

  it('`.vscode/settings.json` is not an exclusion: it opens if it is in cwd', () => {
    expect(open('.vscode/settings.json')).toEqual({ ok: true, uri: pathToUri(join(cwd, '.vscode', 'settings.json')) })
  })

  it('if it disappeared (a git diff deletion), link-not-found + the tried path + a term for searching by name', () => {
    const result = open('.vscode/gone.json')
    expect(codeOf(result)).toBe('link-not-found')
    if (!result.ok) {
      expect(result.tried).toEqual([join(cwd, '.vscode', 'gone.json')])
      expect(result.searchName).toBe('gone.json')
    }
  })

  it('a file that really exists in an excluded location is link-excluded + the URI to hand off (not put into the viewer)', () => {
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

  it('credentials are path-excluded as before, and no URI to hand off is attached', () => {
    for (const href of [join(home, '.ssh', 'config'), join(backendDir, '.credentials.json'), 'ssh-config-link']) {
      const result = open(href)
      expect(result.ok, href).toBe(false)
      if (!result.ok) {
        expect(result.handoffUri, href).toBeUndefined()
        expect(codeOf(result), href).not.toBe('link-excluded')
      }
    }
  })

  it('a file that does not exist in an excluded location (nonexistent) is not link-excluded', () => {
    const result = open(join(home, 'Library', 'nothing.json'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.handoffUri).toBeUndefined()
  })
})

describe("TODO 816: where the shell `cd`'d to (adapter/shell-dirs.ts)", () => {
  it('follows the destinations of cd / pushd in order (relative from the previous location, expanding ~ and $HOME)', () => {
    expect(cdTargetsOf('cd /a/b && ls', '/w', '/h').visited).toEqual(['/a/b'])
    expect(cdTargetsOf('cd /a; cd sub && make', '/w', '/h')).toEqual({ visited: ['/a', '/a/sub'], last: '/a/sub' })
    expect(cdTargetsOf('cd ~/git/x', '/w', '/h').visited).toEqual(['/h/git/x'])
    expect(cdTargetsOf('cd "$HOME/My Docs"', '/w', '/h').visited).toEqual(['/h/My Docs'])
    expect(cdTargetsOf("cd '/p q' && pushd ../r", '/w', '/h').visited).toEqual(['/p q', '/r'])
    expect(cdTargetsOf('cd /a\\ b', '/w', '/h').visited).toEqual(['/a b'])
    expect(cdTargetsOf('(cd /sub && ls)', '/w', '/h').visited).toEqual(['/sub'])
  })

  it('drops destinations not determined by form (cd -, no argument, variables, command substitution, things that are not the cd word)', () => {
    for (const command of ['cd -', 'cd', 'cd $DIR', 'cd "$(git rev-parse --show-toplevel)"', 'echo cd /x', 'abcd /x', 'cd `pwd`']) {
      expect(cdTargetsOf(command, '/w', '/h').visited, command).toEqual([])
    }
  })

  it('carries locations across calls and returns them newest first without duplicates (excluding cwd itself and non-shell tools)', () => {
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

  it('ThreadStore.recentToolUses returns names and arguments oldest first (skipping broken rows)', () => {
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

  it('resolveLinkRequest: a relative path not in cwd is resolved at the cd destination (an absolute path does not read the cd destination)', () => {
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

describe('TODO 816: index file name search (resolveLinkWithSearch)', () => {
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

  it('opens if exactly one item matches the tail of the partial path (term lowercase, the line is kept)', async () => {
    const queries: string[] = []
    const result = await resolveLinkWithSearch(
      { href: 'Standard/src/GCC/DDR_CortexA_MMU.S:7', threadId: null, baseUri: null },
      depsWith([deep(repoA()), join(home, 'git', 'x', 'DDR_CortexA_MMU.S')], queries)
    )
    expect(result).toEqual({ ok: true, uri: pathToUri(deep(repoA())), line: 7 })
    expect(queries).toEqual(['standard/src/gcc/ddr_cortexa_mmu.s'])
  })

  it('with several, link-ambiguous and choices in order of nearness to cwd; hits in excluded locations are dropped', async () => {
    const result = await resolveLinkWithSearch(
      { href: 'uC3/Driver/Standard/src/GCC/DDR_CortexA_MMU.S', threadId: 't', baseUri: null },
      depsWith([deep(repoA()), libraryCopy(), deep(repoB())])
    )
    expect(codeOf(result)).toBe('link-ambiguous')
    expect(result.ok ? null : parseReason(result.reason)?.params).toEqual({ name: 'DDR_CortexA_MMU.S', count: 2 })
    if (!result.ok) expect(result.choices).toEqual([{ uri: pathToUri(deep(repoB())) }, { uri: pathToUri(deep(repoA())) }])
  })

  it('if the tail does not match, searches again by name (only those whose name matches)', async () => {
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

  it('if it is not in the index either, the first result (link-not-found + the tried path); the same if the search throws', async () => {
    const result = await resolveLinkWithSearch(
      { href: 'no/such/file.txt', threadId: 't', baseUri: null },
      { ...depsWith([]), searchByName: async () => Promise.reject(new Error('index down')) }
    )
    expect(codeOf(result)).toBe('link-not-found')
    if (!result.ok) expect(result.tried).toEqual([join(repoB(), 'uC3', 'no', 'such', 'file.txt')])
  })

  it('absolute paths, things resolved in cwd and credential refusals do not ask the index', async () => {
    const queries: string[] = []
    const deps = depsWith([deep(repoA())], queries)
    await resolveLinkWithSearch({ href: join(home, 'nowhere', 'DDR_CortexA_MMU.S'), threadId: null, baseUri: null }, deps)
    await resolveLinkWithSearch({ href: 'DDR_CortexA_MMU.S', threadId: null, baseUri: pathToUri(deep(repoA())) }, deps)
    await resolveLinkWithSearch({ href: join(home, '.ssh', 'config'), threadId: null, baseUri: null }, deps)
    expect(queries).toEqual([])
  })

  it('search form and ordering', () => {
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

describe('wave 44 code-review fix (bundle Y)', () => {
  it("1: re-searching a link (lane link) neither cancels the user's search nor is cancelled by it", async () => {
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

  it("2: the shell's cd destination is read only for a relative link that cannot be resolved in cwd (not for images or links resolvable in cwd)", () => {
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

  it("3: a candidate refused by the read choke point is not stat'ed until it passes the handoff choke point; other users' homes, volumes not allowed and autofs are refused even by handoff", () => {
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

  it('4: editor.open does not hand excluded locations to the external editor; the band-only entry point (handoff) does; credentials are handed over by neither', async () => {
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
