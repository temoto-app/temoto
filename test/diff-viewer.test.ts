/**
 * @vitest-environment jsdom
 *
 * diff viewer (item 104, ARCHITECTURE.md 7.4.6).
 *
 *  - The limit check (`MAX_DIFF_BYTES`, 256 KB per side in UTF-8)
 *  - `mountDiffView` marks changes with classes in both the one-column and side-by-side layouts (`@codemirror/merge` renders in jsdom)
 *  - Above the limit, no diff is computed and the two sides are only shown side by side
 *  - The one-column / side-by-side buttons announce the layout change
 *  - The manifest claims `payloads: ["diff"]` and does not appear in URI resolution
 *
 * This does not go through the bridge, so the text language is set with `setViewerLocale`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { MAX_DIFF_BYTES, exceedsDiffLimit, type DiffSide } from '../src/shared/plugin.js'
import { mountDiffView, shouldSkipDiff, type DiffLayout } from '../plugins/aios.diff/viewer/diff-view.js'
import { setViewerLocale } from '../plugins/_shared/i18n.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => null } }))

const side = (name: string, text: string, language: string | null = null): DiffSide => ({
  name,
  text,
  language
})

describe('diff limit (MAX_DIFF_BYTES)', () => {
  it('computes up to exactly 256 KB and does not compute 1 byte over', () => {
    expect(MAX_DIFF_BYTES).toBe(256 * 1024)
    expect(exceedsDiffLimit('a'.repeat(MAX_DIFF_BYTES))).toBe(false)
    expect(exceedsDiffLimit('a'.repeat(MAX_DIFF_BYTES + 1))).toBe(true)
  })

  it('measures by UTF-8 bytes, not characters', () => {
    // The hiragana letter is 3 bytes in UTF-8. 90,000 of them are 270,000 bytes, so the byte count goes over the limit even when the character count is inside it.
    expect(exceedsDiffLimit('あ'.repeat(90_000))).toBe(true)
    expect(exceedsDiffLimit('あ'.repeat(80_000))).toBe(false)
  })

  it('does not compute if either side exceeds', () => {
    const big = 'x\n'.repeat(MAX_DIFF_BYTES)
    expect(shouldSkipDiff(side('a', 'x'), side('a', big))).toBe(true)
    expect(shouldSkipDiff(side('a', big), side('a', 'x'))).toBe(true)
    expect(shouldSkipDiff(side('a', 'x'), side('a', 'y'))).toBe(false)
  })
})

describe('mountDiffView', () => {
  let root: HTMLElement
  beforeEach(() => {
    setViewerLocale('ja')
    root = document.createElement('div')
    document.body.append(root)
  })
  afterEach(() => {
    root.remove()
  })

  const before = side('a.ts', 'const a = 1\nconst b = 2\n')
  const after = side('a.ts', 'const a = 1\nconst b = 3\nconst c = 4\n')

  it('the single-column view (default) marks added lines on the changed body and inserts the removed lines', () => {
    const view = mountDiffView(root, { before, after, theme: 'light', layout: 'unified', onLayoutChange: () => {} })
    expect(view.mode).toBe('unified')
    const editor = root.querySelector('.diff-unified .cm-editor')
    expect(editor).not.toBeNull()
    expect(editor?.classList.contains('cm-merge-b')).toBe(true)
    const changed = [...root.querySelectorAll('.cm-changedLine')].map((line) => line.textContent)
    expect(changed).toContain('const c = 4')
    // Deleted lines appear above as read-only inserted chunks (`.cm-deletedChunk`). No accept or reject buttons are shown.
    expect(root.querySelector('.cm-deletedChunk')?.textContent).toContain('const b = 2')
    expect(root.querySelector('.cm-chunkButtons')).toBeNull()
    // Read-only.
    expect(root.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    view.destroy()
  })

  it('the side-by-side view marks changes on both the left (before) and the right (after)', () => {
    const view = mountDiffView(root, { before, after, theme: 'dark', layout: 'split', onLayoutChange: () => {} })
    expect(view.mode).toBe('split')
    expect(root.querySelector('.cm-mergeView')).not.toBeNull()
    const left = root.querySelector('.cm-merge-a')
    const right = root.querySelector('.cm-merge-b')
    expect(left?.querySelector('.cm-changedLine')?.textContent).toBe('const b = 2')
    expect([...(right?.querySelectorAll('.cm-changedLine') ?? [])].map((l) => l.textContent)).toEqual([
      'const b = 3',
      'const c = 4'
    ])
    view.destroy()
  })

  it('over the limit, does not compute the diff and shows the two side by side with a note (the layout button is not shown either)', () => {
    const big = 'line\n'.repeat(Math.ceil(MAX_DIFF_BYTES / 5) + 1)
    const view = mountDiffView(root, {
      before: side('big.txt', big),
      after: side('big.txt', big + 'tail\n'),
      theme: 'light',
      layout: 'unified',
      onLayoutChange: () => {}
    })
    expect(view.mode).toBe('plain')
    expect(root.querySelector('.cm-mergeView')).toBeNull()
    expect(root.querySelector('.cm-changedLine')).toBeNull()
    expect(root.querySelector('.cm-merge-b')).toBeNull()
    expect(root.querySelectorAll('.diff-plain .diff-column .cm-editor')).toHaveLength(2)
    expect(root.querySelector('.banner')?.textContent).toContain('大きすぎる')
    expect(root.querySelectorAll('button[data-layout]')).toHaveLength(0)
    view.destroy()
  })

  it('the single-column / side-by-side buttons report the pressed layout (pressing the current layout does not report)', () => {
    const calls: DiffLayout[] = []
    const view = mountDiffView(root, {
      before,
      after,
      theme: 'light',
      layout: 'unified',
      onLayoutChange: (layout) => calls.push(layout)
    })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-layout]')]
    expect(buttons.map((b) => b.textContent)).toEqual(['1 列', '横並び'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    buttons[0]?.click()
    buttons[1]?.click()
    expect(calls).toEqual(['split'])
    view.destroy()
  })

  it('when the names differ, shows "before → after" in the heading', () => {
    const view = mountDiffView(root, {
      before: side('old.md', 'a'),
      after: side('new.md', 'b'),
      theme: 'light',
      layout: 'unified',
      onLayoutChange: () => {}
    })
    expect(root.querySelector('.diff-names')?.textContent).toBe('old.md → new.md')
    view.destroy()
  })

  // Wave 13 bundle F (item 138, small observation 4): the fold label of `@codemirror/merge`
  // (`state.phrase("$ unchanged lines", n)`) is translated when the display language is Japanese.
  it('the folding of unchanged lines stays Japanese in the Japanese UI and English in the English UI', () => {
    const manyLines = (prefix: string): string =>
      Array.from({ length: 30 }, (_, i) => `${prefix}${i}`).join('\n') + '\n'
    const beforeMany = side('big.ts', manyLines('line'))
    const afterMany = side('big.ts', `changed\n${manyLines('line').slice('line0\n'.length)}`)

    setViewerLocale('ja')
    const jaView = mountDiffView(root, {
      before: beforeMany,
      after: afterMany,
      theme: 'light',
      layout: 'unified',
      onLayoutChange: () => {}
    })
    const jaCollapsed = root.querySelector('.cm-collapsedLines')
    expect(jaCollapsed).not.toBeNull()
    expect(jaCollapsed?.textContent).toMatch(/行は変更なし/)
    jaView.destroy()

    setViewerLocale('en')
    const enView = mountDiffView(root, {
      before: beforeMany,
      after: afterMany,
      theme: 'light',
      layout: 'unified',
      onLayoutChange: () => {}
    })
    const enCollapsed = root.querySelector('.cm-collapsedLines')
    expect(enCollapsed).not.toBeNull()
    expect(enCollapsed?.textContent).toMatch(/unchanged lines/)
    enView.destroy()
    setViewerLocale('ja')
  })
})

describe('aios.diff claim (PluginHost)', () => {
  // In the jsdom environment import.meta.url does not become file:, so take the path from vitest's working directory (the repo).
  const repoRoot = process.cwd()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-diff-host-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function host(): Promise<import('../src/main/plugin/host.js').PluginHost> {
    const { runMigrations } = await import('../src/common/migrations.js')
    const { PluginHost } = await import('../src/main/plugin/host.js')
    const db = new Database(':memory:')
    runMigrations(db)
    const plugins = new PluginHost({
      db,
      // Read the canonical manifests of the bundled plugins as they are. `_shared` has no manifest, so it is skipped.
      bundledDir: join(repoRoot, 'plugins'),
      userDir: join(dir, 'user'),
      hostEntry: join(dir, 'host.js'),
      broker: () => {
        throw new Error('not used')
      },
      onChanged: () => {}
    })
    plugins.load()
    return plugins
  }

  it('for the diff kind, aios.diff claims it and returns it as not writable', async () => {
    const plugins = await host()
    expect(plugins.resolvePayloadViewer('diff')).toEqual({
      pluginId: 'aios.diff',
      name: 'Diff',
      // TODO 1144 stage 3: the viewer URL has the version in it (`@<manifest version>/`).
      url: `aios-plugin://aios.diff/@${JSON.parse(readFileSync(join(repoRoot, 'plugins', 'aios.diff', 'manifest.json'), 'utf8')).version}/viewer/index.html`,
      editable: false
    })
  })

  it('URI resolution: only .diff / .patch are claimed (TODO 901), and the fallback aios.text is not taken over', async () => {
    const plugins = await host()
    expect(plugins.resolveViewer('file:///tmp/x.unknown')?.pluginId).toBe('aios.text')
    expect(plugins.resolveViewer('file:///tmp/x.diff')).toMatchObject({ pluginId: 'aios.diff', editable: false, delivery: 'text' })
    expect(plugins.resolveViewer('file:///tmp/X.PATCH')).toMatchObject({ pluginId: 'aios.diff', delivery: 'text' })
    expect(plugins.resolveViewer('file:///tmp/x.md')?.pluginId).toBe('aios.markdown')
  })
})
