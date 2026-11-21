/**
 * The receiving entry on main's side of the gateway's `openFile` (item 97, ARCHITECTURE.md 7.6.2).
 *
 * Calls `GatewayRequests` directly through a thin fake host, and the choke point is the real `FsAccess` (the exclusion rules are `createMacosExclusions`).
 *  - TODO 841: the decision is the same `'read'` that a user's opening in ViewerPane uses. The read-only exception (the auto memory `.md`, item 254) can also be opened from the AI. Credential files are refused as before.
 *  - TODO 832 (1): asks for a reply only from windows that hold a draft, and if the draft was kept and not replaced (`kept`) it returns `opened: false`. Also checks the timeout of `ViewerCommandReplies` (the mailbox that matches up the waiting), windows that are not the destination, and unknown values.
 *
 * The temporary directory is made under home (the tmpdir under `/var/folders` hits the exclusion rules, the same as `link-resolve.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Thread, ViewerCommand } from '../src/shared/thread.js'
import { GatewayRequests, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import { FsAccess } from '../src/main/fs/access.js'
import { loadBackendPaths } from '../src/main/session/adapter/compat.js'
import { encodeProjectDir } from '../src/main/session/adapter/memory.js'
import { ViewerCommandReplies } from '../src/main/session/viewer-command-replies.js'
import type { ViewerCommandOutcome } from '../src/shared/thread.js'

let home: string
let cwd: string
let memoryDir: string
let backendDir: string
let fsAccess: FsAccess
let commands: { viewId: number; command: ViewerCommand }[]
let memory: { uri: string | null; highlight: string | null }[]
let replies: ViewerCommandReplies
/** A window that holds a draft (`hasViewerDraft`). */
let drafted: Set<number>
/** The reply from a window's renderer (used only when a reply is requested). A window that is undefined does not reply. */
let answers: Map<number, ViewerCommandOutcome>

const expandHome = (value: string): string => (value.startsWith('~/') ? join(home, value.slice(2)) : value)

function makeRequests(views: readonly number[] = [7]): GatewayRequests {
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
    getThread: (id) =>
      id === 't1' ? ({ id, cwdUri: `file://${cwd}`, worktreeUri: null } as unknown as Thread) : null,
    viewsOf: () => views,
    onViewerCommand: (viewId, command) => {
      commands.push({ viewId, command })
      // Imitates the renderer's reply (IPC is asynchronous, so it comes on the next tick).
      const answer = answers.get(viewId)
      if (command.kind === 'open' && command.replyId !== undefined && answer !== undefined) {
        const id = command.replyId
        setTimeout(() => replies.reply(viewId, id, answer), 0)
      }
    },
    hasViewerDraft: (viewId) => drafted.has(viewId),
    expectViewerReplies: (viewIds) => replies.expect(viewIds),
    setViewerState: (_threadId, uri, highlight) => {
      memory.push({ uri, highlight })
    },
    fs: fsAccess
  }
  return new GatewayRequests(host as GatewayRequestHost)
}

const openFile = (payload: Record<string, unknown>, views?: readonly number[]): Promise<unknown> =>
  makeRequests(views).handle({ sessionId: 's1', kind: 'openFile', payload } as never)

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(homedir(), '.aios-open-file-test-')))
  const paths = loadBackendPaths()
  backendDir = expandHome(paths.credentialDirs[0] ?? '')
  const projects = expandHome(paths.transcriptDir)
  cwd = join(home, 'work', 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
  memoryDir = join(projects, encodeProjectDir(cwd), paths.memorySubdir ?? 'memory')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), '- [x](x.md)\n')
  mkdirSync(backendDir, { recursive: true })
  writeFileSync(join(backendDir, '.credentials.json'), '{"secret":"TOP"}')
  fsAccess = new FsAccess(home, [home])
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  commands = []
  memory = []
  replies = new ViewerCommandReplies(50)
  drafted = new Set()
  answers = new Map()
})

describe('openFile の関門は利用者が開くのと同じ読み取りの判定 (TODO 841)', () => {
  it('auto memory の .md (読み取りだけの例外、項目 254) を開ける — openDiff と揃う', async () => {
    const path = join(memoryDir, 'MEMORY.md')
    expect(await openFile({ path })).toMatchObject({ opened: true, path, windows: 1 })
    expect(commands).toEqual([
      { viewId: 7, command: { kind: 'open', threadId: 't1', uri: `file://${path}`, highlight: null } }
    ])
    expect(memory).toEqual([{ uri: `file://${path}`, highlight: null }])
  })

  it('資格情報のファイルは今どおり断り、窓にも記憶にも何も送らない', async () => {
    expect(await openFile({ path: join(backendDir, '.credentials.json') })).toEqual({
      opened: false,
      error: 'this path is not allowed'
    })
    expect(commands).toEqual([])
    expect(memory).toEqual([])
  })

  it('普通のファイルは今までどおり開ける', async () => {
    expect(await openFile({ path: 'a.ts' })).toMatchObject({ opened: true, path: join(cwd, 'a.ts') })
  })
})

describe('openFile の戻り値は窓の実際の扱いを出す (TODO 832 (1))', () => {
  it('下書きの無い窓には返事を求めず、今までどおり opened: true', async () => {
    expect(await openFile({ path: 'a.ts' }, [3, 4])).toEqual({ opened: true, path: join(cwd, 'a.ts'), windows: 2 })
    expect(commands.every((c) => c.command.kind === 'open' && c.command.replyId === undefined)).toBe(true)
  })

  it('下書きを守って替えなかった窓しか無ければ opened: false (嘘をつかない)', async () => {
    drafted.add(7)
    answers.set(7, 'kept')
    const result = await openFile({ path: 'a.ts' })
    expect(result).toMatchObject({ opened: false, path: join(cwd, 'a.ts'), windows: 0 })
    expect((result as { error: string }).error).toMatch(/unsaved edits/)
    const command = commands[0]?.command
    expect(command?.kind === 'open' && typeof command.replyId === 'string').toBe(true)
  })

  it('下書きがあっても従った (同じファイル等) なら opened: true', async () => {
    drafted.add(7)
    answers.set(7, 'opened')
    expect(await openFile({ path: 'a.ts' })).toEqual({ opened: true, path: join(cwd, 'a.ts'), windows: 1 })
  })

  it('一部の窓だけ替えなかったら、出した窓の数と note', async () => {
    drafted.add(4)
    answers.set(4, 'kept')
    const result = await openFile({ path: 'a.ts' }, [3, 4])
    expect(result).toMatchObject({ opened: true, windows: 1 })
    expect((result as { note: string }).note).toMatch(/1 other window/)
    // Only the windows that hold a draft were asked for a reply.
    const ids = commands.map((c) => (c.command.kind === 'open' ? (c.command.replyId ?? null) : null))
    expect(ids[0]).toBeNull()
    expect(typeof ids[1]).toBe('string')
  })

  it('そのスレッドを出していなかった (ignored) だけなら、窓が無いときと同じ note', async () => {
    drafted.add(7)
    answers.set(7, 'ignored')
    expect(await openFile({ path: 'a.ts' })).toMatchObject({ opened: true, windows: 0, note: expect.stringMatching(/No window/) })
  })

  it('返事が来ない (reload 中・時間切れ) 窓しか無ければ、出したと数えず opened: false + unconfirmed (第 41 波 code-review)', async () => {
    drafted.add(7)
    const result = await openFile({ path: 'a.ts' })
    expect(result).toMatchObject({ opened: false, path: join(cwd, 'a.ts'), windows: 0, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/could not be confirmed/)
    expect(result).not.toHaveProperty('error')
  })

  it('返事の無い窓と替えなかった窓だけでも opened は true にしない', async () => {
    drafted.add(3)
    drafted.add(4)
    answers.set(4, 'kept')
    const result = await openFile({ path: 'a.ts' }, [3, 4])
    expect(result).toMatchObject({ opened: false, windows: 0, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/1 other window\(s\) kept/)
  })

  it('出した窓があれば opened: true で、確かめられなかった窓の数を unconfirmed と note に出す', async () => {
    drafted.add(4)
    const result = await openFile({ path: 'a.ts' }, [3, 4])
    expect(result).toMatchObject({ opened: true, windows: 1, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/could not be confirmed/)
  })
})

describe('ViewerCommandReplies (TODO 832 (1))', () => {
  it('宛先でない窓・知らない id・知らない値・2 度目は捨て、全部そろったら解ける', async () => {
    const box = new ViewerCommandReplies(10_000)
    const { id, done } = box.expect([1, 2])
    box.reply(3, id, 'kept')
    box.reply(1, 'other', 'kept')
    box.reply(1, id, 'bogus')
    box.reply(1, id, 'kept')
    box.reply(1, id, 'opened')
    box.reply(2, id, 'opened')
    expect([...(await done)]).toEqual([
      [1, 'kept'],
      [2, 'opened']
    ])
  })

  it('窓が閉じたら ignored、dispose は届いた分だけで解く', async () => {
    const box = new ViewerCommandReplies(10_000)
    const first = box.expect([1, 2])
    box.reply(1, first.id, 'kept')
    box.forgetView(2)
    expect([...(await first.done)]).toEqual([
      [1, 'kept'],
      [2, 'ignored']
    ])
    const second = box.expect([5])
    box.dispose()
    expect((await second.done).size).toBe(0)
  })
})

describe('openFile の page (TODO 1091 の 1)', () => {
  it('page を窓への指示に載せる。記憶には残らない', async () => {
    expect(await openFile({ path: 'a.ts', page: 4 })).toMatchObject({ opened: true })
    expect(commands).toEqual([
      { viewId: 7, command: { kind: 'open', threadId: 't1', uri: `file://${join(cwd, 'a.ts')}`, highlight: null, page: 4 } }
    ])
    expect(memory).toEqual([{ uri: `file://${join(cwd, 'a.ts')}`, highlight: null }])
  })

  it('範囲外・非整数は main で断り、何も送らない', async () => {
    for (const page of [0, -2, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) {
      expect(await openFile({ path: 'a.ts', page })).toEqual({ opened: false, error: 'page must be a positive integer' })
    }
    expect(commands).toEqual([])
  })

  it('line があれば line が先で page は載せない', async () => {
    await openFile({ path: 'a.ts', line: 2, page: 4 })
    expect(commands[0]?.command).toMatchObject({ kind: 'open', line: 2 })
    expect(commands[0]?.command).not.toHaveProperty('page')
  })
})
