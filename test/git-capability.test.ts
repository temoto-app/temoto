/**
 * TODO 834 stage 1: the Broker's read-only git capability (`src/main/capability/git.ts`, ARCHITECTURE 7.7 "execution" principle / 7.4.14).
 *
 * - argv is built by main only, with the fixed safe flags; revs / paths that could turn into flags, object syntax or pathspec magic are refused.
 * - the 3 steps (declaration -> consent -> the folder grant) and the file policy: excluded paths are neither listed nor read, a symlink yields its
 *   target text, a `.git` file pointing at another repository is refused, a subfolder grant sees only that subfolder.
 * - a repository's planted `.git/config` (fsmonitor, filters, textconv, diff.external, pager) runs nothing through these operations.
 * Uses the real git with disposable repositories under `~/.aios-test` (the Broker's real exclusion rules apply there). Calls neither the model nor the CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CapabilityBroker, type PluginPolicy } from '../src/main/capability/broker.js'
import type { AuditLog } from '../src/main/capability/audit.js'
import type { CredentialStore } from '../src/main/capability/credentials.js'
import {
  GIT_READ_PREFIX,
  diffArgs,
  logArgs,
  parseLog,
  parseNameStatusZ,
  parseStatusV2,
  showArgs,
  statusArgs
} from '../src/main/capability/git.js'
import { parseBrokerRequest } from '../src/main/capability/request-schema.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import { GIT_SAFETY_ARGS, clearFilterListCache, gitEnv, runGit } from '../src/main/git/run.js'
import { pathToUri } from '../src/common/uri.js'
import type { CapabilityName } from '../src/shared/plugin.js'
import {
  GIT_INDEX,
  GIT_WORKTREE,
  MAX_GIT_SHOW_BYTES,
  fileUriOfGitRepository,
  gitRepositoryUri,
  isGitRelativePath,
  type GitDiffResult,
  type GitLogResult,
  type GitShowResult,
  type GitStatusResult
} from '../src/shared/plugin-git.js'
import { makeTestDir, removeTestDir, testExclusions } from './helpers/tmp.js'

const PLUGIN = 'test.git'
const rules = testExclusions(homedir())

let tmp: string
let repo: string
let markers: string
let audits: { op: string; target: string | null; decision: string; reason: string | null }[]
let currentPolicy: PluginPolicy | null

function policy(overrides: { gitRead?: boolean; consented?: CapabilityName[] } = {}): PluginPolicy {
  return {
    id: PLUGIN,
    declared: { credentials: [], networkHosts: [], fsRead: [], fsWrite: [], indexSources: [], ui: false, gitRead: overrides.gitRead ?? true },
    consented: new Set<CapabilityName>(overrides.consented ?? ['git', 'fs'])
  }
}

function makeBroker(): CapabilityBroker {
  const audit = {
    record: (entry: { op: string; target: string | null; decision: string; reason: string | null }) => {
      audits.push({ op: entry.op, target: entry.target, decision: entry.decision, reason: entry.reason })
    }
  } as unknown as AuditLog
  return new CapabilityBroker({
    scope: { rules },
    audit,
    credentials: {} as CredentialStore,
    policyOf: (id) => (id === PLUGIN ? currentPolicy : null),
    index: { put: async () => undefined, remove: async () => undefined },
    notify: () => undefined
  })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }
  )
}

function marker(name: string): string {
  const path = join(tmp, `mark-${name}.sh`)
  writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\ncat\n`)
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => {
  clearFilterListCache()
  tmp = realpathSync(makeTestDir('git-cap'))
  repo = join(tmp, 'repo')
  markers = join(tmp, 'markers')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(markers)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'old.txt'), 'renamed body\n'.repeat(20))
  writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\n')
  writeFileSync(join(repo, '.netrc'), 'machine example.invalid password SECRET\n')
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x01, 0x00, 0x02]))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  git(repo, 'commit', '-q', '-am', 'second')
  // Working state: a staged change, an unstaged change, a staged rename, an untracked file, a changed credential file.
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nstaged\n')
  git(repo, 'add', 'a.txt')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nstaged\nworktree\n')
  git(repo, 'mv', 'old.txt', 'new.txt')
  writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\nbuzz\n')
  writeFileSync(join(repo, 'sub', 'u.txt'), 'untracked\n')
  writeFileSync(join(repo, '.netrc'), 'machine example.invalid password CHANGED\n')
  audits = []
  currentPolicy = policy()
})

afterEach(() => {
  removeTestDir(tmp)
})

const status = (broker: CapabilityBroker, folder = repo): Promise<GitStatusResult> =>
  broker.handle(PLUGIN, { capability: 'git', op: 'status', repo: pathToUri(folder) }) as Promise<GitStatusResult>
const show = (broker: CapabilityBroker, rev: string, path: string, folder = repo): Promise<GitShowResult> =>
  broker.handle(PLUGIN, { capability: 'git', op: 'show', repo: pathToUri(folder), rev, path }) as Promise<GitShowResult>

describe('argv is built by main with the fixed flags (TODO 834)', () => {
  it('every operation starts with the read prefix and ends its pathspec after --', () => {
    for (const args of [statusArgs(), diffArgs({}), diffArgs({ staged: true }), diffArgs({ from: 'HEAD~1', to: 'HEAD' }), logArgs({}).args]) {
      expect(args.slice(0, GIT_READ_PREFIX.length)).toEqual([...GIT_READ_PREFIX])
      expect(args.slice(-2)).toEqual(['--', '.'])
    }
    expect(GIT_READ_PREFIX).toContain('--literal-pathspecs')
    expect(GIT_READ_PREFIX).toContain('safe.bareRepository=explicit')
    // runGit puts its own safety flags first (fsmonitor / hooks / pager / transfers).
    expect(GIT_SAFETY_ARGS).toContain('core.fsmonitor=false')
  })

  it('diff and log never start external diff or textconv, and never write a file', () => {
    for (const args of [diffArgs({ from: 'HEAD' }), logArgs({}).args]) {
      expect(args).toContain('--no-ext-diff')
      expect(args).toContain('--no-textconv')
      expect(args.some((arg) => arg.startsWith('--output'))).toBe(false)
    }
  })

  it('builds the object names of show from validated values only', () => {
    expect(showArgs('HEAD', 'sub/b.txt').slice(-3)).toEqual(['cat-file', '--filters', 'HEAD:sub/b.txt'])
    expect(showArgs(GIT_INDEX, 'sub/b.txt').slice(-1)).toEqual([':sub/b.txt'])
    expect(() => showArgs('-p', 'x')).toThrow('invalid-rev')
    expect(() => showArgs('HEAD:x', 'y')).toThrow('invalid-rev')
    // `:/text` would be a commit-message search.
    expect(() => showArgs(GIT_INDEX, '/etc/passwd')).toThrow()
  })

  it('refuses rev combinations the schema refuses too', () => {
    expect(() => diffArgs({ to: 'HEAD' })).toThrow('invalid-rev')
    expect(() => diffArgs({ from: 'HEAD', to: 'HEAD~1', staged: true })).toThrow('invalid-rev')
    expect(() => diffArgs({ from: '--output=/tmp/x' })).toThrow('invalid-rev')
    expect(() => logArgs({ rev: '--all' })).toThrow('invalid-rev')
  })
})

describe('request shapes (invalid-request before any decision)', () => {
  const repoUri = 'file:///Users/someone/repo'
  it('refuses flags, object syntax, NUL and newlines in revs', () => {
    for (const rev of ['-p', '--output=/tmp/x', 'HEAD:secret', 'HEAD\nx', 'HEAD\0', ':/msg', '']) {
      expect(parseBrokerRequest({ capability: 'git', op: 'diff', repo: repoUri, from: rev })).toBeNull()
      expect(parseBrokerRequest({ capability: 'git', op: 'show', repo: repoUri, rev, path: 'a.txt' })).toBeNull()
    }
  })

  it('refuses absolute, parent, .git, control-character and flag-like paths', () => {
    for (const path of ['/etc/passwd', '../x', 'a/../../x', '.git/config', 'sub/.GIT/config', 'a\nb', 'a\0b', '-x', '', 'a//b', './a']) {
      expect(isGitRelativePath(path)).toBe(false)
      expect(parseBrokerRequest({ capability: 'git', op: 'show', repo: repoUri, rev: 'HEAD', path })).toBeNull()
    }
    expect(parseBrokerRequest({ capability: 'git', op: 'show', repo: repoUri, rev: GIT_WORKTREE, path: 'sub/a b.txt' })).not.toBeNull()
  })

  it('refuses `to` without `from`, `staged` with `to`, unknown keys and an over-large log', () => {
    expect(parseBrokerRequest({ capability: 'git', op: 'diff', repo: repoUri, to: 'HEAD' })).toBeNull()
    expect(parseBrokerRequest({ capability: 'git', op: 'diff', repo: repoUri, from: 'HEAD', to: 'HEAD~1', staged: true })).toBeNull()
    expect(parseBrokerRequest({ capability: 'git', op: 'status', repo: repoUri, args: ['--exec'] })).toBeNull()
    expect(parseBrokerRequest({ capability: 'git', op: 'log', repo: repoUri, limit: 10_000 })).toBeNull()
    expect(parseBrokerRequest({ capability: 'git', op: 'exec', repo: repoUri })).toBeNull()
    expect(parseBrokerRequest({ capability: 'git', op: 'diff', repo: repoUri, from: 'HEAD~1', staged: true })).not.toBeNull()
  })

  it('converts between the Source Control URI and the folder URI', () => {
    expect(gitRepositoryUri('file:///a/b')).toBe('aios-git:///a/b')
    expect(fileUriOfGitRepository('aios-git:///a/b')).toBe('file:///a/b')
    expect(fileUriOfGitRepository('aios-git:relative')).toBeNull()
    expect(gitRepositoryUri('https://x')).toBeNull()
  })
})

describe('parsers', () => {
  it('reads porcelain v2 records (rename, untracked, unmerged, nested repository)', () => {
    const out = [
      '# branch.oid ' + 'a'.repeat(40),
      '# branch.head main',
      `1 M. N... 100644 100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} dir/with space.txt`,
      `2 R. N... 100644 100644 100644 ${'1'.repeat(40)} ${'1'.repeat(40)} R100 new.txt`,
      'old.txt',
      `u UU N... 100644 100644 100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} ${'3'.repeat(40)} c.txt`,
      '? u.txt',
      '? nested/',
      ''
    ].join('\0')
    const parsed = parseStatusV2(out)
    expect(parsed.branch).toBe('main')
    expect(parsed.staged).toEqual([
      { path: 'dir/with space.txt', status: 'modified' },
      { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' }
    ])
    expect(parsed.unstaged).toEqual([
      { path: 'c.txt', status: 'conflicted' },
      { path: 'u.txt', status: 'untracked' }
    ])
  })

  it('reads name-status -z and the log format', () => {
    expect(parseNameStatusZ('M\0a.txt\0R090\0old\0new\0D\0gone\0')).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'new', status: 'renamed', oldPath: 'old' },
      { path: 'gone', status: 'deleted' }
    ])
    const hash = 'b'.repeat(40)
    expect(parseLog(`${hash}\x1f${'c'.repeat(40)}\x1fAuthor\x1f1700000000\x1fsubject\x1e\nnot a record\x1e`)).toEqual([
      { hash, parents: ['c'.repeat(40)], author: 'Author', time: 1_700_000_000_000, subject: 'subject' }
    ])
  })
})

describe('declaration -> consent -> folder grant (7.7)', () => {
  it('refuses a folder that was not opened in the Source Control view, and after it was closed', async () => {
    const broker = makeBroker()
    await expect(status(broker)).rejects.toThrow('no-grant')
    broker.grantRepository(PLUGIN, gitRepositoryUri(pathToUri(repo)) ?? '')
    await expect(status(broker)).resolves.toMatchObject({ branch: 'main' })
    broker.revokeRepository(PLUGIN, gitRepositoryUri(pathToUri(repo)) ?? '')
    await expect(status(broker)).rejects.toThrow('no-grant')
    expect(audits.at(-1)).toMatchObject({ op: 'status', decision: 'deny', reason: 'no-grant', target: pathToUri(repo) })
  })

  it('refuses without consent, and without the declaration (the grant is refused too)', async () => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    currentPolicy = policy({ consented: ['fs'] })
    await expect(status(broker)).rejects.toThrow('not-consented')
    expect(() => broker.grantRepository(PLUGIN, pathToUri(join(repo, 'sub')))).toThrow('not-consented')
    currentPolicy = policy({ gitRead: false })
    await expect(status(broker)).rejects.toThrow('not-declared')
    expect(() => broker.grantRepository(PLUGIN, pathToUri(join(repo, 'sub')))).toThrow('not-declared')
  })

  it('refuses to grant an excluded folder or a file', () => {
    const broker = makeBroker()
    mkdirSync(join(repo, 'node_modules'))
    expect(() => broker.grantRepository(PLUGIN, pathToUri(join(repo, 'node_modules')))).toThrow('excluded')
    expect(() => broker.grantRepository(PLUGIN, pathToUri(join(repo, 'a.txt')))).toThrow('not-a-directory')
  })
})

describe('opening the Source Control view grants the folder (ViewerBroker)', () => {
  it('open grants, read has no body, close revokes; another extension resolved for the scheme gets nothing', async () => {
    const broker = makeBroker()
    const viewer = { pluginId: PLUGIN, name: 'Git', url: 'aios-plugin://test.git/v/index.html', editable: false, delivery: 'text' as const }
    const viewers = new ViewerBroker({ broker, audit: {} as never, scope: { rules }, resolveViewer: () => viewer })
    const uri = gitRepositoryUri(pathToUri(repo)) ?? ''
    expect(viewers.open(uri)).toEqual(viewer)
    await expect(status(broker)).resolves.toMatchObject({ branch: 'main' })
    expect(await viewers.read(PLUGIN, uri)).toMatchObject({ kind: 'text', text: '', readOnly: true })
    expect(await viewers.read('other.plugin', uri)).toEqual({ kind: 'error', message: 'not allowed' })
    viewers.close(PLUGIN, uri)
    await expect(status(broker)).rejects.toThrow('no-grant')
    // A folder that fails the policy opens nothing.
    mkdirSync(join(repo, 'node_modules'))
    expect(viewers.open(gitRepositoryUri(pathToUri(join(repo, 'node_modules'))) ?? '')).toBeNull()
  })
})

describe('status / diff / show / log on a granted folder', () => {
  it('lists staged and unstaged changes relative to the folder, and hides excluded files', async () => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    const result = await status(broker)
    expect(result.staged).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', status: 'modified' },
        { path: 'new.txt', status: 'renamed', oldPath: 'old.txt' }
      ])
    )
    expect(result.unstaged).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', status: 'modified' },
        { path: 'sub/b.txt', status: 'modified' },
        { path: 'sub/u.txt', status: 'untracked' }
      ])
    )
    // `.netrc` matches the credential rule: neither listed nor readable through git.
    expect([...result.staged, ...result.unstaged].some((change) => change.path.includes('netrc'))).toBe(false)
    expect(result.hidden).toBe(1)
    await expect(show(broker, 'HEAD', '.netrc')).rejects.toThrow('excluded')
    await expect(show(broker, GIT_WORKTREE, '.netrc')).rejects.toThrow('excluded')
  })

  it('reads HEAD, the index and the working tree of one file', async () => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    expect(await show(broker, 'HEAD', 'a.txt')).toMatchObject({ kind: 'text', text: 'one\ntwo\n' })
    expect(await show(broker, GIT_INDEX, 'a.txt')).toMatchObject({ kind: 'text', text: 'one\ntwo\nstaged\n' })
    expect(await show(broker, GIT_WORKTREE, 'a.txt')).toMatchObject({ kind: 'text', text: 'one\ntwo\nstaged\nworktree\n' })
    expect(await show(broker, 'HEAD~1', 'a.txt')).toMatchObject({ kind: 'text', text: 'one\n' })
    expect(await show(broker, 'HEAD', 'new.txt')).toEqual({ kind: 'missing' })
    expect(await show(broker, GIT_WORKTREE, 'nope.txt')).toEqual({ kind: 'missing' })
    expect(await show(broker, 'HEAD', 'bin.dat')).toEqual({ kind: 'binary', size: 3 })
    expect(audits.at(-1)).toMatchObject({ op: 'show', decision: 'allow', target: pathToUri(join(repo, 'bin.dat')) })
  })

  it('does not return contents over the limit', async () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(MAX_GIT_SHOW_BYTES + 1))
    git(repo, 'add', 'big.txt')
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    expect(await show(broker, GIT_INDEX, 'big.txt')).toEqual({ kind: 'too-large', limit: MAX_GIT_SHOW_BYTES })
    expect(await show(broker, GIT_WORKTREE, 'big.txt')).toEqual({ kind: 'too-large', limit: MAX_GIT_SHOW_BYTES })
  })

  it('compares two versions and lists commits', async () => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    const diff = (await broker.handle(PLUGIN, { capability: 'git', op: 'diff', repo: pathToUri(repo), from: 'HEAD~1', to: 'HEAD' })) as GitDiffResult
    expect(diff.files).toEqual([{ path: 'a.txt', status: 'modified' }])
    const staged = (await broker.handle(PLUGIN, { capability: 'git', op: 'diff', repo: pathToUri(repo), staged: true })) as GitDiffResult
    expect(staged.files).toEqual(expect.arrayContaining([{ path: 'new.txt', status: 'renamed', oldPath: 'old.txt' }]))
    const log = (await broker.handle(PLUGIN, { capability: 'git', op: 'log', repo: pathToUri(repo), limit: 1 })) as GitLogResult
    expect(log.commits.map((commit) => commit.subject)).toEqual(['second'])
    expect(log.more).toBe(true)
    await expect(broker.handle(PLUGIN, { capability: 'git', op: 'diff', repo: pathToUri(repo), from: 'no-such-branch' })).rejects.toThrow('invalid-rev')
  })

  it('a subfolder grant sees only that subfolder, with paths relative to it', async () => {
    const broker = makeBroker()
    const sub = join(repo, 'sub')
    broker.grantRepository(PLUGIN, pathToUri(sub))
    const result = await status(broker, sub)
    expect(result.staged).toEqual([])
    expect(result.unstaged).toEqual(expect.arrayContaining([{ path: 'b.txt', status: 'modified' }, { path: 'u.txt', status: 'untracked' }]))
    expect(result.unstaged.some((change) => change.path.includes('a.txt'))).toBe(false)
    expect(await show(broker, 'HEAD', 'b.txt', sub)).toMatchObject({ kind: 'text', text: 'bee\n' })
    // The parent folder is not reachable through the subfolder's grant.
    await expect(status(broker, repo)).rejects.toThrow('no-grant')
  })

  it('a symlink in the working tree yields its target text, not what it points at', async () => {
    const outside = join(tmp, 'outside-secret.txt')
    writeFileSync(outside, 'OUTSIDE SECRET\n')
    symlinkSync(outside, join(repo, 'link.txt'))
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    const result = await show(broker, GIT_WORKTREE, 'link.txt')
    expect(result).toEqual({ kind: 'text', text: outside, size: Buffer.byteLength(outside) })
  })

  it('a folder whose parent link points outside the grant is refused', async () => {
    const elsewhere = join(tmp, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'x.txt'), 'elsewhere\n')
    symlinkSync(elsewhere, join(repo, 'linkdir'))
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    await expect(show(broker, GIT_WORKTREE, 'linkdir/x.txt')).rejects.toThrow('symlink-escape')
  })
})

describe('repository shapes', () => {
  it('refuses a folder that is not a repository', async () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(plain))
    // `tmp` is under `~/.aios-test`; a home that is itself a repository would make this a subfolder, so accept either refusal.
    await expect(status(broker, plain)).rejects.toThrow(/not-a-repo|unsupported-repo/)
  })

  it('refuses a .git file that points at another repository', async () => {
    const other = join(tmp, 'other')
    mkdirSync(other)
    writeFileSync(join(other, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(other))
    await expect(status(broker, other)).rejects.toThrow('unsupported-repo')
    await expect(show(broker, 'HEAD', 'a.txt', other)).rejects.toThrow('unsupported-repo')
  })

  it('accepts a linked worktree of the repository', async () => {
    git(repo, 'commit', '-q', '-m', 'third')
    const linked = join(tmp, 'linked')
    git(repo, 'worktree', 'add', '-q', linked)
    writeFileSync(join(linked, 'a.txt'), 'linked change\n')
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(linked))
    const result = await status(broker, linked)
    expect(result.unstaged).toEqual(expect.arrayContaining([{ path: 'a.txt', status: 'modified' }]))
  })
})

describe('a planted file in the git dir cannot block the read (review, TODO 834)', () => {
  it('refuses a linked worktree whose gitdir file is a FIFO, without waiting for a writer', async () => {
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'for the worktree')
    const linked = join(tmp, 'linked-fifo')
    git(repo, 'worktree', 'add', '-q', linked)
    const back = join(repo, '.git', 'worktrees', 'linked-fifo', 'gitdir')
    rmSync(back)
    execFileSync('mkfifo', [back])
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(linked))
    await expect(status(broker, linked)).rejects.toThrow('unsupported-repo')
  })
})

describe('a planted .git/config runs nothing (TODO 836 / 834)', () => {
  it('fsmonitor, filters, textconv, external diff and the pager do not run', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\n')
    git(repo, 'add', '.gitattributes')
    git(repo, 'config', 'core.fsmonitor', marker('fsmonitor'))
    git(repo, 'config', 'filter.evil.smudge', marker('smudge'))
    git(repo, 'config', 'filter.evil.clean', marker('clean'))
    git(repo, 'config', 'filter.evil.required', 'true')
    git(repo, 'config', 'diff.evil.textconv', marker('textconv'))
    git(repo, 'config', 'diff.external', marker('ext-diff'))
    git(repo, 'config', 'core.pager', marker('pager'))
    // Make the working tree look stat-dirty so status would run the clean filter.
    writeFileSync(join(repo, 'sub', 'b.txt'), 'bee\nbuzz\nagain\n')
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    await status(broker)
    await broker.handle(PLUGIN, { capability: 'git', op: 'diff', repo: pathToUri(repo), from: 'HEAD~1' })
    await broker.handle(PLUGIN, { capability: 'git', op: 'diff', repo: pathToUri(repo), staged: true })
    await show(broker, 'HEAD', 'a.txt')
    await show(broker, GIT_INDEX, 'a.txt')
    await broker.handle(PLUGIN, { capability: 'git', op: 'log', repo: pathToUri(repo) })
    expect(readdirSync(markers)).toEqual([])
    // Control: the same plants do run under plain git (so the assertion above is not vacuous).
    git(repo, 'diff', 'HEAD~1', '--', 'a.txt')
    git(repo, 'cat-file', '--filters', 'HEAD:a.txt')
    expect(readdirSync(markers)).toEqual(expect.arrayContaining(['ext-diff', 'smudge']))
  })
})

describe('the repository data must be the folder\'s own (review, TODO 834)', () => {
  const grant = (folder = repo): CapabilityBroker => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(folder))
    return broker
  }

  it('GIT_ALTERNATE_OBJECT_DIRECTORIES and the other GIT_* are dropped from the environment', () => {
    const env = gitEnv({ PATH: '/usr/bin', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects', GIT_OBJECT_DIRECTORY: '/x' })
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined()
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined()
  })

  it('refuses an objects directory that is a symlink to another repository', async () => {
    const other = join(tmp, 'other-repo')
    mkdirSync(other)
    git(other, 'init', '-q')
    rmSync(join(repo, '.git', 'objects'), { recursive: true })
    symlinkSync(join(other, '.git', 'objects'), join(repo, '.git', 'objects'))
    await expect(status(grant())).rejects.toThrow('unsupported-repo')
  })

  it('refuses a refs directory that is a symlink, and a symlink directly under objects', async () => {
    const other = join(tmp, 'other-refs')
    mkdirSync(other)
    git(other, 'init', '-q')
    const refs = join(repo, '.git', 'refs')
    renameSync(refs, join(tmp, 'refs-moved'))
    symlinkSync(join(other, '.git', 'refs'), refs)
    await expect(status(grant())).rejects.toThrow('unsupported-repo')
    rmSync(refs)
    renameSync(join(tmp, 'refs-moved'), refs)
    await expect(status(grant())).resolves.toBeDefined()
    symlinkSync(join(other, '.git', 'objects', 'pack'), join(repo, '.git', 'objects', 'pack-link'))
    await expect(status(grant())).rejects.toThrow('unsupported-repo')
  })

  it('refuses a symlink deeper in objects or refs (a pack, a loose object, a ref file)', async () => {
    const other = join(tmp, 'other-deep')
    mkdirSync(other)
    const pack = join(repo, '.git', 'objects', 'pack')
    mkdirSync(pack, { recursive: true })
    const planted = [join(pack, 'pack-planted.pack'), join(repo, '.git', 'objects', 'ab', 'cdef'), join(repo, '.git', 'refs', 'heads', 'planted')]
    mkdirSync(join(repo, '.git', 'objects', 'ab'), { recursive: true })
    for (const link of planted) {
      symlinkSync(join(other, 'elsewhere'), link)
      await expect(status(grant())).rejects.toThrow('unsupported-repo')
      rmSync(link)
      await expect(status(grant())).resolves.toBeDefined()
    }
  })

  it('refuses a non-empty alternates file (and accepts an empty one)', async () => {
    const info = join(repo, '.git', 'objects', 'info')
    mkdirSync(info, { recursive: true })
    writeFileSync(join(info, 'alternates'), '')
    await expect(status(grant())).resolves.toBeDefined()
    writeFileSync(join(info, 'alternates'), `${join(tmp, 'other', '.git', 'objects')}\n`)
    await expect(status(grant())).rejects.toThrow('unsupported-repo')
    rmSync(join(info, 'alternates'))
    writeFileSync(join(info, 'http-alternates'), 'https://example.invalid/objects\n')
    await expect(status(grant())).rejects.toThrow('unsupported-repo')
  })

  it('refuses a HEAD that is a symlink', async () => {
    const head = join(repo, '.git', 'HEAD')
    const target = join(tmp, 'HEAD-elsewhere')
    writeFileSync(target, 'ref: refs/heads/main\n')
    rmSync(head)
    symlinkSync(target, head)
    // git itself may already refuse a symlinked HEAD (`not-a-repo`); either way the repository is not read.
    await expect(status(grant())).rejects.toThrow(/not-a-repo|unsupported-repo/)
  })

  it('accepts an ordinary repository and a linked worktree (checked on the common dir)', async () => {
    await expect(status(grant())).resolves.toBeDefined()
    git(repo, 'commit', '-q', '-m', 'third')
    const linked = join(tmp, 'linked-own')
    git(repo, 'worktree', 'add', '-q', linked)
    await expect(status(grant(linked), linked)).resolves.toBeDefined()
    // Borrowed objects through the common dir are refused for the linked worktree too.
    const info = join(repo, '.git', 'objects', 'info')
    mkdirSync(info, { recursive: true })
    writeFileSync(join(info, 'alternates'), '/somewhere/else/objects\n')
    await expect(status(grant(linked), linked)).rejects.toThrow('unsupported-repo')
  })
})

describe('a subfolder with a decomposed (NFD) name (review, TODO 834)', () => {
  it('lists the changes of a folder whose name has a voiced kana / accent in NFD', async () => {
    const name = `${'ド'.normalize('NFD')}-é`.normalize('NFD')
    const sub = join(repo, name)
    mkdirSync(sub)
    writeFileSync(join(sub, 'n.txt'), 'new\n')
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(sub))
    const result = await status(broker, sub)
    expect(result.unstaged).toEqual(expect.arrayContaining([{ path: 'n.txt', status: 'untracked' }]))
    expect(await show(broker, GIT_WORKTREE, 'n.txt', sub)).toMatchObject({ kind: 'text', text: 'new\n' })
  })
})

describe('show of a bad version (review, TODO 834)', () => {
  it('a range is invalid-rev, not an empty side; a path missing at a valid version is still missing', async () => {
    const broker = makeBroker()
    broker.grantRepository(PLUGIN, pathToUri(repo))
    await expect(show(broker, 'HEAD~1..HEAD', 'a.txt')).rejects.toThrow('invalid-rev')
    await expect(show(broker, 'no-such-branch', 'a.txt')).rejects.toThrow('invalid-rev')
    expect(await show(broker, 'HEAD', 'does-not-exist.txt')).toEqual({ kind: 'missing' })
  })
})

describe('concurrent git runs queue instead of failing (review, TODO 834)', () => {
  it('ten parallel reads of one extension all finish with at most 4 running at once', async () => {
    let running = 0
    let peak = 0
    const audit = { record: () => undefined } as unknown as AuditLog
    const broker = new CapabilityBroker({
      scope: { rules },
      audit,
      credentials: {} as CredentialStore,
      policyOf: (id) => (id === PLUGIN ? currentPolicy : null),
      index: { put: async () => undefined, remove: async () => undefined },
      notify: () => undefined,
      git: {
        run: async (args, options) => {
          running += 1
          peak = Math.max(peak, running)
          try {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return await runGit(args, options)
          } finally {
            running -= 1
          }
        }
      }
    })
    broker.grantRepository(PLUGIN, pathToUri(repo))
    const results = await Promise.all(Array.from({ length: 10 }, () => status(broker)))
    expect(results).toHaveLength(10)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
