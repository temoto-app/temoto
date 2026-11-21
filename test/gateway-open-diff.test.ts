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

describe('openDiff: 2 つのファイル (TODO 826)', () => {
  it('base を左、path を右にして、横並びで表示している窓に届ける', async () => {
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

  it('同じ名前のファイルは親のフォルダ名を添えて見分ける。同じ中身なら identical', async () => {
    mkdirSync(join(dir, 'x'))
    mkdirSync(join(dir, 'y'))
    writeFileSync(join(dir, 'x', 'c.ts'), 'same\n')
    writeFileSync(join(dir, 'y', 'c.ts'), 'same\n')
    expect(await call({ path: 'y/c.ts', base: 'x/c.ts' })).toMatchObject({ opened: true, identical: true })
    expect(diffOf().before.name).toBe('x/c.ts')
    expect(diffOf().after.name).toBe('y/c.ts')
  })

  it('関門で断られた・無い・ディレクトリ・バイナリ・壊れたパスは断り、窓には何も送らない', async () => {
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

  it('symlink: 論理パスは通っても実体が関門に弾かれるなら読まない。範囲内を指すものは読める', async () => {
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

  it('base と rev の両方は断る', async () => {
    expect(await call({ path: 'a.ts', base: 'b.ts', rev: 'HEAD' })).toMatchObject({
      opened: false,
      error: 'give either base or rev, not both'
    })
  })

  it('表示している窓が無ければ出せない (一時表示は記憶を持たない)', async () => {
    views = []
    expect(await call({ path: 'b.ts', base: 'a.ts' })).toMatchObject({ opened: false, windows: 0 })
    expect(commands).toEqual([])
  })
})

describe('openDiff: 作業ツリー対 git の rev (TODO 826)', () => {
  beforeEach(() => {
    git('init', '-q')
    git('add', 'a.ts')
    git('commit', '-q', '-m', 'one')
    writeFileSync(join(dir, 'a.ts'), 'const a = 10\n')
    git('commit', '-q', '-am', 'two')
    writeFileSync(join(dir, 'a.ts'), 'const a = 100\n')
  })

  it('rev を省くと HEAD と比べる。名前は HEAD:a.ts', async () => {
    expect(await call({ path: 'a.ts' })).toMatchObject({ opened: true, before: 'HEAD:a.ts' })
    expect(diffOf()).toEqual({
      kind: 'diff',
      before: { name: 'HEAD:a.ts', text: 'const a = 10\n', language: null },
      after: { name: 'a.ts', text: 'const a = 100\n', language: null },
      layout: 'split'
    })
  })

  it('rev を指せばその版と比べる (HEAD~1)。サブフォルダのファイルも ./ で解く', async () => {
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

  it('eol=crlf の repo でも、変更なしなら identical (保存された blob ではなく作業ツリーの形で読む)', async () => {
    writeFileSync(join(dir, '.gitattributes'), '* text eol=crlf\n')
    writeFileSync(join(dir, 'c.txt'), 'one\r\ntwo\r\n')
    git('add', '.gitattributes', 'c.txt')
    git('commit', '-q', '-m', 'crlf')
    expect(await call({ path: 'c.txt' })).toMatchObject({ opened: true, before: 'HEAD:c.txt', identical: true })
    expect(diffOf().before.text).toBe('one\r\ntwo\r\n')
  })

  it('git に無いファイル・無い rev・形の悪い rev は断る', async () => {
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

describe('openDiff: git の外 (TODO 826)', () => {
  it('git 管理外のファイルを rev と比べようとしたら断る', async () => {
    const result = (await call({ path: 'a.ts' })) as { opened: boolean; error: string }
    expect(result.opened).toBe(false)
    // If tmpdir is inside some repository it is not-found, and if outside it is not-a-repo. Either way it is refused.
    expect(['the file is not in a git repository', 'the file or the revision was not found in git']).toContain(result.error)
  })
})

describe('isGitRev / classifyShowError (TODO 826)', () => {
  it('rev は英数字と _./~^@{}+- だけ、- で始まらず、200 字まで', () => {
    for (const rev of ['HEAD', 'HEAD~1', 'HEAD^', 'main', 'origin/main', 'v1.2.3', 'abc123', '@{u}', 'stash@{0}']) {
      expect(isGitRev(rev), rev).toBe(true)
    }
    for (const rev of ['', '-p', '--help', 'HEAD:a', 'a b', 'a\nb', 'x'.repeat(201), null, 1]) {
      expect(isGitRev(rev), String(rev)).toBe(false)
    }
  })

  it('失敗を理由コードに落とす', () => {
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

describe('gateway の openDiff の入力 (TODO 826)', () => {
  it('path は必須、base / rev は省ける。rev の形は main と同じ規則', () => {
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

describe('aios.diff の並べ方 (layoutFor、TODO 826)', () => {
  const side = (name: string, text: string): DiffSide => ({ name, text, language: null })
  const a = { before: side('a', '1'), after: side('a', '2') }
  const b = { before: side('b', '1'), after: side('b', '3') }

  it('host が layout を付けた新しい diff はそれに従う (AI から開いた diff は横並び)', () => {
    expect(layoutFor('unified', null, { ...a, layout: 'split' })).toBe('split')
    expect(layoutFor('unified', a, { ...b, layout: 'split' })).toBe('split')
  })

  it('同じ中身の送り直しと layout の無い diff は、いまの並べ方 (利用者の切り替え) を保つ', () => {
    expect(layoutFor('unified', { ...a, layout: 'split' }, { ...a, layout: 'split' })).toBe('unified')
    expect(layoutFor('split', a, b)).toBe('split')
    expect(layoutFor('unified', null, a)).toBe('unified')
  })
})
