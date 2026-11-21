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

describe('行の「新規チャット」の cwd (項目 263)', () => {
  it('フォルダはそのフォルダ、ファイルは親フォルダ', () => {
    expect(newChatTarget(entry(`${HOME}/git/aios`, true, `${HOME}/git`))).toBe(`${HOME}/git/aios`)
    expect(newChatTarget(entry(`${HOME}/git/aios/a.ts`, false, `${HOME}/git/aios`))).toBe(
      `${HOME}/git/aios`
    )
  })

  it('親が分からないファイル・ファイルシステムのルートは作らない', () => {
    expect(newChatTarget(entry(`${HOME}/a.txt`, false, null))).toBeNull()
    expect(newChatTarget(entry('file:///', true, null))).toBeNull()
    expect(newChatTarget(entry(`${HOME}/a.txt`, false, 'file:///'))).toBeNull()
  })

  it('検索結果の行 (ファイル) も同じ規則 (親が cwd)', () => {
    const hit = entry(`${HOME}/git/x/深い/メモ.md`, false, `${HOME}/git/x/深い`)
    expect(newChatTarget(hit)).toBe(`${HOME}/git/x/深い`)
    expect(newChatFolderName(`${HOME}/git/x/%E6%B7%B1%E3%81%84`)).toBe('深い')
  })
})

describe('auto reveal の純関数 (項目 264)', () => {
  it('検索の一覧が出ている間・選択が無いときは合わせない', () => {
    expect(shouldAutoReveal(`${HOME}/a.ts`, false)).toBe(true)
    expect(shouldAutoReveal(`${HOME}/a.ts`, true)).toBe(false)
    expect(shouldAutoReveal(null, false)).toBe(false)
  })

  it('見えている行は動かさない (丸ごと入っているときだけ「見えている」)', () => {
    // Row 24px, display 240px (10 rows), scroll 48px: rows 2 to 11 are fully visible.
    expect(rowInView(2, 24, 48, 240)).toBe(true)
    expect(rowInView(11, 24, 48, 240)).toBe(true)
    expect(rowInView(1, 24, 48, 240)).toBe(false)
    expect(rowInView(12, 24, 48, 240)).toBe(false)
    // If the display height is unknown (0), treat the row as not visible and fall back to scrolling.
    expect(rowInView(0, 24, 0, 0)).toBe(false)
  })

  it('ファイルに合わせるときは自分自身を展開しない', () => {
    const chain = [HOME, `${HOME}/git`, `${HOME}/git/a.ts`]
    expect(expandChain(chain, true)).toEqual([HOME, `${HOME}/git`])
    expect(expandChain(chain, false)).toEqual(chain)
  })
})

describe('store の auto reveal (項目 264)', () => {
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

  it('select したファイルの祖先を開き、ファイル自身は開かない。既に見えれば scroll しない印', async () => {
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

  it('祖先が開いていて一覧もあれば listDirectory を呼ばない (ツリーの行を押して開いた場合)', async () => {
    useStore.setState({
      children: { [HOME]: [], [`${HOME}/git`]: [] },
      expanded: new Set([HOME, `${HOME}/git`])
    })
    useStore.getState().select(`${HOME}/git/a.ts`)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTarget?.always).toBe(false)
  })

  it('検索の一覧が出ている間は合わせない', async () => {
    useStore.setState({
      results: { entries: [], total: 0, truncated: false, scanTruncated: false, tookMs: 0, cwd: null, cancelled: false }
    })
    useStore.getState().select(`${HOME}/git/aios/a.ts`)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTick).toBe(0)
    expect(useStore.getState().selectedUri).toBe(`${HOME}/git/aios/a.ts`)
  })

  it('ツリーの外 (root の配下でない) のファイルは何もしない', async () => {
    useStore.getState().select('file:///Volumes/Data/a.ts')
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealTick).toBe(0)
  })

  it('選択を外す (null) と reveal は呼ばれず、作業フォルダの強調はそのまま', async () => {
    useStore.getState().select(null)
    await settle()
    expect(listDirectory).not.toHaveBeenCalled()
    expect(useStore.getState().revealedUri).toBe('file:///Users/alice/old')
  })

  it('作業フォルダをツリーで開く (項目 49) は今までどおり自分自身も開き、必ずスクロールする', async () => {
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
  it('断られた (reason あり) フォルダは開いたままにせず、その先の reveal も止める', async () => {
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

describe('見た目と辞書 (項目 255 / 260 / 263)', () => {
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf-8')

  it('行のアイコンは hover と選択中の行でだけ見え、隠している間は押せない', () => {
    expect(css).toMatch(/\.row-new-chat\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/)
    expect(css).toMatch(
      /\.row:hover \.row-new-chat,\s*\.row\.selected \.row-new-chat[^{]*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/
    )
    // Leave space on the right when it appears, so that it does not overlap the abbreviated name.
    expect(css).toMatch(/\.row\.has-new-chat:hover[^{]*{\s*padding-right:\s*28px;/)
  })

  it('「エディタで開く」の行は外部エディタの名前を入れる (EN / JA)', () => {
    expect(translate('en', 'threadSettings.openInEditor', { editor: 'Cursor' })).toBe(
      'Open the folder in Cursor'
    )
    expect(translate('ja', 'threadSettings.openInEditor', { editor: 'VS Code' })).toBe(
      '作業フォルダを VS Code で開く'
    )
  })

  it('「新しいスレッド…」(ダイアログ) と「そこで新しいスレッド」(すぐ作る) は別の文言', () => {
    expect(translate('ja', 'threads.new')).toBe('新しいスレッド…')
    expect(translate('en', 'threads.new')).toBe('New thread…')
    expect(translate('ja', 'threads.newInFolder', { name: 'papoo' })).toBe('papoo で新しいスレッド')
  })

  it('すぐ作る側 (NewChatButton) は compose アイコン (ChatBubbleIcon は TODO 408 で撤去)', () => {
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
