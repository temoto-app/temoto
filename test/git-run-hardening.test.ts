/**
 * TODO 836: the calls to the main git (`src/main/git/run.ts`) must not run arbitrary commands from the repository's config.
 *
 * Plants `core.fsmonitor`, `filter.<name>.smudge`, `clean`, `process`, `core.pager`, `diff.external`, and `core.hooksPath`, plus hooks, in a temporary repository's `.git/config`, and confirms that the commands that create marker files **do not run through main's entry point**. With the same plants, plain git creates the markers (evidence that the plants work).
 * Uses the real git, only with a disposable repo in `os.tmpdir()`. Calls neither the model nor the CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_SAFETY_ARGS,
  clearFilterListCache,
  configSourceFiles,
  filterOverrides,
  gitEnv,
  runGit
} from '../src/main/git/run.js'
import { GitStatusReader } from '../src/main/git/status.js'
import { readFileAtRevision } from '../src/main/git/show.js'
import { recreateWorktree, runGitFile } from '../src/main/git/worktree-cleanup.js'
import { WORKTREES_PATH_SUFFIX } from '../src/common/exclusions.js'
import { pathToUri } from '../src/common/uri.js'
import { pathFromUri } from '../src/common/fs-policy.js'

let tmp: string
let repo: string
let markers: string

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }
  )
}

function hasGitLfs(): boolean {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A script that, when run, creates `markers/<name>` and returns standard input as it is (it also works as a filter). */
function marker(name: string): string {
  const path = join(tmp, `mark-${name}.sh`)
  writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\ncat\n`)
  chmodSync(path, 0o755)
  return path
}

function planted(): string[] {
  return readdirSync(markers).sort()
}

/** Dirties the stat of a working-tree file (so that status runs the clean filter). */
function dirty(path: string): void {
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aios-git-run-')))
  repo = join(tmp, 'repo')
  markers = join(tmp, 'markers')
  mkdirSync(repo)
  mkdirSync(markers)
  git('init', '-q')
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n*.bin filter=lfs\n')
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  writeFileSync(join(repo, 'big.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // Plant after the commit (so that a plain git commit does not run them).
  git('config', 'core.fsmonitor', marker('fsmonitor'))
  git('config', 'filter.evil.smudge', marker('smudge'))
  git('config', 'filter.evil.clean', marker('clean'))
  git('config', 'filter.evil.required', 'true')
  git('config', 'filter.lfs.process', marker('lfs-process'))
  git('config', 'filter.lfs.smudge', marker('lfs-smudge'))
  git('config', 'filter.lfs.required', 'true')
  git('config', 'core.pager', marker('pager'))
  git('config', 'diff.external', marker('ext-diff'))
  const hooks = join(tmp, 'hooks')
  mkdirSync(hooks)
  for (const hook of ['post-checkout', 'reference-transaction', 'pre-auto-gc']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${join(markers, `hook-${hook}`)}'\n`)
    chmodSync(join(hooks, hook), 0o755)
  }
  git('config', 'core.hooksPath', hooks)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('仕込みが素の git では効くこと (対照)', () => {
  it('素の git status は fsmonitor と clean フィルタを走らせる', () => {
    dirty(join(repo, 'a.txt'))
    // The planted `filter.lfs.process` does not answer the long-running process handshake, so when big.bin's stat looks dirty (whether racy-git judges it so depends on timing), plain git status fails. The failure is allowed, and only the markers are judged (fsmonitor runs first, and the clean of a.txt runs before big.bin).
    try {
      git('status', '--porcelain')
    } catch {
      // It is a control, so the exit code is not checked.
    }
    expect(planted()).toEqual(expect.arrayContaining(['fsmonitor', 'clean']))
  })

  it('素の git cat-file --filters は smudge を走らせる', () => {
    git('cat-file', '--filters', 'HEAD:./a.txt')
    expect(planted()).toContain('smudge')
  })
})

describe('本体の口は仕込みを走らせない (TODO 836)', () => {
  it('BottomBar の git status (GitStatusReader)', async () => {
    dirty(join(repo, 'a.txt'))
    dirty(join(repo, 'big.bin'))
    const reader = new GitStatusReader({ assertAllowed: (uri) => pathFromUri(uri), timeoutMs: 15_000 })
    const status = await reader.read(pathToUri(repo))
    expect(status).not.toBeNull()
    expect(status?.branch).toBe('main')
    expect(planted()).toEqual([])
  })

  it('openDiff の版の読み取り (cat-file --filters) は smudge を走らせず、LFS は pointer のまま', async () => {
    const text = await readFileAtRevision(join(repo, 'a.txt'), 'HEAD', { maxBytes: 1 << 20 })
    expect(text).toEqual({ ok: true, bytes: Buffer.from('hello\n') })
    const lfs = await readFileAtRevision(join(repo, 'big.bin'), 'HEAD', { maxBytes: 1 << 20 })
    expect(lfs.ok && lfs.bytes.toString('utf8')).toMatch(/^version https:\/\/git-lfs/)
    expect(planted()).toEqual([])
  })

  it('worktree の作成・status・削除とブランチの削除 (runGitFile) はフックもフィルタも走らせない', async () => {
    const wt = join(tmp, 'wt')
    expect((await runGitFile(['worktree', 'add', '-b', 'side', wt, 'HEAD'], repo)).ok).toBe(true)
    expect(existsSync(join(wt, 'a.txt'))).toBe(true)
    dirty(join(wt, 'a.txt'))
    expect((await runGitFile(['status', '--porcelain', '--ignore-submodules=all'], wt)).ok).toBe(true)
    expect((await runGitFile(['worktree', 'remove', '--force', wt], repo)).ok).toBe(true)
    expect((await runGitFile(['branch', '-D', 'side'], repo)).ok).toBe(true)
    expect(planted()).toEqual([])
  })

  it('pager と外部 diff は、diff 系を呼んでも走らない', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const out = await runGit(['diff', '--no-ext-diff', '--no-textconv'], { cwd: repo, timeoutMs: 10_000, maxBuffer: 1 << 20 })
    expect(out.error).toBeNull()
    expect(planted()).toEqual([])
  })

  it('828 の eol=crlf は残る (内蔵の変換はフィルタを止めても効く)', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt text eol=crlf\n')
    git('add', '.gitattributes')
    git('commit', '-q', '-m', 'crlf')
    const result = await readFileAtRevision(join(repo, 'a.txt'), 'HEAD', { maxBytes: 1 << 20 })
    expect(result).toEqual({ ok: true, bytes: Buffer.from('hello\r\n') })
  })
})

describe('固定の旗と環境 (純関数)', () => {
  it('旗に fsmonitor / hooksPath / pager の停止が入り、safe.directory は外さない', () => {
    const joined = GIT_SAFETY_ARGS.join(' ')
    expect(joined).toContain('core.fsmonitor=false')
    expect(joined).toContain('core.hooksPath=/dev/null')
    expect(joined).toContain('--no-pager')
    expect(joined).toContain('protocol.allow=never')
    expect(joined).not.toContain('safe.directory')
  })

  it('gitEnv は受け継いだ GIT_* を捨て、固定の値と上書きを足す', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_EXTERNAL_DIFF: 'evil', GIT_CONFIG_COUNT: '9' }, [['filter.a.smudge', '']])
    expect(env.PATH).toBe('/bin')
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'filter.a.smudge',
      GIT_CONFIG_VALUE_0: ''
    })
  })

  it('filterOverrides は driver ごとに smudge / clean / process を空にし required を外す (名前の . を保つ)', () => {
    const out = filterOverrides('filter.lfs.smudge\0filter.lfs.process\0filter.a.b.clean\0core.x\0')
    expect(out).toEqual([
      ['filter.lfs.smudge', ''],
      ['filter.lfs.clean', ''],
      ['filter.lfs.process', ''],
      ['filter.lfs.required', 'false'],
      ['filter.a.b.smudge', ''],
      ['filter.a.b.clean', ''],
      ['filter.a.b.process', ''],
      ['filter.a.b.required', 'false']
    ])
  })
})

describe('会話の worktree の復元だけはフィルタを許す (オーナー決定 2026-10-16)', () => {
  function worktreePath(name: string): string {
    return join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), name)
  }

  it('recreateWorktree の worktree add は smudge を走らせ、フックは走らせない / 読む口は走らせない', async () => {
    // Remove the planted lfs process, since it does not do the handshake, and keep only the evil filter for .txt.
    git('config', '--remove-section', 'filter.lfs')
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n')
    git('-c', 'filter.evil.clean=cat', '-c', 'filter.evil.required=false', 'commit', '-q', '-am', 'attrs')
    rmSync(markers, { recursive: true })
    mkdirSync(markers)
    const head = git('rev-parse', 'HEAD').trim()

    expect(await readFileAtRevision(join(repo, 'a.txt'), 'HEAD', { maxBytes: 1 << 20 })).toMatchObject({ ok: true })
    expect((await runGitFile(['status', '--porcelain'], repo)).ok).toBe(true)
    expect(planted()).toEqual([])

    const path = worktreePath('restored')
    expect(await recreateWorktree({ path, branch: 'worktree-restored', head, repoCwd: repo })).toBe('restored')
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    expect(planted()).toContain('smudge')
    expect(planted().filter((m) => m.startsWith('hook-') || m === 'fsmonitor' || m === 'pager')).toEqual([])
  })

  it.skipIf(!hasGitLfs())('実物の git-lfs: 復元は実体を取り出し、openDiff の版の読み取りと普通の worktree add は pointer のまま', async () => {
    const lfsRepo = join(tmp, 'lfs')
    mkdirSync(lfsRepo)
    const lg = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
        cwd: lfsRepo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
      })
    lg('init', '-q')
    lg('lfs', 'install', '--local', '--skip-repo')
    lg('config', 'filter.lfs.smudge', 'git-lfs smudge -- %f')
    lg('config', 'filter.lfs.process', 'git-lfs filter-process')
    lg('config', 'filter.lfs.clean', 'git-lfs clean -- %f')
    lg('config', 'filter.lfs.required', 'true')
    writeFileSync(join(lfsRepo, '.gitattributes'), '*.dat filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(lfsRepo, 'blob.dat'), 'REAL CONTENT\n')
    lg('add', '.')
    lg('commit', '-q', '-m', 'lfs')
    const head = lg('rev-parse', 'HEAD').trim()

    const shown = await readFileAtRevision(join(lfsRepo, 'blob.dat'), 'HEAD', { maxBytes: 1 << 20 })
    expect(shown.ok && shown.bytes.toString('utf8')).toMatch(/^version https:\/\/git-lfs/)

    const plain = join(tmp, 'plain-wt')
    expect((await runGitFile(['worktree', 'add', '--detach', plain, head], lfsRepo)).ok).toBe(true)
    expect(readFileSync(join(plain, 'blob.dat'), 'utf8')).toMatch(/^version https:\/\/git-lfs/)

    const path = join(lfsRepo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'lfs-restored')
    expect(await recreateWorktree({ path, branch: null, head, repoCwd: lfsRepo })).toBe('restored')
    expect(readFileSync(join(path, 'blob.dat'), 'utf8')).toBe('REAL CONTENT\n')
  })
})

describe('前段の期限と覚え方 (第 41 波 code-review)', () => {
  /** A wrapper that adds one line to the log on each call, waits `sleep` seconds, and then calls the real git. */
  function wrapper(sleepSec: number): { command: string; calls: () => string[] } {
    const log = join(tmp, `calls-${sleepSec}.log`)
    writeFileSync(log, '')
    const command = join(tmp, `git-wrap-${sleepSec}.sh`)
    writeFileSync(command, `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${sleepSec}\nexec git "$@"\n`)
    chmodSync(command, 0o755)
    return { command, calls: () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') }
  }

  beforeEach(() => {
    clearFilterListCache()
  })

  it('timeoutMs は前段と本番の合計の期限 (前段で使った分は本番に残らない)', async () => {
    const { command } = wrapper(1)
    const started = Date.now()
    const out = await runGit(['rev-parse', 'HEAD'], { cwd: repo, gitCommand: command, timeoutMs: 1500, maxBuffer: 1 << 20 })
    expect(out.error?.killed === true || out.error?.signal === 'SIGTERM').toBe(true)
    expect(Date.now() - started).toBeLessThan(1900)
  })

  it('設定が替わらなければ前段を覚えて 2 回目は git を 1 本だけ起こす', async () => {
    const { command, calls } = wrapper(0)
    const opts = { cwd: repo, gitCommand: command, timeoutMs: 10_000, maxBuffer: 1 << 20 }
    expect((await runGit(['rev-parse', 'HEAD'], opts)).error).toBeNull()
    expect((await runGit(['rev-parse', 'HEAD'], opts)).error).toBeNull()
    expect(calls().filter((c) => c.includes('--get-regexp'))).toHaveLength(1)
    expect(calls()).toHaveLength(3)
  })

  it('.git/config に filter を足したら読み直して止める (覚えた値で走らせない)', async () => {
    const { command, calls } = wrapper(0)
    const opts = { cwd: repo, gitCommand: command, timeoutMs: 10_000, maxBuffer: 1 << 20 }
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=fresh\n')
    git('add', '.gitattributes')
    git('commit', '-q', '-m', 'fresh')
    expect((await runGit(['rev-parse', 'HEAD'], opts)).error).toBeNull()
    git('config', 'filter.fresh.smudge', marker('fresh-smudge'))
    const out = await runGit(['cat-file', '--filters', 'HEAD:./a.txt'], opts)
    expect(out.error).toBeNull()
    expect(calls().filter((c) => c.includes('--get-regexp'))).toHaveLength(2)
    // (The fsmonitor and reference-transaction markers are created by the plain git commit of this test.)
    expect(planted()).not.toContain('fresh-smudge')
  })

  it('include のある設定は覚えない', async () => {
    const { command, calls } = wrapper(0)
    const opts = { cwd: repo, gitCommand: command, timeoutMs: 10_000, maxBuffer: 1 << 20 }
    git('config', 'include.path', join(tmp, 'nowhere.cfg'))
    expect((await runGit(['rev-parse', 'HEAD'], opts)).error).toBeNull()
    expect((await runGit(['rev-parse', 'HEAD'], opts)).error).toBeNull()
    expect(calls().filter((c) => c.includes('--get-regexp'))).toHaveLength(2)
  })

  it('configSourceFiles: 作業コピーの下から .git を見つけ、worktree は共通の config も挙げる / リポジトリの外・.git の中は null', async () => {
    mkdirSync(join(repo, 'sub'))
    const files = await configSourceFiles(join(repo, 'sub'), { HOME: '/home/x' })
    expect(files).toEqual(expect.arrayContaining(['/home/x/.gitconfig', join(repo, '.git', 'config')]))
    const wt = join(tmp, 'wt2')
    git('worktree', 'add', '-q', '--no-checkout', '--detach', wt, 'HEAD')
    const wtFiles = await configSourceFiles(wt, { HOME: '/home/x' })
    expect(wtFiles).toEqual(expect.arrayContaining([join(wt, '.git'), join(repo, '.git', 'config')]))
    expect(await configSourceFiles(markers, { HOME: '/home/x' })).toBeNull()
    expect(await configSourceFiles(join(repo, '.git'), { HOME: '/home/x' })).toBeNull()
  })
})
