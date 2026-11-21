/**
 * Wave 15 bundle C: around the rows of the file tree.
 *  - Item 263: the cwd of "new chat in this place" on a row (folder → itself, file → its parent). CSS for showing or not showing it
 *  - Item 264: the pure function and store behavior for aligning the tree to a file opened in the viewer (auto reveal)
 *  - Items 255 / 260 / 263: the dictionary keys and the icon conventions (currentColor only, dimensions)
 * The model is not called. `window.aios` is a minimal fake set up in this test.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../src/shared/types.js'
import {
  expandChain,
  newChatFolderName,
  newChatTarget,
  rowInView,
  shouldAutoReveal
} from '../src/renderer/src/file-tree.js'
import { useStore } from '../src/renderer/src/store.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const HOME = 'file:///Users/alice'

function entry(uri: string, isDirectory: boolean, parentUri: string | null): FileEntry {
  const name = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))
  return { uri, parentUri, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}

describe('cwd of the row\'s "new chat" (item 263)', () => {
  it('a folder is that folder, and a file is the parent folder', () => {
    expect(newChatTarget(entry(`${HOME}/git/aios`, true, `${HOME}/git`))).toBe(`${HOME}/git/aios`)
    expect(newChatTarget(entry(`${HOME}/git/aios/a.ts`, false, `${HOME}/git/aios`))).toBe(
      `${HOME}/git/aios`
    )
  })

  it('does not create for a file whose parent is unknown or for the filesystem root', () => {
    expect(newChatTarget(entry(`${HOME}/a.txt`, false, null))).toBeNull()
    expect(newChatTarget(entry('file:///', true, null))).toBeNull()
    expect(newChatTarget(entry(`${HOME}/a.txt`, false, 'file:///'))).toBeNull()
  })

  it('a search result row (file) follows the same rule (the parent is cwd)', () => {
    const hit = entry(`${HOME}/git/x/深い/メモ.md`, false, `${HOME}/git/x/深い`)
    expect(newChatTarget(hit)).toBe(`${HOME}/git/x/深い`)
    expect(newChatFolderName(`${HOME}/git/x/%E6%B7%B1%E3%81%84`)).toBe('深い')
  })
})

describe('pure function of auto reveal (item 264)', () => {
  it('does not sync while the search list is shown or when there is no selection', () => {
    expect(shouldAutoReveal(`${HOME}/a.ts`, false)).toBe(true)
    expect(shouldAutoReveal(`${HOME}/a.ts`, true)).toBe(false)
    expect(shouldAutoReveal(null, false)).toBe(false)
  })

  it('does not move a visible row (counts as "visible" only when entirely inside)', () => {
    // Row 24px, display 240px (10 rows), scroll 48px: rows 2 to 11 are fully visible.
    expect(rowInView(2, 24, 48, 240)).toBe(true)
    expect(rowInView(11, 24, 48, 240)).toBe(true)
    expect(rowInView(1, 24, 48, 240)).toBe(false)
    expect(rowInView(12, 24, 48, 240)).toBe(false)
    // If the display height is unknown (0), treat the row as not visible and fall back to scrolling.
    expect(rowInView(0, 24, 0, 0)).toBe(false)
  })

  it('when syncing to a file, does not expand itself', () => {
    const chain = [HOME, `${HOME}/git`, `${HOME}/git/a.ts`]
    expect(expandChain(chain, true)).toEqual([HOME, `${HOME}/git`])
    expect(expandChain(chain, false)).toEqual(chain)
  })
})

describe("store's auto reveal (item 264)", () => {
  const listDirectory = vi.fn(async (uri: string) => ({
    uri,
    entries: [] as FileEntry[],
    live: false,
    reason: null as string | null
  }))

  beforeEach(() => {
    listDirectory.mockClear()
    vi.stubGlobal('window', { aios: { fs: { listDirectory } } })
    useStore.setState({
      roots: [entry(HOME, true, null)],
      children: {},
      expanded: new Set<string>(),
      loading: new Set<string>(),
      selectedUri: null,
      revealedUri: 'file:///Users/alice/old',
      revealTick: 0,
      revealTarget: null,
      results: null,
      query: ''
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('opens the ancestors of the selected file and not the file itself; a marker that does not scroll if already visible', async () => {
    useStore.getState().select(`${HOME}/git/aios/a.ts`)
    await settle()
    const state = useStore.getState()
    expect([...state.expanded]).toEqual([HOME, `${HOME}/git`, `${HOME}/git/aios`])
    expect(listDirectory.mock.calls.map((call) => call[0])).toEqual([
      HOME,
      `${HOME}/git`,
      `${HOME}/git/aios`
    ])
    expect(state.revealTarget).toEqual({ uri: `${HOME}/git/aios/a.ts`, always: false })
    // The highlight is held by selectedUri. The highlight of the working folder has finished its role.
    expect(state.selectedUri).toBe(`${HOME}/git/aios/a.ts`)
    expect(state.revealedUri).toBeNull()
    expect(state.revealTick).toBe(1)
  })

  it('when ancestors are open and the list exists, does not call listDirectory (when opened by pressing a tree row)', async () => {
    useStore.setState({
      children: { [HOME]: [], [`${HOME}/git`]: [] },
      expanded: new Set([HOME, `${HOME}/git`])
    })
    useStore.getState().select(`${HOME}/git/a.ts`)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTarget?.always).toBe(false)
  })

  it('does not sync while the search list is shown', async () => {
    useStore.setState({
      results: { entries: [], total: 0, truncated: false, scanTruncated: false, tookMs: 0, cwd: null, cancelled: false }
    })
    useStore.getState().select(`${HOME}/git/aios/a.ts`)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTick).toBe(0)
    expect(useStore.getState().selectedUri).toBe(`${HOME}/git/aios/a.ts`)
  })

  it('does nothing for a file outside the tree (not under root)', async () => {
    useStore.getState().select('file:///Volumes/Data/a.ts')
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTick).toBe(0)
  })

  it('clearing the selection (null) does not call reveal, and the working folder highlight stays', async () => {
    useStore.getState().select(null)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealedUri).toBe('file:///Users/alice/old')
  })

  it('opening the working folder in the tree (item 49) also opens itself as before and always scrolls', async () => {
    await useStore.getState().reveal(`${HOME}/git`)
    const state = useStore.getState()
    expect(state.expanded.has(`${HOME}/git`)).toBe(true)
    expect(state.revealedUri).toBe(`${HOME}/git`)
    expect(state.revealTarget).toEqual({ uri: `${HOME}/git`, always: true })
  })

  /**
   * Observation for item 333 (wave 18): even when refused by an exclusion etc., main does not throw; it returns `DirectoryListing.reason`
   * (`listDirectoryGuarded` in `handlers.ts`). The renderer treats it the same as the earlier "exception → catch": it stops the expansion midway, and does not leave open what lies beyond (the excluded folder itself).
   */
  it('a folder that was refused (has a reason) is not left open, and the reveal beyond it stops too', async () => {
    listDirectory.mockImplementation(async (uri: string) =>
      uri === `${HOME}/git`
        ? { uri, entries: [], live: true, reason: 'path-excluded' }
        : { uri, entries: [], live: false, reason: null }
    )
    await useStore.getState().reveal(`${HOME}/git/aios`)
    const state = useStore.getState()
    expect(state.expanded.has(HOME)).toBe(true)
    expect(state.expanded.has(`${HOME}/git`)).toBe(false)
    expect(state.expanded.has(`${HOME}/git/aios`)).toBe(false)
    expect(state.children[`${HOME}/git`]).toBeUndefined()
  })
})

describe('appearance and dictionary (items 255 / 260 / 263)', () => {
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf-8')

  it('the row icons are visible only on hover and on the selected row, and cannot be pressed while hidden', () => {
    expect(css).toMatch(/\.row-new-chat\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/)
    expect(css).toMatch(
      /\.row:hover \.row-new-chat,\s*\.row\.selected \.row-new-chat[^{]*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/
    )
    // Leave space on the right when it appears, so that it does not overlap the abbreviated name.
    expect(css).toMatch(/\.row\.has-new-chat:hover[^{]*{\s*padding-right:\s*28px;/)
  })

  it('the "open in editor" row includes the name of the external editor (EN / JA)', () => {
    expect(translate('en', 'threadSettings.openInEditor', { editor: 'Cursor' })).toBe(
      'Open the folder in Cursor'
    )
    expect(translate('ja', 'threadSettings.openInEditor', { editor: 'VS Code' })).toBe(
      '作業フォルダを VS Code で開く'
    )
  })

  it('"新しいスレッド…" (dialog) and "そこで新しいスレッド" (create immediately) have different text', () => {
    expect(translate('ja', 'threads.new')).toBe('新しいスレッド…')
    expect(translate('en', 'threads.new')).toBe('New thread…')
    expect(translate('ja', 'threads.newInFolder', { name: 'papoo' })).toBe('papoo で新しいスレッド')
  })

  it('the create-immediately side (NewChatButton) uses the compose icon (ChatBubbleIcon was removed in TODO 408)', () => {
    // Item 408 (wave 21 bundle D): the one that creates through the dialog and the one that creates immediately use the same `ComposeIcon`
    // (only the text of the bubble differs). The two pictures `ChatBubbleIcon` / `ChatBubblePlusIcon` were removed.
    const source = readFileSync(
      new URL('../src/renderer/src/icons/ComposeIcon.tsx', import.meta.url),
      'utf-8'
    )
    expect(source).toContain('stroke="currentColor"')
    expect(source).toContain('viewBox="0 0 24 24"')
    expect(source).toContain('strokeWidth="1.5"')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/)
    const newChatButton = readFileSync(
      new URL('../src/renderer/src/components/NewChatButton.tsx', import.meta.url),
      'utf-8'
    )
    expect(newChatButton).toContain('ComposeIcon')
    expect(newChatButton).not.toMatch(/from ['"].*ChatBubbleIcon/)
  })
})
