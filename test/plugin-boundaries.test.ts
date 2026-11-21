/**
 * **The test for the completion condition of Phase 4 itself** (IMPLEMENTATION_BRIEF chapter 6).
 *
 *   "The standard plugins do not call main's API directly (checked by lint / tests)"
 *
 * The same check as the lint (`npm run lint:plugins`) is called from here too, so it fails under `npm test` as well. In addition,
 * it is confirmed with planted violating files that **the check really does catch violations** (so as not to call a check that never fails "passing").
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- the lint body is .mjs and has no types (built the same way as the constraint 6 lint)
import { checkPluginBoundaries } from '../scripts/lint-plugin-boundaries.mjs'
import { makeTestDir } from './helpers/tmp.js'

const repoRoot = new URL('..', import.meta.url).pathname
const temporary: string[] = []

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway plugins tree for running a planted violation through the check. */
function fixture(files: Record<string, string>): string {
  const root = makeTestDir('boundary')
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, 'plugins', path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('完了条件: plugins/ から main の API を直接呼んでいない', () => {
  it('同梱プラグインは 1 件も違反していない', () => {
    const violations = checkPluginBoundaries(repoRoot) as { file: string; message: string }[]
    expect(violations).toEqual([])
  })

  it('src/main/ への import を捕まえる', () => {
    const root = fixture({
      'evil/viewer.ts': "import { FsService } from '../../src/main/fs/service.js'\n"
    })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.some((v) => v.message.includes('src/main/'))).toBe(true)
  })

  it('electron の import を捕まえる', () => {
    const root = fixture({ 'evil/viewer.ts': "import { ipcRenderer } from 'electron'\n" })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.some((v) => v.message.includes('electron'))).toBe(true)
  })

  it('node:fs / node:net の import を捕まえる', () => {
    const root = fixture({
      'evil/a.ts': "import { readFileSync } from 'node:fs'\n",
      'evil/b.ts': "import { createServer } from 'node:net'\n"
    })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.some((v) => v.message.includes('node:fs'))).toBe(true)
    expect(violations.some((v) => v.message.includes('node:net'))).toBe(true)
  })

  it('動的 import と require を捕まえる', () => {
    const root = fixture({
      'evil/a.ts': "const fs = await import('node:fs')\n",
      'evil/b.ts': "const fs = require('node:fs')\n"
    })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.length).toBeGreaterThanOrEqual(2)
  })

  it('window.aios への到達を捕まえる', () => {
    const root = fixture({ 'evil/viewer.ts': 'void window.aios.fs.readResource("x")\n' })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.some((v) => v.message.includes('window'))).toBe(true)
  })

  it('process.parentPort (plugin-host の素の口) を捕まえる', () => {
    const root = fixture({ 'evil/host.ts': 'process.parentPort.postMessage({})\n' })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.length).toBeGreaterThanOrEqual(1)
  })

  it('許した import (@shared / @pluginshared / 相対) は通す', () => {
    const root = fixture({
      'ok/viewer.ts':
        "import { renderMarkdown } from '@shared/markdown/render.js'\n" +
        "import { connect } from '@pluginshared/bridge.js'\n" +
        "import { thing } from './thing.js'\n" +
        "import { EditorView } from '@codemirror/view'\n",
      'ok/thing.ts': 'export const thing = 1\n'
    })
    expect(checkPluginBoundaries(root)).toEqual([])
  })

  it('許していない外部パッケージを捕まえる', () => {
    const root = fixture({ 'evil/viewer.ts': "import axios from 'axios'\n" })
    const violations = checkPluginBoundaries(root) as { message: string }[]
    expect(violations.some((v) => v.message.includes('axios'))).toBe(true)
  })

  // TODO 695: the regular expression version (IMPORT_RE) mistook `import` / `from` inside string literals or comments
  // for import statements. It was replaced with syntax parsing, so confirm that a word appearing only as text is not a violation.
  it('文字列リテラルの中の import / from は違反にしない', () => {
    const root = fixture({
      'ok/viewer.ts':
        "const msg = 'import x from node:fs'\n" +
        'const tpl = `this sentence has from and import in it`\n' +
        "export const label = \"from here you can't import electron\"\n"
    })
    expect(checkPluginBoundaries(root)).toEqual([])
  })

  // code-review (TODO 695): the syntax tree walk did not look at imports in type positions (`ImportTypeNode`).
  it('型の位置の import (typeof import / import(…).T) を捕まえる', () => {
    const root = fixture({
      'evil/a.ts': "type E = typeof import('electron')\nexport type { E }\n",
      'evil/b.ts': "export type S = import('../../src/main/fs/service.js').FsService\n",
      'evil/c.ts': "export let fs: typeof import('node:fs') | undefined\n"
    })
    const violations = checkPluginBoundaries(root) as { file: string; message: string }[]
    expect(violations.some((v) => v.file.endsWith('a.ts') && v.message.includes('electron'))).toBe(true)
    expect(violations.some((v) => v.file.endsWith('b.ts') && v.message.includes('src/main/'))).toBe(true)
    expect(violations.some((v) => v.file.endsWith('c.ts') && v.message.includes('node:fs'))).toBe(true)
  })

  it('コメントの中の import / from は違反にしない', () => {
    const root = fixture({
      'ok/viewer.ts':
        "// import { ipcRenderer } from 'electron'\n" +
        '/* import fs from node:fs */\n' +
        "export const x = 1 // from node:fs, not really\n"
    })
    expect(checkPluginBoundaries(root)).toEqual([])
  })
})
