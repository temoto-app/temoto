// @vitest-environment jsdom
/**
 * TODO 462 (wave 23 bundle B) / TODO 742 (wave 35 bundle A): rendering the New Thread dialog (jsdom).
 * Neither the model nor Electron is used.
 *
 * - **TODO 742: Quick Pick form**: pressing a row creates the thread as it is and closes the dialog.
 *   There is no "Cancel" / "+ New" at the bottom right. No counter is shown.
 * - When opened, focus goes to the filter field. Typing a word narrows the path; with 0 matches, "no match". The unassigned choice always appears.
 * - Typing a word selects the first matching row (nothing is created). ↑↓ move between rows (nothing is created); Enter creates with the current selection.
 * - Enter with 0 matches does nothing (a typo must not create a thread in the scratch area).
 * - The CLI's conversations are seen only through the "Conversations" button on the hovered row (pressing it does not create anything; it only selects).
 * - A folder chosen with "Open Folder…" is created as it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CreateThreadInput, CwdHistoryEntry, ThreadCreateOptions, TranscriptSession } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = 'file:///Users/me'

function entry(uri: string, useCount: number, extra: Partial<CwdHistoryEntry> = {}): CwdHistoryEntry {
  return {
    uri,
    name: 'x',
    parentName: 'y',
    lastUsedAt: 1,
    useCount,
    usable: true,
    reason: null,
    rainbow: null,
    ...extra
  }
}

const OPTIONS: ThreadCreateOptions = {
  backends: [
    {
      id: 'fake',
      label: 'Fake',
      available: true,
      message: null,
      models: [],
      modelSelect: false,
      thinkingLevel: false,
      rewind: false,
      capabilities: { approval: true, subagents: true, rewind: false, mcp: true, instructions: true },
      degradations: [],
      commands: null
    }
  ],
  defaultBackend: 'fake',
  homeUri: HOME,
  // Arrives in the order of main's SQL (most uses first).
  cwdHistory: [entry(`${HOME}/src/alpha`, 9), entry(`${HOME}/src/beta`, 3), entry('file:///opt/work', 1)]
}

const SESSION: TranscriptSession = {
  sessionId: 's1',
  uri: 'transcript://p/s1.jsonl/m',
  cwdUri: `${HOME}/src/alpha`,
  cwdName: 'alpha',
  cwdMatchKey: 'k-alpha',
  title: 'An old talk',
  firstPrompt: 'hello',
  mtimeMs: 0,
  threadId: null,
  usable: true,
  reason: null
}

let reactRoot: Root
let host: HTMLDivElement
let created: CreateThreadInput[]
let closed: number

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  created = []
  closed = 0
  ;(window as unknown as { aios: unknown }).aios = {
    threads: {
      createOptions: vi.fn(async () => OPTIONS),
      transcriptSessions: vi.fn(async () => [SESSION]),
      folderMatchKey: vi.fn(async (uri: string) => (uri.endsWith('/alpha') ? 'k-alpha' : null)),
      folderNotice: vi.fn(async () => null),
      removeCwdHistory: vi.fn(async () => undefined)
    },
    fs: { pickDirectory: vi.fn(async () => ({ uri: null, reason: null })) },
    drop: { uriFor: () => null },
    // TODO 1066: the recommendation for this PC (here, a backend that holds none = null).
    agent: { localAdvice: vi.fn(async () => null) }
  }
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useThreads.setState({
    settings: null,
    createThread: async (input: CreateThreadInput) => {
      created.push(input)
      return true
    },
    createThreadFromDrop: async () => true
  } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  reactRoot = createRoot(host)
  const { NewThreadDialog } = await import('../src/renderer/src/components/NewThreadDialog.js')
  await act(async () => {
    reactRoot.render(createElement(NewThreadDialog, { onClose: () => closed++ }))
  })
  await flush()
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

function filter(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('.new-thread-filter')
  if (input === null) throw new Error('no filter')
  return input
}

function historyPaths(): string[] {
  return Array.from(host.querySelectorAll('.new-thread-history .cwd-path')).map((el) => el.textContent ?? '')
}

function selectedText(): string {
  return host.querySelector('.cwd-row.selected')?.textContent ?? ''
}

async function type(value: string): Promise<void> {
  const input = filter()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    filter().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }))
  })
  await flush()
}

/** Finds a history row (`.new-thread-history .cwd-row`) by its path (exact match). */
function row(path: string): HTMLElement {
  const found = Array.from(host.querySelectorAll<HTMLElement>('.new-thread-history .cwd-row')).find(
    (el) => el.querySelector('.cwd-path')?.textContent === path
  )
  if (found === undefined) throw new Error(`no row for ${path}`)
  return found
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
}

describe('NewThreadDialog (TODO 462 / TODO 742)', () => {
  it('focuses the filter field on open; history is in the order it arrived (most used first) and shows no counts', () => {
    expect(document.activeElement).toBe(filter())
    expect(historyPaths()).toEqual(['~/src/alpha', '~/src/beta', '/opt/work', '~'])
    expect(host.querySelector('.new-thread-history .cwd-count')).toBeNull()
    expect(host.textContent).not.toContain('×9')
    // The unassigned choice is outside the history section (not subject to filtering) and is the default selection.
    expect(host.querySelector('.new-thread-history .scratch')).toBeNull()
    expect(selectedText()).toContain('No project')
  })

  it('filters by term and shows 「一致なし」 for 0 matches; no owner always shows', async () => {
    await type('BETA')
    expect(historyPaths()).toEqual(['~/src/beta'])
    await type('zzz')
    expect(historyPaths()).toEqual([])
    expect(host.querySelector('.new-thread-nomatch')?.textContent).toBe('No matching folders')
    expect(host.querySelector('.cwd-row.scratch')).not.toBeNull()
  })

  it('typing a term only selects the first match (does not create), ↑↓ only select, Enter creates with the current selection', async () => {
    await type('src')
    expect(selectedText()).toContain('~/src/alpha')
    expect(created).toEqual([])
    await key('ArrowDown')
    expect(selectedText()).toContain('~/src/beta')
    expect(created).toEqual([])
    await key('Enter')
    expect(created).toEqual([{ cwdUri: `${HOME}/src/beta`, backend: 'fake', modelId: null, thinking: null }])
    expect(closed).toBe(1)
  })

  it('Enter with 0 matches does nothing; Enter during composition does nothing either', async () => {
    await type('zzz')
    await key('Enter')
    expect(created).toEqual([])
    await type('')
    await key('Enter', { isComposing: true })
    expect(created).toEqual([])
  })

  it('TODO 1141: Esc during composition does not close the dialog; it closes when not composing', async () => {
    await key('Escape', { isComposing: true })
    await key('Escape', { keyCode: 229 })
    expect(closed).toBe(0)
    await key('Escape')
    expect(closed).toBe(1)
  })

  it('with an empty term Enter creates with the default (no owner); ↑ cycles to the end', async () => {
    await key('ArrowUp')
    expect(host.querySelector('.cwd-row.selected .cwd-path')?.textContent).toBe('~')
    await key('ArrowDown')
    expect(selectedText()).toContain('No project')
    await key('Enter')
    expect(created).toEqual([{ scratch: true, backend: 'fake', modelId: null, thinking: null }])
  })

  it('TODO 742: pressing a row creates the thread right away and closes the dialog (there is no lower-right button)', async () => {
    const buttons = Array.from(host.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).not.toContain('+ New')
    expect(buttons).not.toContain('Cancel')
    await click(row('~/src/beta'))
    expect(created).toEqual([{ cwdUri: `${HOME}/src/beta`, backend: 'fake', modelId: null, thinking: null }])
    expect(closed).toBe(1)
  })

  it('TODO 815: the 「所属なし」 row is a pressable row, not a heading (focusable, creates on Enter, frame CSS)', async () => {
    const row = host.querySelector<HTMLElement>('.cwd-row.scratch')
    if (row === null) throw new Error('no scratch row')
    expect(row.tabIndex).toBe(0)
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(created).toEqual([{ scratch: true, backend: 'fake', modelId: null, thinking: null }])
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const at = css.indexOf('.cwd-row.scratch {')
    expect(css.slice(at, css.indexOf('}', at))).toContain('border: 1px solid var(--line)')
    // TODO 877: the look of filled buttons (selection does not change the fill either; do not bring back 815, which looked like a heading).
    expect(css.slice(at, css.indexOf('}', at))).toContain('background: var(--bg-raised)')
    expect(css).toContain('.cwd-row.scratch.selected { background: var(--bg-raised); }')
    expect(css).toContain('.cwd-row.scratch:active')
    // The order is: filter field → unassigned choice → list
    const filter = host.querySelector('.new-thread-cwd input')
    const list = host.querySelector('.new-thread-history')
    if (filter === null || list === null) throw new Error('no filter / list')
    expect(filter.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(css).toContain('.cwd-row:focus-visible')
  })

  it('TODO 742: pressing the 「所属なし」 row creates in scratch', async () => {
    const scratchRow = host.querySelector<HTMLElement>('.cwd-row.scratch')
    if (scratchRow === null) throw new Error('no scratch row')
    await click(scratchRow)
    expect(created).toEqual([{ scratch: true, backend: 'fake', modelId: null, thinking: null }])
    expect(closed).toBe(1)
  })

  it('TODO 742: the 「Conversations」 button does not create when pressed; it only selects that row (the field below opens)', async () => {
    const button = row('~/src/alpha').querySelector<HTMLButtonElement>('.cwd-transcripts')
    if (button === null) throw new Error('no conversations button')
    await click(button)
    expect(created).toEqual([])
    expect(closed).toBe(0)
    expect(selectedText()).toContain('~/src/alpha')
    expect(host.querySelector('.new-thread-transcripts h3')?.textContent).toBe(
      'Continue a CLI conversation in this folder'
    )
    expect(host.querySelector('.transcript-row .transcript-row-continue')?.textContent).toBe('Continue')
  })

  it('× exists only on history rows (not on the home pseudo row); pressing it removes it from the history and reloads (does not create)', async () => {
    const removes = host.querySelectorAll<HTMLButtonElement>('.new-thread-history .cwd-remove')
    expect(removes).toHaveLength(3)
    await click(removes[1]!)
    const aios = (window as unknown as { aios: { threads: { removeCwdHistory: ReturnType<typeof vi.fn> } } }).aios
    expect(aios.threads.removeCwdHistory).toHaveBeenCalledWith(`${HOME}/src/beta`)
    expect(created).toEqual([])
    expect(closed).toBe(0)
  })

  it('TODO 742: creates as is in the folder chosen with 「Open Folder…」', async () => {
    const aios = (
      window as unknown as { aios: { fs: { pickDirectory: ReturnType<typeof vi.fn> } } }
    ).aios
    aios.fs.pickDirectory.mockResolvedValueOnce({ uri: `${HOME}/picked`, reason: null })
    const button = host.querySelector<HTMLButtonElement>('.new-thread-open')
    if (button === null) throw new Error('no open button')
    await click(button)
    expect(created).toEqual([{ cwdUri: `${HOME}/picked`, backend: 'fake', modelId: null, thinking: null }])
    expect(closed).toBe(1)
  })
})

describe('shrinking of the CLI conversation field (TODO 486-1, the 28th proxy verification)', () => {
  it('does not shrink a closed field (the 「続ける」 row is not cut off even next to 100 history entries)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(
      /\.settings\.new-thread > \.new-thread-transcripts:has\(> \.new-thread-disclosure\[aria-expanded="false"\]\) \{ flex-shrink: 0; \}/
    )
  })
})
