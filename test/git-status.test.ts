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

describe('parsePorcelainV2 (pure function)', () => {
  it('counts branch / ahead / behind / changes / untracked', () => {
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

  it('a detached HEAD is a short commit id, and with no upstream ahead / behind are 0', () => {
    const text = '# branch.oid 0123456789abcdef\n# branch.head (detached)\n'
    expect(parsePorcelainV2(text)).toMatchObject({
      branch: '0123456',
      detached: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('a new repository with no commit still shows the branch name', () => {
    expect(parsePorcelainV2('# branch.oid (initial)\n# branch.head main\n')).toMatchObject({
      branch: 'main',
      detached: false
    })
  })
})

describe('GitStatusReader (real git)', () => {
  it('a directory not under git is null', async () => {
    const dir = join(root, 'plain')
    execFileSync('mkdir', ['-p', dir])
    expect(await makeReader().read(pathToUri(dir))).toBeNull()
  })

  it('no cwd / wrong type / a URI refused by the gate is null and does not throw', async () => {
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

  it('summarizes correctly in the order new repository, commit, changes and untracked, detached', async () => {
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

  it('if git is missing it is null and is not called afterwards (warn once)', async () => {
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

  it('a timeout is null (e.g. the first run in a large repository)', async () => {
    const slow = join(root, 'slow-git')
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n')
    chmodSync(slow, 0o755)
    const reader = makeReader({ gitCommand: slow, timeoutMs: 100 })
    const started = Date.now()
    expect(await reader.read(pathToUri(root))).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('after dispose() it is null, and the running child process is stopped too (12.9)', async () => {
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

describe('describeGitStatus (BottomBar single line)', () => {
  const base = {
    branch: 'main',
    detached: false,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0
  }
  it('with no changes, only the branch name', () => {
    expect(describeGitStatus(base, t).text).toBe('⎇ main')
  })
  it('lists ahead / behind / changes (tracked + untracked) in the VSCode order', () => {
    expect(
      describeGitStatus({ ...base, ahead: 2, behind: 1, changed: 3, untracked: 4 }, t).text
    ).toBe('⎇ main ↑2 ↓1 ✚7')
  })
  it('with no upstream, ahead / behind are not shown', () => {
    expect(describeGitStatus({ ...base, hasUpstream: false, ahead: 5 }, t).text).toBe('⎇ main')
  })
  it('title becomes text per language (TODO 66)', () => {
    const title = describeGitStatus({ ...base, ahead: 2, behind: 1, changed: 3, untracked: 4 }, t)
      .title
    expect(title).toContain('ブランチ main')
    expect(title).toContain('上流より 2 進み / 1 遅れ')
    expect(title).toContain('変更 3 件 / 未追跡 4 件')
  })
})
