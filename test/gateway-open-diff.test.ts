/**
 * The receiving entry on main's side of the gateway's `openDiff` (TODO 826, ARCHITECTURE.md 7.6.2).
 *
 * Calls `GatewayRequests` directly through a thin fake host. git is the real one, used in a temporary directory (the model is not called).
 *  - Resolves two files, or a working tree against a git rev (default HEAD)
 *  - A diff opened from the AI defaults to side-by-side (`layout: 'split'`), and is delivered only to the window that shows it
 *  - Refuses at the choke point (`assertAllowed`), directories, binaries, the check of the rev, both base and rev, and when there is no window
 *  - `isGitRev` / `classifyShowError` / the viewer's `layoutFor`
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileException } from 'node:child_process'
import type { Thread, ViewerCommand } from '../src/shared/thread.js'
import type { DiffSide } from '../src/shared/plugin.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import { classifyShowError, isGitRev } from '../src/main/git/show.js'
import { uriToPath } from '../src/common/uri.js'
import { layoutFor } from '../plugins/aios.diff/viewer/diff-view.js'
import { openDiffInput } from '../src/gateway/viewer-schemas.js'

let dir: string
let commands: { viewId: number; command: ViewerCommand }[]
let views: number[]

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'ignore'
  })
}

function makeRequests(): GatewayRequests {
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
    getThread: (id) => (id === 't1' ? ({ id, cwdUri: `file://${dir}`, worktreeUri: null } as unknown as Thread) : null),
    viewsOf: () => views,
    onViewerCommand: (viewId, command) => {
      commands.push({ viewId, command })
    },
    fs: {
      assertAllowed: (uri: string) => {
        const path = uriToPath(uri)
        if (path.includes('/secret/')) throw new Error('excluded')
        return path
      }
    }
  }
  return new GatewayRequests(host as GatewayRequestHost)
}

const call = (payload: Record<string, unknown>): Promise<unknown> =>
  makeRequests().handle({ sessionId: 's1', kind: 'openDiff', payload } as never)

const diffOf = (index = 0): { before: DiffSide; after: DiffSide; layout?: string } => {
  const command = commands[index]?.command
  if (command?.kind !== 'diff') throw new Error('not a diff command')
  return command.diff
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'aios-open-diff-')))
  commands = []
  views = [7]
  writeFileSync(join(dir, 'a.ts'), 'const a = 1\n')
  writeFileSync(join(dir, 'b.ts'), 'const a = 2\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('openDiff: two files (TODO 826)', () => {
  it('delivers base on the left and path on the right to a window showing side by side', async () => {
    views = [3, 4]
    const result = await call({ path: 'b.ts', base: join(dir, 'a.ts') })
    expect(result).toMatchObject({ opened: true, windows: 2, before: 'a.ts', after: join(dir, 'b.ts') })
    expect(commands.map((c) => c.viewId)).toEqual([3, 4])
    expect(commands[0]?.command).toMatchObject({ kind: 'diff', threadId: 't1' })
    expect(diffOf()).toEqual({
      kind: 'diff',
      before: { name: 'a.ts', text: 'const a = 1\n', language: null },
      after: { name: 'b.ts', text: 'const a = 2\n', language: null },
      layout: 'split'
    })
  })

  it('files with the same name are told apart by adding the parent folder name; identical content is identical', async () => {
    mkdirSync(join(dir, 'x'))
    mkdirSync(join(dir, 'y'))
    writeFileSync(join(dir, 'x', 'c.ts'), 'same\n')
    writeFileSync(join(dir, 'y', 'c.ts'), 'same\n')
    expect(await call({ path: 'y/c.ts', base: 'x/c.ts' })).toMatchObject({ opened: true, identical: true })
    expect(diffOf().before.name).toBe('x/c.ts')
    expect(diffOf().after.name).toBe('y/c.ts')
  })

  it('paths refused by the choke point, missing, directories, binaries and broken paths are refused and nothing is sent to the window', async () => {
    mkdirSync(join(dir, 'secret'))
    writeFileSync(join(dir, 'secret', 'k.ts'), 'x')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2]))
    mkdirSync(join(dir, 'sub'))
    expect(await call({ path: 'a.ts', base: 'secret/k.ts' })).toMatchObject({ opened: false, error: 'base: this path is not allowed' })
    expect(await call({ path: 'nope.ts', base: 'a.ts' })).toMatchObject({ opened: false, error: 'file not found' })
    expect(await call({ path: 'sub', base: 'a.ts' })).toMatchObject({ opened: false, error: 'this is a directory, not a file' })
    expect(await call({ path: 'bin.dat', base: 'a.ts' })).toMatchObject({ opened: false, error: 'binary files cannot be compared' })
    for (const path of ['', 42, 'https://example.com/a', undefined]) {
      expect(await call({ path, base: 'a.ts' })).toMatchObject({ opened: false, error: 'invalid path' })
    }
    expect(commands).toEqual([])
  })

  it('symlink: even if the logical path passes, the target is not read if the choke point rejects it; one pointing inside the range is readable', async () => {
    mkdirSync(join(dir, 'secret'))
    writeFileSync(join(dir, 'secret', 'k.ts'), 'TOP SECRET\n')
    symlinkSync(join(dir, 'secret', 'k.ts'), join(dir, 'link-out.ts'))
    symlinkSync(join(dir, 'a.ts'), join(dir, 'link-in.ts'))
    symlinkSync(join(dir, 'nowhere.ts'), join(dir, 'link-dangling.ts'))
    expect(await call({ path: 'b.ts', base: 'link-out.ts' })).toMatchObject({
      opened: false,
      error: 'base: this path is not allowed'
    })
    expect(JSON.stringify(commands)).not.toContain('TOP SECRET')
    expect(await call({ path: 'b.ts', base: 'link-dangling.ts' })).toMatchObject({ opened: false, error: 'base: file not found' })
    expect(await call({ path: 'b.ts', base: 'link-in.ts' })).toMatchObject({ opened: true })
    expect(diffOf().before.text).toBe('const a = 1\n')
  })

  it('refuses both base and rev', async () => {
    expect(await call({ path: 'a.ts', base: 'b.ts', rev: 'HEAD' })).toMatchObject({
      opened: false,
      error: 'give either base or rev, not both'
    })
  })

  it('cannot be shown without a window that is showing it (a temporary view has no memory)', async () => {
    views = []
    expect(await call({ path: 'b.ts', base: 'a.ts' })).toMatchObject({ opened: false, windows: 0 })
    expect(commands).toEqual([])
  })
})

describe('openDiff: working tree vs a git rev (TODO 826)', () => {
  beforeEach(() => {
    git('init', '-q')
    git('add', 'a.ts')
    git('commit', '-q', '-m', 'one')
    writeFileSync(join(dir, 'a.ts'), 'const a = 10\n')
    git('commit', '-q', '-am', 'two')
    writeFileSync(join(dir, 'a.ts'), 'const a = 100\n')
  })

  it('omitting rev compares with HEAD; the name is HEAD:a.ts', async () => {
    expect(await call({ path: 'a.ts' })).toMatchObject({ opened: true, before: 'HEAD:a.ts' })
    expect(diffOf()).toEqual({
      kind: 'diff',
      before: { name: 'HEAD:a.ts', text: 'const a = 10\n', language: null },
      after: { name: 'a.ts', text: 'const a = 100\n', language: null },
      layout: 'split'
    })
  })

  it('pointing at a rev compares with that version (HEAD~1); files in subfolders are also resolved with ./', async () => {
    expect(await call({ path: join(dir, 'a.ts'), rev: 'HEAD~1' })).toMatchObject({ opened: true })
    expect(diffOf().before.text).toBe('const a = 1\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 's.ts'), 'old\n')
    git('add', 'sub/s.ts')
    git('commit', '-q', '-m', 'three')
    writeFileSync(join(dir, 'sub', 's.ts'), 'new\n')
    commands = []
    expect(await call({ path: 'sub/s.ts' })).toMatchObject({ opened: true })
    expect(diffOf().before.text).toBe('old\n')
  })

  it('even in a repo with eol=crlf, no change is identical (reads the working tree form, not the stored blob)', async () => {
    writeFileSync(join(dir, '.gitattributes'), '* text eol=crlf\n')
    writeFileSync(join(dir, 'c.txt'), 'one\r\ntwo\r\n')
    git('add', '.gitattributes', 'c.txt')
    git('commit', '-q', '-m', 'crlf')
    expect(await call({ path: 'c.txt' })).toMatchObject({ opened: true, before: 'HEAD:c.txt', identical: true })
    expect(diffOf().before.text).toBe('one\r\ntwo\r\n')
  })

  it('files not in git, missing revs and malformed revs are refused', async () => {
    expect(await call({ path: 'b.ts' })).toMatchObject({ opened: false, error: 'the file or the revision was not found in git' })
    expect(await call({ path: 'a.ts', rev: 'no-such-branch' })).toMatchObject({ opened: false })
    for (const rev of ['--output=/tmp/x', 'HEAD:a.ts', 'a b', 'x'.repeat(201), 42]) {
      expect(await call({ path: 'a.ts', rev }), String(rev).slice(0, 20)).toMatchObject({
        opened: false,
        error: 'invalid git revision'
      })
    }
    expect(commands).toEqual([])
  })
})

describe('openDiff: outside git (TODO 826)', () => {
  it('refuses to compare a file not under git with a rev', async () => {
    const result = (await call({ path: 'a.ts' })) as { opened: boolean; error: string }
    expect(result.opened).toBe(false)
    // If tmpdir is inside some repository it is not-found, and if outside it is not-a-repo. Either way it is refused.
    expect(['the file is not in a git repository', 'the file or the revision was not found in git']).toContain(result.error)
  })
})

describe('isGitRev / classifyShowError (TODO 826)', () => {
  it('rev allows only alphanumerics and _./~^@{}+-, does not start with -, and is at most 200 characters', () => {
    for (const rev of ['HEAD', 'HEAD~1', 'HEAD^', 'main', 'origin/main', 'v1.2.3', 'abc123', '@{u}', 'stash@{0}']) {
      expect(isGitRev(rev), rev).toBe(true)
    }
    for (const rev of ['', '-p', '--help', 'HEAD:a', 'a b', 'a\nb', 'x'.repeat(201), null, 1]) {
      expect(isGitRev(rev), String(rev)).toBe(false)
    }
  })

  it('maps a failure to a reason code', () => {
    const err = (props: Partial<ExecFileException>): ExecFileException =>
      Object.assign(new Error('x'), props) as ExecFileException
    expect(classifyShowError(err({ code: 'ENOENT' as never }), '')).toBe('missing')
    expect(classifyShowError(err({ code: 1 }), 'xcode-select: note')).toBe('missing')
    expect(classifyShowError(err({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' as never, killed: true }), '')).toBe('too-large')
    expect(classifyShowError(err({ killed: true, signal: 'SIGTERM' }), '')).toBe('timeout')
    expect(classifyShowError(err({ code: 128 }), 'fatal: not a git repository')).toBe('not-a-repo')
    expect(classifyShowError(err({ code: 128 }), "fatal: path 'b.ts' exists on disk, but not in 'HEAD'")).toBe('not-found')
    expect(classifyShowError(err({ code: 1 }), '')).toBe('error')
  })
})

describe('gateway openDiff input (TODO 826)', () => {
  it('path is required, base / rev are optional; the rev shape follows the same rule as main', () => {
    expect(openDiffInput.safeParse({ path: 'a.ts' }).success).toBe(true)
    expect(openDiffInput.safeParse({ path: 'a.ts', base: 'b.ts' }).success).toBe(true)
    expect(openDiffInput.safeParse({ path: 'a.ts', rev: 'HEAD~2' }).success).toBe(true)
    expect(openDiffInput.safeParse({}).success).toBe(false)
    expect(openDiffInput.safeParse({ path: '' }).success).toBe(false)
    for (const rev of ['-p', 'HEAD:a', 'a b', 'x'.repeat(201)]) {
      expect(openDiffInput.safeParse({ path: 'a.ts', rev }).success, rev).toBe(false)
    }
  })
})

describe('aios.diff layout (layoutFor, TODO 826)', () => {
  const side = (name: string, text: string): DiffSide => ({ name, text, language: null })
  const a = { before: side('a', '1'), after: side('a', '2') }
  const b = { before: side('b', '1'), after: side('b', '3') }

  it('a new diff with a layout set by the host follows it (a diff opened from the AI is side by side)', () => {
    expect(layoutFor('unified', null, { ...a, layout: 'split' })).toBe('split')
    expect(layoutFor('unified', a, { ...b, layout: 'split' })).toBe('split')
  })

  it("resending the same content and a diff without a layout keep the current layout (the user's switch)", () => {
    expect(layoutFor('unified', { ...a, layout: 'split' }, { ...a, layout: 'split' })).toBe('unified')
    expect(layoutFor('split', a, b)).toBe('split')
    expect(layoutFor('unified', null, a)).toBe('unified')
  })
})
