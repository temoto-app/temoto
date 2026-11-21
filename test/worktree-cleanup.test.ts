/**
 * TODO 633 stage 1 (wave 33 bundle A): cleanup of the worktrees that a conversation made (`src/main/git/worktree-cleanup.ts`).
 * **Uses the real git, and only a disposable repo under `os.tmpdir()`** (it does not touch the aios repository or the worktrees of other real repos).
 * Neither the model nor the CLI is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupWorktree,
  branchHasCommits,
  cleanupWorktreeOutcome,
  credentialGuard,
  exists,
  hasPreciousIgnored,
  parseGitlinks,
  parseIgnoredEntries,
  recreateWorktree,
  isDirectWorktreeOf,
  lockPid,
  parseWorktreeList
} from '../src/main/git/worktree-cleanup.js'
import { WORKTREES_PATH_SUFFIX } from '../src/common/exclusions.js'
import { isRebuildableIgnoredPath } from '../src/common/rebuildable-ignored.js'
import { chmodSync } from 'node:fs'

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

let tmp: string
let repo: string

/** Creates a worktree at `<repo><location>/<name>` on the branch `worktree-<name>` (same form as the CLI's `--worktree`). */
function addWorktree(name: string, root = repo): string {
  const path = join(root, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), name)
  git(root, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path)
  return path
}

function branches(): string[] {
  return git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aios-wt-cleanup-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'alpha\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('cleanupWorktree (TODO 633 段 1、実物の git・使い捨ての repo)', () => {
  it('変更も commit も無い worktree はブランチごと消す', async () => {
    const path = addWorktree('clean')
    expect(await cleanupWorktree({ path, branch: 'worktree-clean', repoCwd: repo })).toBe('removed')
    expect(existsSync(path)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('未追跡のファイル・commit していない変更があれば残す', async () => {
    const untracked = addWorktree('untracked')
    writeFileSync(join(untracked, 'new.txt'), 'x\n')
    expect(await cleanupWorktree({ path: untracked, branch: 'worktree-untracked', repoCwd: repo })).toBe('changes')
    const modified = addWorktree('modified')
    writeFileSync(join(modified, 'a.txt'), 'changed\n')
    expect(await cleanupWorktree({ path: modified, branch: 'worktree-modified', repoCwd: repo })).toBe('changes')
    expect(existsSync(untracked)).toBe(true)
    expect(existsSync(modified)).toBe(true)
  })

  it('中身のある submodule を持つ worktree は (子の中を見ずに) changes で残す (第 41 波 code-review)', async () => {
    // Commits a gitlink (mode 160000) to the main repo. Even without .gitmodules, the gitlink is in the index.
    const child = join(repo, 'sub')
    mkdirSync(child)
    git(child, 'init', '-q')
    writeFileSync(join(child, 's.txt'), 's\n')
    git(child, 'add', 's.txt')
    git(child, 'commit', '-qm', 's')
    git(repo, 'add', 'sub')
    git(repo, 'commit', '-qm', 'gitlink')
    // A submodule that was not initialized (an empty directory) has no work, so it is not made into changes.
    const bare = addWorktree('uninit')
    expect(await cleanupWorktree({ path: bare, branch: 'worktree-uninit', repoCwd: repo })).not.toBe('changes')
    // Uncommitted work inside a populated submodule is not visible to status (--ignore-submodules=all) -> it is kept as changes.
    const path = addWorktree('populated')
    const sub = join(path, 'sub')
    mkdirSync(sub, { recursive: true })
    git(sub, 'init', '-q')
    writeFileSync(join(sub, 'work.txt'), 'uncommitted\n')
    expect(await cleanupWorktree({ path, branch: 'worktree-populated', repoCwd: repo })).toBe('changes')
    expect(existsSync(join(sub, 'work.txt'))).toBe(true)
  })

  it('parseGitlinks は mode 160000 の項目だけを取り出す', () => {
    const text = '100644 aaaa 0\ta.txt\u0000160000 bbbb 0\tvendor/lib\u0000120000 cccc 0\tlink\u0000'
    expect(parseGitlinks(text)).toEqual(['vendor/lib'])
  })

  it('上流の無いブランチで本体に無い commit があれば「未 push」で残す', async () => {
    const path = addWorktree('ahead')
    writeFileSync(join(path, 'b.txt'), 'b\n')
    git(path, 'add', 'b.txt')
    git(path, 'commit', '-qm', 'b')
    expect(await cleanupWorktree({ path, branch: 'worktree-ahead', repoCwd: repo })).toBe('unpushed')
    expect(existsSync(path)).toBe(true)
    expect(branches()).toContain('worktree-ahead')
  })

  it('上流があれば上流より先の commit で見る (push 済みなら消す)', async () => {
    const remote = join(tmp, 'remote.git')
    git(tmp, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')
    const pushed = addWorktree('pushed')
    writeFileSync(join(pushed, 'c.txt'), 'c\n')
    git(pushed, 'add', 'c.txt')
    git(pushed, 'commit', '-qm', 'c')
    git(pushed, 'push', '-q', '-u', 'origin', 'worktree-pushed')
    expect(await cleanupWorktree({ path: pushed, branch: 'worktree-pushed', repoCwd: repo })).toBe('removed')
    expect(existsSync(pushed)).toBe(false)
    const notPushed = addWorktree('later')
    git(notPushed, 'push', '-q', '-u', 'origin', 'worktree-later')
    writeFileSync(join(notPushed, 'd.txt'), 'd\n')
    git(notPushed, 'add', 'd.txt')
    git(notPushed, 'commit', '-qm', 'd')
    expect(await cleanupWorktree({ path: notPushed, branch: 'worktree-later', repoCwd: repo })).toBe('unpushed')
  })

  it('ロックは、理由の pid が死んでいれば外して消す。生きていれば残す', async () => {
    const dead = addWorktree('dead-lock')
    git(repo, 'worktree', 'lock', '--reason', 'backend session dead-lock (pid 999999 start 1)', dead)
    expect(
      await cleanupWorktree({ path: dead, branch: 'worktree-dead-lock', repoCwd: repo }, { isAlive: () => false })
    ).toBe('removed')
    expect(existsSync(dead)).toBe(false)
    const live = addWorktree('live-lock')
    git(repo, 'worktree', 'lock', '--reason', `backend session live-lock (pid ${process.pid} start 1)`, live)
    expect(await cleanupWorktree({ path: live, branch: 'worktree-live-lock', repoCwd: repo })).toBe('locked')
    expect(existsSync(live)).toBe(true)
  })

  it('symlink を挟んだ綴り (macOS の /var → /private/var) の cwd とパスでも同じものとして消す', async () => {
    const path = addWorktree('via-link')
    const link = join(tmp, 'link')
    execFileSync('ln', ['-s', repo, link])
    const viaLink = join(link, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'via-link')
    expect(await cleanupWorktree({ path: viaLink, branch: 'worktree-via-link', repoCwd: link })).toBe('removed')
    expect(existsSync(path)).toBe(false)
  })

  it('記録したパスが推定で外れていても、ブランチで引ければ消す', async () => {
    const path = addWorktree('agent-a1')
    const guessed = join(repo, 'elsewhere', 'agent-a1')
    expect(await cleanupWorktree({ path: guessed, branch: 'worktree-agent-a1', repoCwd: repo })).toBe('removed')
    expect(existsSync(path)).toBe(false)
  })

  it('既に無い worktree は gone (ブランチには触らない)', async () => {
    const path = addWorktree('gone')
    git(repo, 'worktree', 'remove', path)
    expect(await cleanupWorktree({ path, branch: 'worktree-gone', repoCwd: repo })).toBe('gone')
    expect(branches()).toContain('worktree-gone')
  })

  // TODO 734 (spike 32): an isolated child that was not committed has its worktree and branch deleted by the CLI itself when it ends.
  it('CLI が worktree もブランチも消した後 (734) でも gone で、何度呼んでも壊れない', async () => {
    const path = addWorktree('agent-cli')
    git(repo, 'worktree', 'remove', path)
    git(repo, 'branch', '-D', 'worktree-agent-cli')
    const target = { path, branch: 'worktree-agent-cli', repoCwd: repo }
    expect(await cleanupWorktree(target)).toBe('gone')
    expect(await cleanupWorktree(target)).toBe('gone')
    expect(branches()).toEqual(['main'])
  })

  it('ディレクトリだけ消え git の記録が残っている (prune 前) 場合も gone', async () => {
    const path = addWorktree('agent-stale')
    rmSync(path, { recursive: true, force: true })
    expect(await cleanupWorktree({ path, branch: 'worktree-agent-stale', repoCwd: repo })).toBe('gone')
  })

  it('置き場の外の worktree (git は知っていても) と本体そのものは消さない', async () => {
    const outside = join(tmp, 'outside')
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-outside', outside)
    expect(await cleanupWorktree({ path: outside, branch: 'worktree-outside', repoCwd: repo })).toBe('unsafe')
    expect(existsSync(outside)).toBe(true)
    // The main repo (the first item) is looked up neither by path nor by branch.
    expect(await cleanupWorktree({ path: repo, branch: 'main', repoCwd: repo })).toBe('unsafe')
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    // Also removes two levels below the location.
    const nested = join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'x', 'y')
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-nested', nested)
    expect(await cleanupWorktree({ path: nested, branch: 'worktree-nested', repoCwd: repo })).toBe('unsafe')
    expect(existsSync(nested)).toBe(true)
  })

  it('資格情報のディレクトリの下の置き場は消さない (制約 2)', async () => {
    // Makes the fake home itself the repo: a worktree is `<home><location>/…`, i.e. under the credentials directory.
    const home = join(tmp, 'home')
    mkdirSync(home)
    git(home, 'init', '-q')
    writeFileSync(join(home, 'h.txt'), 'h\n')
    git(home, 'add', 'h.txt')
    git(home, 'commit', '-qm', 'h')
    const path = addWorktree('cred', home)
    const guard = credentialGuard(home)
    expect(guard(path)).toBe(true)
    expect(await cleanupWorktree({ path, branch: 'worktree-cred', repoCwd: home }, { isProtected: guard })).toBe(
      'unsafe'
    )
    expect(existsSync(path)).toBe(true)
  })

  // TODO 748 (owner decision (a1)): `status` does not show ignored files, and `worktree remove` removes them along with the ignored files.
  // If there are ignored files outside the table of locations that can be recreated, they are kept as `ignored`.
  describe('git の無視ファイル (TODO 748)', () => {
    beforeEach(() => {
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n__pycache__/\n.DS_Store\n.env\n*.log\nsecrets/\n')
      git(repo, 'add', '.gitignore')
      git(repo, 'commit', '-qm', 'ignore')
    })

    it('作り直せる置き場 (node_modules / __pycache__ / .DS_Store) の無視ファイルだけなら消す', async () => {
      const path = addWorktree('rebuildable')
      mkdirSync(join(path, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(path, 'node_modules', 'pkg', 'index.js'), 'x\n')
      mkdirSync(join(path, 'packages', 'a', 'node_modules'), { recursive: true })
      writeFileSync(join(path, 'packages', 'a', 'node_modules', 'm.js'), 'x\n')
      mkdirSync(join(path, 'src', '__pycache__'), { recursive: true })
      writeFileSync(join(path, 'src', '__pycache__', 'm.pyc'), 'x\n')
      writeFileSync(join(path, '.DS_Store'), 'x\n')
      expect(await cleanupWorktree({ path, branch: 'worktree-rebuildable', repoCwd: repo })).toBe('removed')
      expect(existsSync(path)).toBe(false)
    })

    it('.env・ignore にしたメモ・ignore にしたディレクトリがあれば ignored で残す (ブランチも残る)', async () => {
      const env = addWorktree('env')
      writeFileSync(join(env, '.env'), 'TOKEN=1\n')
      expect(await cleanupWorktree({ path: env, branch: 'worktree-env', repoCwd: repo })).toBe('ignored')
      expect(existsSync(join(env, '.env'))).toBe(true)
      expect(branches()).toContain('worktree-env')

      const memo = addWorktree('memo')
      mkdirSync(join(memo, 'node_modules'), { recursive: true })
      writeFileSync(join(memo, 'node_modules', 'a.js'), 'x\n')
      writeFileSync(join(memo, 'notes.log'), 'memo\n')
      expect(await cleanupWorktree({ path: memo, branch: 'worktree-memo', repoCwd: repo })).toBe('ignored')

      const dir = addWorktree('dir')
      mkdirSync(join(dir, 'secrets'), { recursive: true })
      writeFileSync(join(dir, 'secrets', 'key'), 'k\n')
      const outcome = await cleanupWorktreeOutcome({ path: dir, branch: 'worktree-dir', repoCwd: repo })
      expect(outcome).toEqual({ verdict: 'ignored', head: null, branch: null })
      expect(existsSync(join(dir, 'secrets', 'key'))).toBe(true)
    })

    it('変更があれば無視ファイルより先に changes', async () => {
      const path = addWorktree('both')
      writeFileSync(join(path, '.env'), 'TOKEN=1\n')
      writeFileSync(join(path, 'new.txt'), 'x\n')
      expect(await cleanupWorktree({ path, branch: 'worktree-both', repoCwd: repo })).toBe('changes')
    })
  })

  it('git の repo でない cwd・無い cwd は failed (何も消さない)', async () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    expect(await cleanupWorktree({ path: join(plain, 'x'), branch: null, repoCwd: plain })).toBe('failed')
    expect(await cleanupWorktree({ path: join(tmp, 'none', 'x'), branch: null, repoCwd: join(tmp, 'none') })).toBe(
      'failed'
    )
  })
})

describe('worktree-cleanup の純関数', () => {
  it('parseWorktreeList: 先頭が本体、branch・locked を読む', () => {
    const text = [
      'worktree /r',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /r/.wt/x',
      'HEAD bbb',
      'branch refs/heads/worktree-x',
      'locked backend session x (pid 12 start 3)',
      '',
      'worktree /r/.wt/y',
      'HEAD ccc',
      'detached',
      'locked',
      ''
    ].join('\n')
    expect(parseWorktreeList(text)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main', locked: null, main: true },
      { path: '/r/.wt/x', head: 'bbb', branch: 'worktree-x', locked: 'backend session x (pid 12 start 3)', main: false },
      { path: '/r/.wt/y', head: 'ccc', branch: null, locked: '', main: false }
    ])
  })

  it('parseIgnoredEntries: -z の出力から !! の項目だけ (変更の項目・空は捨てる)', () => {
    expect(parseIgnoredEntries('!! .env\0?? new.txt\0!! node_modules/\0 M a.txt\0!! a b/c d.log\0')).toEqual([
      '.env',
      'node_modules/',
      'a b/c d.log'
    ])
    expect(parseIgnoredEntries('')).toEqual([])
  })

  it('isRebuildableIgnoredPath / hasPreciousIgnored: 段の名前で見る。ファイル名が置き場の名前でも当てない', () => {
    expect(isRebuildableIgnoredPath('node_modules/')).toBe(true)
    expect(isRebuildableIgnoredPath('packages/a/node_modules/')).toBe(true)
    expect(isRebuildableIgnoredPath('dist/app.js')).toBe(true)
    expect(isRebuildableIgnoredPath('src/__pycache__/m.pyc')).toBe(true)
    expect(isRebuildableIgnoredPath('target/')).toBe(true)
    expect(isRebuildableIgnoredPath('docs/.DS_Store')).toBe(true)
    expect(isRebuildableIgnoredPath('.env')).toBe(false)
    expect(isRebuildableIgnoredPath('config/local.json')).toBe(false)
    expect(isRebuildableIgnoredPath('build')).toBe(false)
    expect(isRebuildableIgnoredPath('secrets/')).toBe(false)
    expect(isRebuildableIgnoredPath('')).toBe(false)
    expect(hasPreciousIgnored(['node_modules/', 'dist/'])).toBe(false)
    expect(hasPreciousIgnored(['node_modules/', '.env'])).toBe(true)
    expect(hasPreciousIgnored([])).toBe(false)
  })

  it('lockPid', () => {
    expect(lockPid('backend session x (pid 12 start 3)')).toBe(12)
    expect(lockPid('')).toBeNull()
    expect(lockPid('by hand')).toBeNull()
  })

  it('isDirectWorktreeOf: 置き場の直下 1 段だけ・正規化済みのパスだけ', () => {
    expect(isDirectWorktreeOf('/r/.wt/x', '/r', '/.wt')).toBe(true)
    expect(isDirectWorktreeOf('/r/.wt/x/y', '/r', '/.wt')).toBe(false)
    expect(isDirectWorktreeOf('/r/.wt/../x', '/r', '/.wt')).toBe(false)
    expect(isDirectWorktreeOf('/r/.wt', '/r', '/.wt')).toBe(false)
    expect(isDirectWorktreeOf('x/.wt/a', 'x', '/.wt')).toBe(false)
  })
})

// code-review fix (TODO 633, owner decision 2026-10-11): when a conversation is restored, the cleaned-up worktree is recreated at the same path and
// with the same branch name, from the HEAD at the time it was cleaned up.
describe('recreateWorktree (TODO 633、実物の git・使い捨ての repo)', () => {
  const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD').trim()

  it('片付けで消した worktree を、同じパス・同じブランチ名・同じ HEAD で作り直す', async () => {
    const path = addWorktree('again')
    const before = head(path)
    const outcome = await cleanupWorktreeOutcome({ path, branch: 'worktree-again', repoCwd: repo })
    expect(outcome).toEqual({ verdict: 'removed', head: before, branch: 'worktree-again' })
    expect(existsSync(path)).toBe(false)
    expect(branches()).toEqual(['main'])

    expect(await recreateWorktree({ path, branch: 'worktree-again', head: before, repoCwd: repo })).toBe('restored')
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    expect(head(path)).toBe(before)
    expect(git(path, 'branch', '--show-current').trim()).toBe('worktree-again')
    // Calling it again returns the same thing (it is already a git worktree): restored.
    expect(await recreateWorktree({ path, branch: 'worktree-again', head: before, repoCwd: repo })).toBe('restored')
  })

  it('ブランチが残っていればそれを使う。ブランチが無ければ detached でも作れる', async () => {
    const base = head(repo)
    git(repo, 'branch', 'worktree-kept')
    const kept = join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'kept')
    expect(await recreateWorktree({ path: kept, branch: 'worktree-kept', head: base, repoCwd: repo })).toBe('restored')
    expect(git(kept, 'branch', '--show-current').trim()).toBe('worktree-kept')
    const detached = join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'detached')
    expect(await recreateWorktree({ path: detached, branch: null, head: base, repoCwd: repo })).toBe('restored')
    expect(head(detached)).toBe(base)
  })

  it('置き場の外・資格情報の下・おかしな HEAD やブランチ名は作らず、git の知らない同じパスがあれば触らない', async () => {
    const base = head(repo)
    const outside = join(tmp, 'outside')
    expect(await recreateWorktree({ path: outside, branch: 'x', head: base, repoCwd: repo })).toBe('unsafe')
    expect(existsSync(outside)).toBe(false)
    const place = join(repo, ...WORKTREES_PATH_SUFFIX.split('/').filter(Boolean), 'p')
    expect(await recreateWorktree({ path: place, branch: '-x', head: base, repoCwd: repo })).toBe('unsafe')
    expect(await recreateWorktree({ path: place, branch: 'x', head: '--orphan', repoCwd: repo })).toBe('unsafe')
    expect(
      await recreateWorktree({ path: place, branch: 'x', head: base, repoCwd: repo }, { isProtected: () => true })
    ).toBe('unsafe')
    mkdirSync(place, { recursive: true })
    writeFileSync(join(place, 'mine.txt'), 'keep\n')
    expect(await recreateWorktree({ path: place, branch: 'x', head: base, repoCwd: repo })).toBe('failed')
    expect(existsSync(join(place, 'mine.txt'))).toBe(true)
    expect(branches()).toEqual(['main'])
  })
})

// code-review (TODO 714): `exists()` used to treat every `stat` failure as 'does not exist'. Only ENOENT / ENOTDIR
// count as 'does not exist'; anything else (EACCES, an external volume that is not mounted) is 'unknown', so it is conservatively kept as 'exists'
// (the caller falls back to unsafe / failed, and does not turn an unconfirmed case into gone / forget).
describe('exists (TODO 714 の code-review): ENOENT / ENOTDIR だけを「無い」と見る', () => {
  it('ENOENT (無い) は false', async () => {
    expect(await exists(join(tmp, 'never-created'))).toBe(false)
  })

  it('ENOTDIR (途中の階層がディレクトリでない) は false', async () => {
    const file = join(tmp, 'plain-file')
    writeFileSync(file, 'x')
    expect(await exists(join(file, 'child'))).toBe(false)
  })

  it('EACCES (読めない) は「分からない」ので true のまま', async () => {
    const locked = join(tmp, 'locked-dir')
    mkdirSync(locked)
    const target = join(locked, 'inside')
    writeFileSync(target, 'x')
    chmodSync(locked, 0o000)
    try {
      // Running as root, there is no EACCES and it is read as is (permissions are ignored). In that case it becomes 'exists' as usual, which goes against the test's intent
      // (assuming EACCES), but in either case treating it as 'exists' (true) is the correct result.
      expect(await exists(target)).toBe(true)
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  it('/Volumes/<名前> がマウントされていなければ、下のパスの ENOENT は「分からない」ので true', async () => {
    const unmounted = '/Volumes/aios-code-review-714-no-such-volume/some/worktree'
    expect(await exists(unmounted)).toBe(true)
  })
})

describe('branchHasCommits (第 37 波 code-review 6、実物の git)', () => {
  it('本体の head に無い commit があるブランチだけ真。会話が worktree に移っていても基準は本体の head', async () => {
    const clean = addWorktree('clean')
    expect(await branchHasCommits(repo, 'worktree-clean')).toBe(false)
    const ahead = addWorktree('ahead')
    writeFileSync(join(ahead, 'b.txt'), 'b\n')
    git(ahead, 'add', 'b.txt')
    git(ahead, 'commit', '-qm', 'b')
    expect(await branchHasCommits(repo, 'worktree-ahead')).toBe(true)
    // Even if the conversation's cwd is in a worktree that has been committed (ahead), the base remains the main repo's head.
    // If the base were the cwd's HEAD, a child cut from ahead (still without commits) would be false.
    git(ahead, 'branch', 'worktree-child')
    expect(await branchHasCommits(ahead, 'worktree-child')).toBe(true)
    expect(await branchHasCommits(clean, 'worktree-clean')).toBe(false)
    // An invalid branch name, a missing branch, and a git failure are all false.
    expect(await branchHasCommits(repo, '--all')).toBe(false)
    expect(await branchHasCommits(repo, 'no-such-branch')).toBe(false)
    expect(await branchHasCommits(join(tmp, 'not-a-repo'), 'x')).toBe(false)
  })
})
