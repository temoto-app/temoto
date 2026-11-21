/**
 * item 254: opens relative links in an answer (such as `memory/xxx.md`) in the viewer.
 *
 * - A **read-only exception** to the exclusion rules (`readOnlyIncludes` in `compat/backend-paths.json`, ARCHITECTURE.md 4.4.1):
 *   auto memory `.md` files can be read, but writes (FsAccess / ViewerBroker) and credential files are not let through.
 *   Even if a symlink placed inside the exception points at a credential, the re-check of the canonical path drops it.
 * - How a link is resolved (`src/main/fs/link.ts`): cwd → auto memory → not found, plus checks of line numbers, `#L42`, % encoding,
 *   `..`, schemes, and IPC values (the shape of item 86).
 * - Where auto memory lives (`adapter/memory.ts`): the encoded cwd, and the root of the main repo from a git worktree.
 *
 * The tree is built in a fake home (a temporary folder under the real home), since `tmpdir()` falls under the exclusions (a pitfall from Phase 1).
 * The real `~/.claude` (constraint 2) is not touched: the same shape is only created under the fake home.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { classifyAccess, createMacosExclusions, matchesReadOnlyInclude } from '../src/common/exclusions.js'
import { PathDenied, resolvePath } from '../src/common/fs-policy.js'
import { pathToUri } from '../src/common/uri.js'
import { AuditLog } from '../src/main/capability/audit.js'
import { CredentialStore } from '../src/main/capability/credentials.js'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import { FsAccess } from '../src/main/fs/access.js'
import { linkCandidates, resolveLink, resolveLinkRequest } from '../src/main/fs/link.js'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import { encodeProjectDir, gitRootsOf, memoryDirsFor } from '../src/main/session/adapter/memory.js'
import { checkSelection } from '../src/main/session/viewer-tools.js'
import { parseReason } from '../src/shared/reason.js'
import type { CapabilityName, ResolvedViewer } from '../src/shared/plugin.js'

let home: string
let dbDir: string
let db: Db
let audit: AuditLog
let broker: CapabilityBroker
let viewer: ViewerBroker
let fsAccess: FsAccess
/** The backend's credential directory (`credentialDirs[0]`) under the fake home. */
let backendDir: string
/** `transcriptDir` (projects). */
let projects: string
/** The working folder (the base for links). */
let cwd: string
/** The auto memory for that cwd. */
let memoryDir: string

const TEXT = 'test.text'

const expandHome = (value: string): string =>
  value.startsWith('~/') ? join(home, value.slice(2)) : value

function policy(id: string): PluginPolicy {
  return {
    id,
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false },
    consented: new Set<CapabilityName>(['fs'])
  }
}

function resolveViewer(): ResolvedViewer {
  return { pluginId: TEXT, name: 'txt', url: 'aios-plugin://test.text/v.html', editable: true, delivery: 'text' }
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(homedir(), '.aios-link-test-')))
  dbDir = mkdtempSync(join(homedir(), '.aios-link-db-'))
  const paths = loadBackendPaths()
  backendDir = expandHome(paths.credentialDirs[0] ?? '')
  projects = expandHome(paths.transcriptDir)
  cwd = join(home, 'work', 'proj')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(cwd, 'README.md'), '# readme\n')

  memoryDir = join(projects, encodeProjectDir(cwd), paths.memorySubdir ?? 'memory')
  mkdirSync(join(memoryDir, 'sub'), { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [診断](diagnosis.md)\n')
  writeFileSync(join(memoryDir, 'diagnosis.md'), '# 診断\n')
  writeFileSync(join(memoryDir, '日本語.md'), '# 日本語\n')
  writeFileSync(join(memoryDir, 'notes.txt'), 'not markdown\n')
  writeFileSync(join(memoryDir, 'sub', 'deep.md'), '# deep\n')
  // A credential file (outside projects), and a symlink inside memory that points at it.
  writeFileSync(join(backendDir, '.credentials.json'), '{"secret":"TOP"}')
  symlinkSync(join(backendDir, '.credentials.json'), join(memoryDir, 'evil.md'))
  // A .md directly under projects (outside memory).
  writeFileSync(join(projects, encodeProjectDir(cwd), 'loose.md'), '# loose\n')

  const rules = createMacosExclusions(home)
  db = new Database(join(dbDir, 'aios.db'))
  db.pragma(`key = '${'l'.repeat(64)}'`)
  runMigrations(db)
  audit = new AuditLog(db)
  broker = new CapabilityBroker({
    scope: { rules },
    audit,
    credentials: new CredentialStore(dbDir, {
      available: () => false,
      seal: () => Buffer.alloc(0),
      open: () => ''
    }),
    policyOf: (id) => (id === TEXT ? policy(id) : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
  viewer = new ViewerBroker({ broker, audit, scope: { rules }, resolveViewer })
  fsAccess = new FsAccess(home, [home])
})

afterAll(() => {
  audit.dispose()
  db.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

const memo = (...parts: string[]): string => join(memoryDir, ...parts)

describe('item 254: the read exception for exclusion rules (4.4.1)', () => {
  it('only an auto memory .md passes for read, and not for write', () => {
    const rules = createMacosExclusions(home)
    expect(classifyAccess(memo('diagnosis.md'), 'diagnosis.md', false, rules, 'read').excluded).toBe(false)
    expect(classifyAccess(memo('diagnosis.md'), 'diagnosis.md', false, rules, 'write')).toEqual({
      excluded: true,
      reason: 'credentials'
    })
  })

  it('anything not matching the shape is not let through even for read (credentials, memory itself, deep levels, non-.md, outside memory)', () => {
    const rules = createMacosExclusions(home)
    const denied = [
      join(backendDir, '.credentials.json'),
      join(backendDir, 'settings.json'),
      memoryDir,
      memo('sub', 'deep.md'),
      memo('notes.txt'),
      join(projects, encodeProjectDir(cwd), 'loose.md'),
      join(projects, '.hidden', 'memory', 'a.md'),
      join(projects, encodeProjectDir(cwd), 'memory', '.md')
    ]
    for (const path of denied) {
      const name = path.split('/').at(-1) ?? ''
      expect(classifyAccess(path, name, path === memoryDir, rules, 'read').excluded, path).toBe(true)
    }
    // A form containing a `..` segment does not match even before it is collapsed.
    expect(matchesReadOnlyInclude(`${memoryDir}/../memory/x.md`, rules)).toBe(false)
  })

  it('classify used by scan and index is unchanged (memory does not enter the index)', () => {
    const rules = createMacosExclusions(home)
    expect(classifyAccess(memo('MEMORY.md'), 'MEMORY.md', false, rules, 'write').excluded).toBe(true)
  })

  it('resolvePath: read passes, and the default (write) is excluded; a symlink pointing at credentials fails in canonical', () => {
    const rules = createMacosExclusions(home)
    expect(resolvePath(memo('diagnosis.md'), { rules }, false, 'read').exists).toBe(true)
    expect(() => resolvePath(memo('diagnosis.md'), { rules }, false)).toThrow(PathDenied)
    expect(() => resolvePath(memo('evil.md'), { rules }, false, 'read')).toThrow('symlink-escape')
  })

  it('FsAccess: assertAllowed passes only for read (denied with the write default)', () => {
    const uri = pathToUri(memo('diagnosis.md'))
    expect(fsAccess.assertAllowed(uri, false, 'read')).toBe(memo('diagnosis.md'))
    expect(() => fsAccess.assertAllowed(uri, false)).toThrow(PathDenied)
    expect(fsAccess.isViewable(memo('diagnosis.md'))).toBe(true)
    expect(fsAccess.isReferenceable(memo('diagnosis.md'))).toBe(false)
    expect(fsAccess.isViewable(join(backendDir, '.credentials.json'))).toBe(false)
  })

  it('viewer (via Broker): opens, reads, gets readOnly, and saving (ViewerBroker.write) is denied', async () => {
    const uri = pathToUri(memo('diagnosis.md'))
    expect(viewer.open(uri)).not.toBeNull()
    const read = await viewer.read(TEXT, uri)
    expect(read).toMatchObject({ kind: 'text', text: '# 診断\n', readOnly: true })
    const write = await viewer.write(TEXT, uri, 'overwritten', null)
    expect(write).toMatchObject({ ok: false, reason: 'denied' })
    expect(readFileSync(memo('diagnosis.md'), 'utf8')).toBe('# 診断\n')
    viewer.close(TEXT, uri)
  })

  it('viewer: an ordinary file does not get readOnly (it can be saved)', async () => {
    const uri = pathToUri(join(cwd, 'README.md'))
    viewer.open(uri)
    const read = await viewer.read(TEXT, uri)
    expect(read.kind).toBe('text')
    expect('readOnly' in read).toBe(false)
    viewer.close(TEXT, uri)
  })

  it('viewer: a credentials file and a memory symlink pointing at it cannot be opened', async () => {
    expect(viewer.open(pathToUri(join(backendDir, '.credentials.json')))).toBeNull()
    expect(viewer.open(pathToUri(memo('evil.md')))).toBeNull()
    expect((await viewer.read(TEXT, pathToUri(memo('evil.md')))).kind).toBe('error')
  })

  it('the selection check (item 97) also passes the read exception: a selection in memory can be attached to a send', () => {
    const accepted = checkSelection(
      { uri: pathToUri(memo('diagnosis.md')), text: '診断', fromLine: 1, toLine: 1, truncated: false },
      fsAccess
    )
    expect(accepted?.uri).toBe(pathToUri(memo('diagnosis.md')))
  })
})

describe('item 254: how links are resolved (cwd, auto memory, not found)', () => {
  const context = (): { baseDir: string; memoryDirs: readonly string[]; home: string } => ({
    baseDir: cwd,
    memoryDirs: [memoryDir],
    home
  })
  const open = (href: unknown): ReturnType<typeof resolveLink> => resolveLink(href, context(), fsAccess)
  const reasonOf = (result: ReturnType<typeof resolveLink>): string | null =>
    result.ok ? null : (parseReason(result.reason)?.code ?? result.reason)

  it('if it is under cwd, cwd (relative, ./, line numbers, #L42)', () => {
    const target = pathToUri(join(cwd, 'src', 'a.ts'))
    expect(open('src/a.ts')).toEqual({ ok: true, uri: target })
    expect(open('./src/a.ts')).toEqual({ ok: true, uri: target })
    expect(open('src/a.ts:42')).toEqual({ ok: true, uri: target, line: 42 })
    expect(open('src/a.ts:42:7')).toEqual({ ok: true, uri: target, line: 42, column: 7 })
    expect(open('src/a.ts#L42')).toEqual({ ok: true, uri: target, line: 42 })
    expect(open(`file://${join(cwd, 'src', 'a.ts')}#L3`)).toEqual({ ok: true, uri: target, line: 3 })
  })

  it('item 273: extracts the line (and column): `a.ts:42` / `a.ts#L42` / `a.ts:3:1` / `#L42C7` / `#L42-L50`', () => {
    const target = pathToUri(join(cwd, 'src', 'a.ts'))
    expect(open('src/a.ts:3:1')).toEqual({ ok: true, uri: target, line: 3, column: 1 })
    expect(open('./src/a.ts:42')).toEqual({ ok: true, uri: target, line: 42 })
    expect(open('src/a.ts#L42C7')).toEqual({ ok: true, uri: target, line: 42, column: 7 })
    expect(open('src/a.ts#L42-L50')).toEqual({ ok: true, uri: target, line: 42 })
    // A fragment with no line, or one that is not a line, opens with no line.
    expect(open('src/a.ts#top')).toEqual({ ok: true, uri: target })
    expect(open('src/a.ts#L')).toEqual({ ok: true, uri: target })
    // Line 0 and an overflowing line mean no line (the file still opens). If only the column is 0, the column is dropped.
    expect(open('src/a.ts:0')).toEqual({ ok: true, uri: target })
    expect(open(`src/a.ts:${'9'.repeat(20)}`)).toEqual({ ok: true, uri: target })
    expect(open('src/a.ts:5:0')).toEqual({ ok: true, uri: target, line: 5 })
    // The trailing `:42` comes first; `#L…` comes after it.
    expect(open('src/a.ts:42#L7')).toEqual({ ok: true, uri: target, line: 42 })
  })

  it('item 273: if a file whose name includes `:42` exists, that comes first and it is not taken as a line', () => {
    const odd = join(cwd, 'src', 'b.ts:42')
    writeFileSync(join(cwd, 'src', 'b.ts'), 'b\n')
    writeFileSync(odd, 'odd\n')
    try {
      expect(open('src/b.ts:42')).toEqual({ ok: true, uri: pathToUri(odd) })
      // For that file, the line comes from `#L…`.
      expect(open('src/b.ts:42#L2')).toEqual({ ok: true, uri: pathToUri(odd), line: 2 })
      // If no file with a partial name exists, the tail is the line.
      expect(open('src/b.ts:43')).toEqual({ ok: true, uri: pathToUri(join(cwd, 'src', 'b.ts')), line: 43 })
    } finally {
      rmSync(odd, { force: true })
      rmSync(join(cwd, 'src', 'b.ts'), { force: true })
    }
  })

  it('item 273: lines are also attached to auto memory candidates', () => {
    expect(open('memory/diagnosis.md:3')).toEqual({ ok: true, uri: pathToUri(memo('diagnosis.md')), line: 3 })
  })

  it('a `memory/x.md` not in cwd is auto memory (from the project folder)', () => {
    expect(open('memory/diagnosis.md')).toEqual({ ok: true, uri: pathToUri(memo('diagnosis.md')) })
  })

  it('a bare `x.md` is also auto memory (links in the MEMORY.md index)', () => {
    expect(open('diagnosis.md')).toEqual({ ok: true, uri: pathToUri(memo('diagnosis.md')) })
  })

  it("resolves % encoded Japanese names (the output of markdown-it's normalizeLink)", () => {
    const href = `memory/${encodeURIComponent('日本語')}.md`
    expect(open(href)).toEqual({ ok: true, uri: pathToUri(memo('日本語.md')) })
  })

  it('if cwd has the same name, cwd comes first', () => {
    mkdirSync(join(cwd, 'memory'), { recursive: true })
    writeFileSync(join(cwd, 'memory', 'diagnosis.md'), '# local\n')
    try {
      expect(open('memory/diagnosis.md')).toEqual({
        ok: true,
        uri: pathToUri(join(cwd, 'memory', 'diagnosis.md'))
      })
    } finally {
      rmSync(join(cwd, 'memory'), { recursive: true, force: true })
    }
  })

  it('if neither has it, link-not-found (only the name is attached)', () => {
    const result = open('memory/nothing-here.md')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(parseReason(result.reason)).toEqual({ code: 'link-not-found', params: { name: 'nothing-here.md' } })
    }
  })

  it('auto memory candidates are only inside memory; a form escaping to credentials via `..` is not even a candidate and does not open', () => {
    const candidates = linkCandidates('../../.credentials.json', { ...context(), baseDir: null }) ?? []
    expect(candidates).toEqual([])
    expect(open('../../.credentials.json').ok).toBe(false)
    expect(open(`../../${backendDir.slice(home.length + 1)}/.credentials.json`).ok).toBe(false)
    expect(open(`file://${join(backendDir, '.credentials.json')}`).ok).toBe(false)
  })

  it('`..` out of cwd is treated the same as an absolute path (opens if it passes the choke point)', () => {
    writeFileSync(join(home, 'work', 'outside.md'), '# out\n')
    expect(open('../outside.md')).toEqual({ ok: true, uri: pathToUri(join(home, 'work', 'outside.md')) })
  })

  it('if all candidates hit the choke point, its reason (path-excluded)', () => {
    writeFileSync(join(cwd, '.netrc'), 'machine x\n')
    expect(reasonOf(open('.netrc'))).toBe('path-excluded')
  })

  it('with a scheme, empty, NUL, too long, and non-strings are invalid-value', () => {
    for (const href of ['thread://abc', 'https://example.com/a.md', '', '#top', 'a\0b', 'x'.repeat(5000), 42]) {
      expect(reasonOf(open(href)), String(href).slice(0, 20)).toBe('invalid-value')
    }
  })

  it('`~/` is from home', () => {
    expect(open('~/work/proj/README.md')).toEqual({ ok: true, uri: pathToUri(join(cwd, 'README.md')) })
  })

  it('TODO 586: a folder path is directory: true (absolute, trailing /, relative, ~/); no line is attached', () => {
    const src = pathToUri(join(cwd, 'src'))
    expect(open(join(cwd, 'src'))).toEqual({ ok: true, uri: src, directory: true })
    expect(open(`${join(cwd, 'src')}/`)).toEqual({ ok: true, uri: src, directory: true })
    expect(open('src')).toEqual({ ok: true, uri: src, directory: true })
    expect(open('~/work/proj/src/')).toEqual({ ok: true, uri: src, directory: true })
    expect(open(`file://${join(cwd, 'src')}`)).toEqual({ ok: true, uri: src, directory: true })
    expect(open('src:42')).toEqual({ ok: true, uri: src, directory: true })
  })

  it('TODO 586: excluded folders (node_modules matches when applied as a folder) do not open', () => {
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true })
    try {
      // The reason is excluded (the 33rd proxy verification, 620-2: before, the first gate, applied as a file, was caught by the re-check of the real path,
      // so something that was not a symlink came out as symlink-escape).
      // (`node_modules/x` inside it is caught only by the name rule at the last stage, so it passes the gate as a file does, as before.)
      // TODO 808: an existing excluded folder gives `link-excluded` plus a URI to hand outside (reveal in Finder). It is not put into the viewer.
      for (const href of ['node_modules', join(cwd, 'node_modules')]) {
        const result = open(href)
        expect(result.ok, href).toBe(false)
        expect(reasonOf(result), href).toBe('link-excluded')
        if (!result.ok) {
          expect(result.handoffUri).toBe(pathToUri(join(cwd, 'node_modules')))
          expect(result.handoffDirectory).toBe(true)
        }
      }
    } finally {
      rmSync(join(cwd, 'node_modules'), { recursive: true, force: true })
    }
  })

  it('TODO 586 (code-review): candidates that failed when re-applied as folders are also counted (if all of them are, the reason for refusal)', () => {
    // A gate that passes as a file but drops when applied to a folder (the form where the name rule matches only with isDirectory).
    const gate = {
      assertAllowed: (uri: string, asDirectory: boolean): string => {
        if (asDirectory) throw new PathDenied('excluded')
        return uri
      }
    }
    const result = resolveLink(
      'deps',
      { baseDir: '/work/a', memoryDirs: ['/work/mem'], home: '/home/u' },
      gate,
      () => false,
      () => true
    )
    expect(reasonOf(result)).toBe('path-excluded')
  })
})

describe('item 254: validating IPC values (the shape of item 86)', () => {
  const deps = {
    gate: {
      assertAllowed: (uri: string, asDirectory: boolean, access?: 'read' | 'write') =>
        fsAccess.assertAllowed(uri, asDirectory, access)
    },
    home: '',
    threadContext: (threadId: string) =>
      threadId === 't1' ? { cwd: '', memoryDirs: [] as readonly string[] } : null
  }
  const withThread = {
    ...deps,
    threadContext: (threadId: string) => (threadId === 't1' ? { cwd, memoryDirs: [memoryDir] } : null)
  }
  const codeOf = (result: ReturnType<typeof resolveLinkRequest>): unknown =>
    result.ok ? null : parseReason(result.reason)

  it('a wrong shape gives invalid-value and the field name', () => {
    expect(codeOf(resolveLinkRequest(null, deps))).toEqual({ code: 'invalid-value', params: { field: 'input' } })
    expect(codeOf(resolveLinkRequest({ href: 1 }, deps))).toEqual({ code: 'invalid-value', params: { field: 'href' } })
    expect(codeOf(resolveLinkRequest({ href: 'a', threadId: 1 }, deps))).toEqual({
      code: 'invalid-value',
      params: { field: 'threadId' }
    })
    expect(codeOf(resolveLinkRequest({ href: 'a', baseUri: 1 }, deps))).toEqual({
      code: 'invalid-value',
      params: { field: 'baseUri' }
    })
  })

  it("resolves by the thread's cwd then auto memory; an unknown thread has no base", () => {
    expect(resolveLinkRequest({ href: 'memory/diagnosis.md', threadId: 't1', baseUri: null }, withThread)).toEqual({
      ok: true,
      uri: pathToUri(memo('diagnosis.md'))
    })
    expect(resolveLinkRequest({ href: 'src/a.ts', threadId: 'gone', baseUri: null }, withThread).ok).toBe(false)
  })

  it("the folder of baseUri (the .md open in the viewer) is the base; from memory's MEMORY.md to a neighboring .md", () => {
    expect(
      resolveLinkRequest(
        { href: 'diagnosis.md', threadId: null, baseUri: pathToUri(memo('MEMORY.md')) },
        withThread
      )
    ).toEqual({ ok: true, uri: pathToUri(memo('diagnosis.md')) })
    expect(
      resolveLinkRequest(
        { href: 'src/a.ts', threadId: null, baseUri: pathToUri(join(cwd, 'README.md')) },
        withThread
      )
    ).toEqual({ ok: true, uri: pathToUri(join(cwd, 'src', 'a.ts')) })
  })

  it('if baseUri hits the choke point, its reason', () => {
    const result = resolveLinkRequest(
      { href: 'x.md', threadId: null, baseUri: pathToUri(join(backendDir, 'settings.json')) },
      withThread
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('path-excluded')
  })
})

describe('item 254: the auto memory location (adapter/memory.ts)', () => {
  it("turns everything other than alphanumerics into - (the same as this machine's projects name)", () => {
    expect(encodeProjectDir('/Users/me/git/aios')).toBe('-Users-me-git-aios')
    expect(encodeProjectDir('/Users/me/.aios-ask-work-1Sp')).toBe('-Users-me--aios-ask-work-1Sp')
  })

  it("returns the cwd's memory if it exists; empty otherwise", () => {
    expect(memoryDirsFor(cwd, home)).toEqual([memoryDir])
    expect(memoryDirsFor(join(home, 'work'), home)).toEqual([])
    expect(memoryDirsFor('relative/path', home)).toEqual([])
  })

  it("from a git worktree, the root of the working tree and the main root (the main's memory is found)", () => {
    const main = join(home, 'repo')
    const wt = join(home, 'repo-wt')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    mkdirSync(join(wt, 'sub'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    expect(gitRootsOf(join(wt, 'sub'))).toEqual([wt, main])
    expect(gitRootsOf(main)).toEqual([main])

    const mainMemory = join(projects, encodeProjectDir(main), 'memory')
    mkdirSync(mainMemory, { recursive: true })
    expect(memoryDirsFor(join(wt, 'sub'), home)).toEqual([mainMemory])
  })
})
