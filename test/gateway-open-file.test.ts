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

describe('the openFile choke point is the same read decision as when the user opens (TODO 841)', () => {
  it('can open an auto memory .md (a read-only exception, item 254), consistent with openDiff', async () => {
    const path = join(memoryDir, 'MEMORY.md')
    expect(await openFile({ path })).toMatchObject({ opened: true, path, windows: 1 })
    expect(commands).toEqual([
      { viewId: 7, command: { kind: 'open', threadId: 't1', uri: `file://${path}`, highlight: null } }
    ])
    expect(memory).toEqual([{ uri: `file://${path}`, highlight: null }])
  })

  it('credential files are refused as before, and nothing is sent to the window or the memory', async () => {
    expect(await openFile({ path: join(backendDir, '.credentials.json') })).toEqual({
      opened: false,
      error: 'this path is not allowed'
    })
    expect(commands).toEqual([])
    expect(memory).toEqual([])
  })

  it('ordinary files open as before', async () => {
    expect(await openFile({ path: 'a.ts' })).toMatchObject({ opened: true, path: join(cwd, 'a.ts') })
  })
})

describe('the openFile return value reflects what the window actually did (TODO 832 (1))', () => {
  it('does not ask a window without a draft for a reply, and returns opened: true as before', async () => {
    expect(await openFile({ path: 'a.ts' }, [3, 4])).toEqual({ opened: true, path: join(cwd, 'a.ts'), windows: 2 })
    expect(commands.every((c) => c.command.kind === 'open' && c.command.replyId === undefined)).toBe(true)
  })

  it('when there are only windows that kept their draft and did not switch, opened: false (does not lie)', async () => {
    drafted.add(7)
    answers.set(7, 'kept')
    const result = await openFile({ path: 'a.ts' })
    expect(result).toMatchObject({ opened: false, path: join(cwd, 'a.ts'), windows: 0 })
    expect((result as { error: string }).error).toMatch(/unsaved edits/)
    const command = commands[0]?.command
    expect(command?.kind === 'open' && typeof command.replyId === 'string').toBe(true)
  })

  it('if it complied despite a draft (same file etc.), opened: true', async () => {
    drafted.add(7)
    answers.set(7, 'opened')
    expect(await openFile({ path: 'a.ts' })).toEqual({ opened: true, path: join(cwd, 'a.ts'), windows: 1 })
  })

  it('if only some windows did not switch, reports the number of windows that showed it, with a note', async () => {
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

  it('if the thread was merely not shown (ignored), the note is the same as when there is no window', async () => {
    drafted.add(7)
    answers.set(7, 'ignored')
    expect(await openFile({ path: 'a.ts' })).toMatchObject({ opened: true, windows: 0, note: expect.stringMatching(/No window/) })
  })

  it('when only windows that do not reply (reloading, timed out) exist, it is not counted as shown: opened: false + unconfirmed (wave 41 code-review)', async () => {
    drafted.add(7)
    const result = await openFile({ path: 'a.ts' })
    expect(result).toMatchObject({ opened: false, path: join(cwd, 'a.ts'), windows: 0, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/could not be confirmed/)
    expect(result).not.toHaveProperty('error')
  })

  it('a window without a reply plus a window that did not switch still does not make opened true', async () => {
    drafted.add(3)
    drafted.add(4)
    answers.set(4, 'kept')
    const result = await openFile({ path: 'a.ts' }, [3, 4])
    expect(result).toMatchObject({ opened: false, windows: 0, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/1 other window\(s\) kept/)
  })

  it('if any window showed it, opened: true, and the number of windows that could not be confirmed goes into unconfirmed and the note', async () => {
    drafted.add(4)
    const result = await openFile({ path: 'a.ts' }, [3, 4])
    expect(result).toMatchObject({ opened: true, windows: 1, unconfirmed: 1 })
    expect((result as { note: string }).note).toMatch(/could not be confirmed/)
  })
})

describe('ViewerCommandReplies (TODO 832 (1))', () => {
  it('drops windows that are not the target, unknown ids, unknown values and a second reply, and resolves once all have replied', async () => {
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

  it('a closed window is ignored, and dispose resolves with only the replies that arrived', async () => {
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

describe('openFile page (TODO 1091 part 1)', () => {
  it('puts page on the instruction to the window; it is not kept in memory', async () => {
    expect(await openFile({ path: 'a.ts', page: 4 })).toMatchObject({ opened: true })
    expect(commands).toEqual([
      { viewId: 7, command: { kind: 'open', threadId: 't1', uri: `file://${join(cwd, 'a.ts')}`, highlight: null, page: 4 } }
    ])
    expect(memory).toEqual([{ uri: `file://${join(cwd, 'a.ts')}`, highlight: null }])
  })

  it('out-of-range and non-integer values are refused in main and nothing is sent', async () => {
    for (const page of [0, -2, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) {
      expect(await openFile({ path: 'a.ts', page })).toEqual({ opened: false, error: 'page must be a positive integer' })
    }
    expect(commands).toEqual([])
  })

  it('when line is given, line takes precedence and page is not put', async () => {
    await openFile({ path: 'a.ts', line: 2, page: 4 })
    expect(commands[0]?.command).toMatchObject({ kind: 'open', line: 2 })
    expect(commands[0]?.command).not.toHaveProperty('page')
  })
})
