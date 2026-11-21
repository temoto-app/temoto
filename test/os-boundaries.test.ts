/**
 * TODO 986 stage 1: OS-specific entry points must not exist outside `src/main/os/` / `src/common/os/` (ARCHITECTURE 3.4).
 *
 * The same check as the lint (`npm run lint:os`) is called from here too, so it fails under `npm test` as well. In addition,
 * it is confirmed with planted violations that **the check really does catch violations** (the same idea as `test/plugin-boundaries.test.ts`).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- the lint body is .mjs and has no types (built the same way as the other boundary lints)
import { checkOsBoundaries, checkOsSource, staleOsExceptions } from '../scripts/lint-os-boundaries.mjs'
import { makeTestDir } from './helpers/tmp.js'

type Violation = { file: string; line: number; message: string }
const repoRoot = new URL('..', import.meta.url).pathname
const temporary: string[] = []
const check = (text: string, name = 'src/main/x.ts'): Violation[] => checkOsSource(text, name) as Violation[]

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway src tree for running a planted violation through the check. */
function fixture(files: Record<string, string>): string {
  const root = makeTestDir('os-boundary')
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('OS の口の外に OS 固有の口が無い (TODO 986)', () => {
  it('アプリのコードは 1 件も違反していない', () => {
    expect(checkOsBoundaries(repoRoot)).toEqual([])
  })

  it('例外の表は実在するファイルだけを指す', () => {
    expect(staleOsExceptions(repoRoot)).toEqual([])
  })

  it('例外にはどれも理由があり、段 2 で寄せるものは印が付いている', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/os-boundaries.json'), 'utf8')) as {
      exceptions: { path: string; reason: string; stage?: number }[]
    }
    for (const e of config.exceptions) {
      expect(e.reason.length).toBeGreaterThan(10)
      if (e.reason.startsWith('段 2')) expect(e.stage).toBe(2)
    }
  })

  it('process.platform を捕まえる (globalThis.process と添字の形も)', () => {
    expect(check("if (process.platform !== 'darwin') {}\n")).toHaveLength(1)
    expect(check('const p = globalThis.process.platform\n')).toHaveLength(1)
    expect(check("const p = process['platform']\n")).toHaveLength(1)
  })

  it('OS / process のモジュールからの platform を捕まえる', () => {
    expect(check("import { platform } from 'node:process'\n")).toHaveLength(1)
    expect(check("import { platform as p } from 'node:os'\n")).toHaveLength(1)
    expect(check("import os from 'node:os'\nconst p = os.platform()\n")).toHaveLength(1)
    expect(check("import * as os from 'os'\nconst p = os.platform\n")).toHaveLength(1)
  })

  it('platform という名前の普通の値は拒まない', () => {
    expect(check('const x = deps.platform\nfunction f(platform: string) { return platform }\n')).toEqual([])
    expect(check("import { homedir } from 'node:os'\n")).toEqual([])
  })

  it('electron の macOS だけの API を捕まえる', () => {
    expect(check("import { systemPreferences } from 'electron'\n")).toHaveLength(1)
    expect(check("app.dock?.setBadge('1')\n")).toHaveLength(1)
    expect(check('powerMonitor.getCurrentThermalState()\n')).toHaveLength(1)
    expect(check('other.dock = 1\n')).toEqual([])
    // TODO 1238: the open flags that some OSes lack stay inside src/common/os/open-flags.ts.
    expect(check("import { constants } from 'node:fs'\nopenSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)\n")).toHaveLength(1)
    expect(check('const f = fs.constants.O_NONBLOCK\n')).toHaveLength(1)
  })

  it('道具の名前と置き場所を捕まえる', () => {
    expect(check("execFile('/usr/bin/pmset', ['-g'])\n")).toHaveLength(1)
    expect(check("const T = 'osascript'\n")).toHaveLength(1)
    expect(check("run('codesign', ['-dv'])\n")).toHaveLength(1)
    expect(check("const S = '/bin/zsh'\n")).toHaveLength(1)
    expect(check("const L = '~/Library/Mail'\n")).toHaveLength(1)
    expect(check("const A = '/Applications'\n")).toHaveLength(1)
    expect(check("const I = 'Library/Mobile Documents'\n")).toHaveLength(1)
    expect(check("const U = 'x-apple.systempreferences:com.apple.preference.security'\n")).toHaveLength(1)
  })

  it("短い名前 ('open' 等) は子プロセスを起こす呼び出しの第 1 引数でだけ捕まえる", () => {
    expect(check("execFile('open', ['-a', 'Terminal', f])\n")).toHaveLength(1)
    expect(check("this.spawn('open', ['-a', app, path])\n")).toHaveLength(1)
    expect(check("peer.request('open', x)\nconst k = { kind: 'open' }\n")).toEqual([])
  })

  it('コメントの中の道具の名前は拒まない', () => {
    expect(check('// pmset -g を読む\n/** `process.platform` は口で読む */\nconst a = 1\n')).toEqual([])
  })

  it('木の上でも捕まえ、口と例外のディレクトリは見ない', () => {
    const root = fixture({
      'src/main/evil.ts': "export const p = process.platform\n",
      'src/index-kernel/evil.ts': "export const d = '/usr/sbin/diskutil'\n",
      'src/main/os/gate.ts': "export const p = process.platform\n",
      'src/common/os/gate.ts': "export const t = '/usr/bin/pmset'\n",
      'src/main/approval/outbound.ts': "run('osascript', [])\n"
    })
    const files = (checkOsBoundaries(root) as Violation[]).map((v) => v.file).sort()
    expect(files).toEqual(['src/index-kernel/evil.ts', 'src/main/evil.ts'])
  })
})
