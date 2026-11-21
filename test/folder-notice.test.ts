/**
 * Item 123: the notice for a first folder.
 *
 * - Adapter discovery (`locateProjectAutorun`): following the compat table (`projectAutorun`), finds the files that declare hooks or MCP servers in a real temporary directory. The placement rules are the measurements of spike 25 (the parent's `.mcp.json` is read; the parent's settings hooks are not read; the repository root's `settings.local.json` is read).
 * - Decision (`folderNotice`): whether it is the first time (history of working folders and transcripts), whether anything exists, and the choke point (paths that hit an exclusion).
 *   The choke point is applied with the real `FsAccess` (with home set to a temporary directory).
 *
 * The CLI is not started. The temporary directory is made under home (`tmpdir()` hits the exclusion rules).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { ClaudeCodeAdapter } from '../src/main/session/adapter/index.js'
import { MAX_AUTORUN_FILE_BYTES } from '../src/main/session/adapter/project-autorun.js'
import { folderNotice, type FolderNoticeDeps } from '../src/main/session/folder-notice.js'
import { FsAccess } from '../src/main/fs/access.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { pathToUri } from '../src/common/uri.js'
import { folderNoticeLabel } from '../src/renderer/src/components/FolderNotice.js'
import { makeTestDir } from './helpers/tmp.js'

let root: string
const adapter = new ClaudeCodeAdapter()
const allowAll = (): boolean => true

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

const HOOKS = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [] } }
const MCP = { mcpServers: { probe: { command: 'node', args: ['x.mjs'] } } }

beforeEach(() => {
  root = realpathSync(makeTestDir('folder-notice-test'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Outside the root (the real home, or `.mcp.json` at `/`) is not compared. */
function mine<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => file.path.startsWith(root))
}

describe('locateProjectAutorun (項目 123、spike 25 の置き場所)', () => {
  it('cwd の settings.json / settings.local.json の hooks と .mcp.json を名前つきで見つける', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), HOOKS)
    write(join(cwd, '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [] }] } })
    write(join(cwd, '.mcp.json'), MCP)
    const found = await adapter.locateProjectAutorun(cwd, allowAll)
    // Events with empty arrays (PreToolUse: []) are not counted.
    expect(mine(found.hooks)).toEqual([
      { path: join(cwd, '.claude', 'settings.json'), names: ['SessionStart'] },
      { path: join(cwd, '.claude', 'settings.local.json'), names: ['Stop'] }
    ])
    expect(mine(found.mcp)).toEqual([{ path: join(cwd, '.mcp.json'), names: ['probe'] }])
  })

  it('親の .mcp.json は見つけ、親の settings の hooks は見ない (リポジトリでなければ)', async () => {
    const parent = join(root, 'parent')
    const cwd = join(parent, 'child')
    mkdirSync(cwd, { recursive: true })
    write(join(parent, '.claude', 'settings.json'), HOOKS)
    write(join(parent, '.claude', 'settings.local.json'), HOOKS)
    write(join(parent, '.mcp.json'), MCP)
    const found = await adapter.locateProjectAutorun(cwd, allowAll)
    expect(mine(found.hooks)).toEqual([])
    expect(mine(found.mcp)).toEqual([{ path: join(parent, '.mcp.json'), names: ['probe'] }])
  })

  it('リポジトリの根の settings.local.json の hooks は子のフォルダでも見つける (settings.json は見ない)', async () => {
    const repo = join(root, 'repo')
    const cwd = join(repo, 'pkg', 'sub')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(repo, '.git'))
    write(join(repo, '.claude', 'settings.json'), HOOKS)
    write(join(repo, '.claude', 'settings.local.json'), HOOKS)
    const found = await adapter.locateProjectAutorun(cwd, allowAll)
    expect(mine(found.hooks)).toEqual([
      { path: join(repo, '.claude', 'settings.local.json'), names: ['SessionStart'] }
    ])
  })

  it('cwd がリポジトリの根なら settings.local.json を 2 度数えない', async () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    write(join(repo, '.claude', 'settings.local.json'), HOOKS)
    const found = await adapter.locateProjectAutorun(repo, allowAll)
    expect(mine(found.hooks)).toHaveLength(1)
  })

  it('壊れた JSON・鍵の無いファイル・空の表・配列は知らせない', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), '{ "hooks": { "SessionStart": [ ')
    write(join(cwd, '.claude', 'settings.local.json'), { permissions: { allow: [] } })
    write(join(cwd, '.mcp.json'), { mcpServers: {} })
    write(join(root, '.mcp.json'), [1, 2])
    const found = await adapter.locateProjectAutorun(cwd, allowAll)
    expect(mine(found.hooks)).toEqual([])
    expect(mine(found.mcp)).toEqual([])
  })

  it('大きすぎるファイルは中身を読まずに「ある」とみなす (名前は空)', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.mcp.json'), ' '.repeat(MAX_AUTORUN_FILE_BYTES + 1))
    const found = await adapter.locateProjectAutorun(cwd, allowAll)
    expect(mine(found.mcp)).toEqual([{ path: join(cwd, '.mcp.json'), names: [] }])
  })

  it('関門が断ったパスは読まない (stat の前に聞く)', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), HOOKS)
    write(join(cwd, '.mcp.json'), MCP)
    const asked: string[] = []
    const found = await adapter.locateProjectAutorun(cwd, (path) => {
      asked.push(path)
      return !path.endsWith('.mcp.json')
    })
    expect(mine(found.mcp)).toEqual([])
    expect(mine(found.hooks)).toHaveLength(1)
    expect(asked).toContain(join(cwd, '.mcp.json'))
  })
})

describe('folderNotice (項目 123、初めてのフォルダの判定)', () => {
  function deps(overrides: Partial<FolderNoticeDeps> = {}): FolderNoticeDeps & { transcriptCalls: number } {
    const fs = new FsAccess(root)
    const out = {
      transcriptCalls: 0,
      assertAllowed: (uri: string, asDirectory: boolean) => fs.assertAllowed(uri, asDirectory),
      knownCwd: () => false,
      hasTranscript: async () => {
        out.transcriptCalls += 1
        return false
      },
      locate: adapter.locateProjectAutorun.bind(adapter),
      ...overrides
    }
    return out
  }

  it('初めてで hooks / .mcp.json があれば、ファイルの URI と名前を返す', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), HOOKS)
    write(join(cwd, '.mcp.json'), MCP)
    const notice = await folderNotice(pathToUri(cwd), deps())
    expect(notice).not.toBeNull()
    expect(notice!.hooks).toEqual([{ uri: pathToUri(join(cwd, '.claude', 'settings.json')), names: ['SessionStart'] }])
    expect(notice!.mcp.filter((file) => file.uri.startsWith(pathToUri(root)))).toEqual([
      { uri: pathToUri(join(cwd, '.mcp.json')), names: ['probe'] }
    ])
  })

  it('作業フォルダの履歴にあれば出さない (転写も見ない)', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.mcp.json'), MCP)
    const d = deps({ knownCwd: (path) => path === cwd })
    expect(await folderNotice(pathToUri(cwd), d)).toBeNull()
    expect(d.transcriptCalls).toBe(0)
  })

  it('転写にそのフォルダの会話があれば出さない', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), HOOKS)
    const seen: string[][] = []
    const d = deps({
      hasTranscript: async (paths) => {
        seen.push([...paths])
        return paths.includes(cwd)
      }
    })
    expect(await folderNotice(pathToUri(cwd), d)).toBeNull()
    expect(seen).toEqual([[cwd]])
  })

  it('何も無ければ出さず、転写の一覧 (高い) も読まない', async () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    const d = deps()
    expect(await folderNotice(pathToUri(cwd), d)).toBeNull()
    expect(d.transcriptCalls).toBe(0)
  })

  it('壊れた JSON だけなら出さない', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.claude', 'settings.json'), '{ not json')
    write(join(cwd, '.mcp.json'), '')
    expect(await folderNotice(pathToUri(cwd), deps())).toBeNull()
  })

  it('除外に当たるフォルダ (~/Library の下) は何も見ずに null', async () => {
    const cwd = join(root, 'Library', 'proj')
    write(join(cwd, '.mcp.json'), MCP)
    let located = false
    const d = deps({
      locate: async (dir, allowed) => {
        located = true
        return adapter.locateProjectAutorun(dir, allowed)
      }
    })
    expect(await folderNotice(pathToUri(cwd), d)).toBeNull()
    expect(located).toBe(false)
  })

  it('除外に当たる場所を指す symlink の .mcp.json は読まない', async () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    write(join(root, '.ssh', 'mcp.json'), MCP)
    symlinkSync(join(root, '.ssh', 'mcp.json'), join(cwd, '.mcp.json'))
    write(join(cwd, '.claude', 'settings.json'), HOOKS)
    const notice = await folderNotice(pathToUri(cwd), deps())
    expect(notice).not.toBeNull()
    expect(notice!.mcp.filter((file) => file.uri.startsWith(pathToUri(root)))).toEqual([])
    expect(notice!.hooks).toHaveLength(1)
  })

  it('ファイルでない URI・存在しないフォルダ・file: 以外は null (投げない)', async () => {
    const file = join(root, 'a.txt')
    write(file, 'x')
    expect(await folderNotice(pathToUri(file), deps())).toBeNull()
    expect(await folderNotice(pathToUri(join(root, 'missing')), deps())).toBeNull()
    expect(await folderNotice('thread://x/y', deps())).toBeNull()
  })

  it('探索を持たないバックエンドなら null', async () => {
    const cwd = join(root, 'proj')
    write(join(cwd, '.mcp.json'), MCP)
    expect(await folderNotice(pathToUri(cwd), deps({ locate: undefined }))).toBeNull()
  })
})

describe('ThreadStore.hasCwd (項目 123)', () => {
  it('畳み込んだパスで履歴を引く (大小違いの綴りも同じ)', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const store = new ThreadStore(db, '/Users/tester')
    expect(store.hasCwd('/Users/tester/Proj')).toBe(false)
    store.touchCwd('/Users/tester/Proj')
    expect(store.hasCwd('/Users/tester/Proj')).toBe(true)
    expect(store.hasCwd('/users/tester/proj')).toBe(true)
    expect(store.hasCwd('/Users/tester/Other')).toBe(false)
    db.close()
  })
})

describe('folderNoticeLabel (項目 123、renderer の表示)', () => {
  it('cwd の下は相対、外はパス全体', () => {
    const cwd = pathToUri('/Users/me/proj')
    expect(folderNoticeLabel(cwd, pathToUri('/Users/me/proj/.claude/settings.json'))).toBe('.claude/settings.json')
    expect(folderNoticeLabel(cwd, pathToUri('/Users/me/.mcp.json'))).toBe('/Users/me/.mcp.json')
    expect(folderNoticeLabel(cwd, pathToUri('/Users/me/proj x/.mcp.json'))).toBe('/Users/me/proj x/.mcp.json')
  })
})
