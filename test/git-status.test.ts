/**
 * Git info for the BottomBar (TODO 51, `src/main/git/status.ts`).
 *
 * Calls the real `git` against a temporary repository (the model is not called). The URI gate injects `pathFromUri` instead of FsAccess, because with the real exclusion rules `tmpdir()` fails under `/var/folders` (a Phase 1 fact).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToUri } from '../src/common/uri.js'
import { pathFromUri } from '../src/common/fs-policy.js'
import { GitStatusReader, parsePorcelainV2 } from '../src/main/git/status.js'
import { describeGitStatus } from '../src/renderer/src/gitStatusStore.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const t = (key: string, params?: Record<string, string | number>): string =>
  translate('ja', key, params)

const root = mkdtempSync(join(tmpdir(), 'aios-git-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** git that does not depend on the user's config. It does not read the global or system config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid'
    },
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function makeReader(extra: Partial<ConstructorParameters<typeof GitStatusReader>[0]> = {}) {
  return new GitStatusReader({ assertAllowed: (uri) => pathFromUri(uri), ...extra })
}

describe('parsePorcelainV2 (純関数)', () => {
  it('branch / ahead / behind / 変更 / 未追跡を数える', () => {
    const text = [
      '# branch.oid 0123456789abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa aaa a.txt',
      '1 M. N... 100644 100644 100644 aaa bbb b.txt',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new.txt\told.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? junk.txt',
      '? junk2.txt',
      '! ignored.txt',
      ''
    ].join('\n')
    expect(parsePorcelainV2(text)).toEqual({
      branch: 'main',
      detached: false,
      hasUpstream: true,
      ahead: 2,
      behind: 1,
      changed: 4,
      untracked: 2
    })
  })

  it('detached HEAD は短い commit id、上流なしなら ahead / behind は 0', () => {
    const text = '# branch.oid 0123456789abcdef\n# branch.head (detached)\n'
    expect(parsePorcelainV2(text)).toMatchObject({
      branch: '0123456',
      detached: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('commit の無い新規リポジトリでもブランチ名は出る', () => {
    expect(parsePorcelainV2('# branch.oid (initial)\n# branch.head main\n')).toMatchObject({
      branch: 'main',
      detached: false
    })
  })
})

describe('GitStatusReader (実物の git)', () => {
  it('git 管理外のディレクトリは null', async () => {
    const dir = join(root, 'plain')
    execFileSync('mkdir', ['-p', dir])
    expect(await makeReader().read(pathToUri(dir))).toBeNull()
  })

  it('cwd 無し / 型違い / 門で拒否された URI は null で、投げない', async () => {
    const reader = makeReader()
    expect(await reader.read(undefined)).toBeNull()
    expect(await reader.read('')).toBeNull()
    expect(await reader.read(42)).toBeNull()
    expect(await reader.read('thread://x')).toBeNull()
    expect(await reader.read(pathToUri(join(root, 'does-not-exist')))).toBeNull()
    const denying = new GitStatusReader({
      assertAllowed: () => {
        throw new Error('denied')
      }
    })
    expect(await denying.read(pathToUri(root))).toBeNull()
  })

  it('新規リポジトリ → commit → 変更と未追跡 → detached の順で正しく要約する', async () => {
    const dir = join(root, 'repo')
    execFileSync('mkdir', ['-p', dir])
    git(dir, 'init', '-q', '-b', 'main')
    const reader = makeReader()
    const uri = pathToUri(dir)

    // The branch name appears even without a commit.
    expect(await reader.read(uri)).toMatchObject({ branch: 'main', changed: 0, untracked: 0 })

    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'first')
    expect(await reader.read(uri)).toMatchObject({
      branch: 'main',
      detached: false,
      hasUpstream: false,
      changed: 0,
      untracked: 0
    })

    writeFileSync(join(dir, 'a.txt'), 'b\n')
    writeFileSync(join(dir, 'new.txt'), 'n\n')
    expect(await reader.read(uri)).toMatchObject({ changed: 1, untracked: 1 })

    // Upstream: if a different branch of the same repository is the upstream, ahead can be counted (no remote needed).
    git(dir, 'branch', 'base')
    git(dir, 'branch', '--set-upstream-to=base')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-q', '-m', 'second')
    expect(await reader.read(uri)).toMatchObject({ hasUpstream: true, ahead: 1, behind: 0 })

    const oid = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', '--detach')
    expect(await reader.read(uri)).toMatchObject({ detached: true, branch: oid.slice(0, 7) })
  })

  it('git が無ければ null で、以後は呼ばない (warn は 1 回)', async () => {
    const dir = join(root, 'repo')
    let calls = 0
    const reader = new GitStatusReader({
      assertAllowed: (uri) => {
        calls += 1
        return pathFromUri(uri)
      },
      gitCommand: join(root, 'no-such-git')
    })
    expect(await reader.read(pathToUri(dir))).toBeNull()
    expect(await reader.read(pathToUri(dir))).toBeNull()
    // The second time, it is `unavailable` and does not even reach the gate.
    expect(calls).toBe(1)
  })

  it('時間切れは null (大きなリポジトリの初回など)', async () => {
    const slow = join(root, 'slow-git')
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n')
    chmodSync(slow, 0o755)
    const reader = makeReader({ gitCommand: slow, timeoutMs: 100 })
    const started = Date.now()
    expect(await reader.read(pathToUri(root))).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('dispose() の後は null で、実行中の子プロセスも止まる (12.9)', async () => {
    const slow = join(root, 'slow-git')
    const reader = makeReader({ gitCommand: slow, timeoutMs: 10_000 })
    const started = Date.now()
    const pending = reader.read(pathToUri(root))
    reader.dispose()
    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await reader.read(pathToUri(join(root, 'repo')))).toBeNull()
  })
})

describe('describeGitStatus (BottomBar の 1 行)', () => {
  const base = {
    branch: 'main',
    detached: false,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0
  }
  it('変更が無ければブランチ名だけ', () => {
    expect(describeGitStatus(base, t).text).toBe('⎇ main')
  })
  it('ahead / behind / 変更 (追跡 + 未追跡) を VSCode の順で並べる', () => {
    expect(
      describeGitStatus({ ...base, ahead: 2, behind: 1, changed: 3, untracked: 4 }, t).text
    ).toBe('⎇ main ↑2 ↓1 ✚7')
  })
  it('上流が無ければ ahead / behind は出さない', () => {
    expect(describeGitStatus({ ...base, hasUpstream: false, ahead: 5 }, t).text).toBe('⎇ main')
  })
  it('title は言語で文言になる (TODO 66)', () => {
    const title = describeGitStatus({ ...base, ahead: 2, behind: 1, changed: 3, untracked: 4 }, t)
      .title
    expect(title).toContain('ブランチ main')
    expect(title).toContain('上流より 2 進み / 1 遅れ')
    expect(title).toContain('変更 3 件 / 未追跡 4 件')
  })
})
