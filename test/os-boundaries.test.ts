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

describe('no OS-specific entry outside the OS gate (TODO 986)', () => {
  it('app code has no violation at all', () => {
    expect(checkOsBoundaries(repoRoot)).toEqual([])
  })

  it('the exceptions table points only to files that exist', () => {
    expect(staleOsExceptions(repoRoot)).toEqual([])
  })

  it('every exception has a reason and those to be moved in stage 2 are marked', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/os-boundaries.json'), 'utf8')) as {
      exceptions: { path: string; reason: string; stage?: number }[]
    }
    for (const e of config.exceptions) {
      expect(e.reason.length).toBeGreaterThan(10)
      if (e.reason.startsWith('段 2')) expect(e.stage).toBe(2)
    }
  })

  it('catches process.platform (also globalThis.process and the subscript form)', () => {
    expect(check("if (process.platform !== 'darwin') {}\n")).toHaveLength(1)
    expect(check('const p = globalThis.process.platform\n')).toHaveLength(1)
    expect(check("const p = process['platform']\n")).toHaveLength(1)
  })

  it('catches platform from OS / process modules', () => {
    expect(check("import { platform } from 'node:process'\n")).toHaveLength(1)
    expect(check("import { platform as p } from 'node:os'\n")).toHaveLength(1)
    expect(check("import os from 'node:os'\nconst p = os.platform()\n")).toHaveLength(1)
    expect(check("import * as os from 'os'\nconst p = os.platform\n")).toHaveLength(1)
  })

  it('does not reject an ordinary value named platform', () => {
    expect(check('const x = deps.platform\nfunction f(platform: string) { return platform }\n')).toEqual([])
    expect(check("import { homedir } from 'node:os'\n")).toEqual([])
  })

  it("catches electron's macOS-only API", () => {
    expect(check("import { systemPreferences } from 'electron'\n")).toHaveLength(1)
    expect(check("app.dock?.setBadge('1')\n")).toHaveLength(1)
    expect(check('powerMonitor.getCurrentThermalState()\n')).toHaveLength(1)
    expect(check('other.dock = 1\n')).toEqual([])
    // TODO 1238: the open flags that some OSes lack stay inside src/common/os/open-flags.ts.
    expect(check("import { constants } from 'node:fs'\nopenSync(p, constants.O_RDONLY | constants.O_NOFOLLOW)\n")).toHaveLength(1)
    expect(check('const f = fs.constants.O_NONBLOCK\n')).toHaveLength(1)
  })

  it('catches tool names and locations', () => {
    expect(check("execFile('/usr/bin/pmset', ['-g'])\n")).toHaveLength(1)
    expect(check("const T = 'osascript'\n")).toHaveLength(1)
    expect(check("run('codesign', ['-dv'])\n")).toHaveLength(1)
    expect(check("const S = '/bin/zsh'\n")).toHaveLength(1)
    expect(check("const L = '~/Library/Mail'\n")).toHaveLength(1)
    expect(check("const A = '/Applications'\n")).toHaveLength(1)
    expect(check("const I = 'Library/Mobile Documents'\n")).toHaveLength(1)
    expect(check("const U = 'x-apple.systempreferences:com.apple.preference.security'\n")).toHaveLength(1)
  })

  it("catches short names ('open' etc.) only as the first argument of a call that spawns a child process", () => {
    expect(check("execFile('open', ['-a', 'Terminal', f])\n")).toHaveLength(1)
    expect(check("this.spawn('open', ['-a', app, path])\n")).toHaveLength(1)
    expect(check("peer.request('open', x)\nconst k = { kind: 'open' }\n")).toEqual([])
  })

  it('does not reject a tool name inside a comment', () => {
    expect(check('// pmset -g を読む\n/** `process.platform` は口で読む */\nconst a = 1\n')).toEqual([])
  })

  it('also catches on the tree and does not look at the gate and exception directories', () => {
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
