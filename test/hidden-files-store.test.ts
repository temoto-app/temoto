/**
 * @vitest-environment jsdom
 *
 * renderer tree (`store.ts`) and "show hidden files" (`hiddenFilesStore.ts`, TODO 261).
 *
 * - By default (hidden), `showHidden: false` is attached when a list is requested.
 * - Revealing the working folder `~/.aios-v17/real` (item 49) opens the way even while hidden: when `.aios-v17` is opened it is pinned, and the parent (home) list is requested again with `keep`.
 * - On the notice that the display changed (all windows), the open lists are requested again. The saved copies of closed lists are discarded.
 *
 * Stubs only the minimum of `window.aios.fs`. The narrowing on the index process side is in `hidden-files.test.ts`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, FileEntry, ListDirectoryOptions } from '../src/shared/types.js'

const HOME = 'file:///Users/me'

function entry(uri: string, isDirectory = true): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    name,
    isDirectory,
    size: 0,
    mtimeMs: 0,
    ext: ''
  }
}

/** Stands in for the disk. With `showHidden: false`, it keeps only the entries starting with "." that match `keep` (the same rule as the index process). */
const tree: Record<string, readonly FileEntry[]> = {
  [HOME]: [entry(`${HOME}/.aios-v17`), entry(`${HOME}/.git`), entry(`${HOME}/git`)],
  [`${HOME}/.aios-v17`]: [entry(`${HOME}/.aios-v17/real`)],
  [`${HOME}/.aios-v17/real`]: [entry(`${HOME}/.aios-v17/real/plan.md`, false)],
  [`${HOME}/git`]: [entry(`${HOME}/git/.env`, false), entry(`${HOME}/git/a.ts`, false)]
}

const calls: { uri: string; options: ListDirectoryOptions | undefined }[] = []
let showHidden = false
let onHiddenChanged: ((show: boolean) => void) | null = null

function list(uri: string, options?: ListDirectoryOptions): Promise<DirectoryListing> {
  calls.push({ uri, options })
  const all = tree[uri] ?? []
  const entries =
    options?.showHidden === false
      ? all.filter(
          (e) =>
            !e.name.startsWith('.') ||
            (options.keep ?? []).some((k) => k === e.uri || k.startsWith(`${e.uri}/`))
        )
      : all
  return Promise.resolve({ uri, entries, live: false, reason: null })
}

beforeAll(() => {
  ;(globalThis as { window: typeof window }).window = globalThis.window ?? ({} as typeof window)
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      app: { getInfo: vi.fn().mockResolvedValue({}) },
      fs: {
        roots: vi.fn().mockResolvedValue([entry(HOME)]),
        getScanStatus: vi.fn().mockResolvedValue(null),
        onScanStatus: vi.fn().mockReturnValue(() => {}),
        onFileChanges: vi.fn().mockReturnValue(() => {}),
        listDirectory: vi.fn(list),
        getShowHidden: vi.fn(() => Promise.resolve(showHidden)),
        setShowHidden: vi.fn((show: boolean) => {
          showHidden = show
          queueMicrotask(() => onHiddenChanged?.(show))
          return Promise.resolve(show)
        }),
        onShowHiddenChanged: vi.fn((listener: (show: boolean) => void) => {
          onHiddenChanged = listener
          return () => {}
        })
      },
      search: {},
      threads: {}
    }
  })
})

const names = (children: readonly FileEntry[] | undefined): string[] =>
  (children ?? []).map((e) => e.name)

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('ツリーと隠しファイル (TODO 261)', () => {
  it('既定は隠す: 最初の一覧から showHidden: false を添える', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    await useStore.getState().init()
    expect(calls[0]).toEqual({ uri: HOME, options: { showHidden: false } })
    expect(names(useStore.getState().children[HOME])).toEqual(['git'])
  })

  it('隠しフォルダの中の作業フォルダへの reveal は道を開け、親の一覧にも出る', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useHiddenFiles } = await import('../src/renderer/src/hiddenFilesStore.js')
    await useStore.getState().reveal(`${HOME}/.aios-v17/real`)
    await settle()
    const state = useStore.getState()
    expect(state.revealedUri).toBe(`${HOME}/.aios-v17/real`)
    expect(names(state.children[HOME])).toEqual(['.aios-v17', 'git'])
    expect(names(state.children[`${HOME}/.aios-v17`])).toEqual(['real'])
    expect(names(state.children[`${HOME}/.aios-v17/real`])).toEqual(['plan.md'])
    expect([...useHiddenFiles.getState().pins]).toEqual([`${HOME}/.aios-v17`])
    // An unrelated `.git` stays hidden.
    expect(names(state.children[HOME])).not.toContain('.git')
  })

  it('見せ方の切り替えで、開いている一覧を引き直す。隠し直しても reveal の道は残る', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useHiddenFiles } = await import('../src/renderer/src/hiddenFilesStore.js')
    await useHiddenFiles.getState().toggle()
    await settle()
    await settle()
    expect(useHiddenFiles.getState().show).toBe(true)
    expect(names(useStore.getState().children[HOME])).toEqual(['.aios-v17', '.git', 'git'])

    await useHiddenFiles.getState().toggle()
    await settle()
    await settle()
    expect(useHiddenFiles.getState().show).toBe(false)
    expect(names(useStore.getState().children[HOME])).toEqual(['.aios-v17', 'git'])
  })

  it('見せている間にユーザが開いた「.」始まりは pin しない (隠したら消える)', async () => {
    const { pinForExpand, useHiddenFiles } = await import('../src/renderer/src/hiddenFilesStore.js')
    useHiddenFiles.setState({ show: true })
    expect(pinForExpand(`${HOME}/.git`)).toBe(false)
    useHiddenFiles.setState({ show: false })
    expect([...useHiddenFiles.getState().pins]).not.toContain(`${HOME}/.git`)
  })

  it('a `row` reveal (Files back / forward, TODO 1257) shows a dot-file row while hidden files are hidden', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useHiddenFiles } = await import('../src/renderer/src/hiddenFilesStore.js')
    expect(useHiddenFiles.getState().show).toBe(false)
    // The parent is already listed (without the dot-file) before the row is asked for.
    await useStore.getState().expand(`${HOME}/git`)
    expect(names(useStore.getState().children[`${HOME}/git`])).toEqual(['a.ts'])
    await useStore.getState().reveal(`${HOME}/git/.env`, { row: true })
    const state = useStore.getState()
    expect(names(state.children[`${HOME}/git`])).toEqual(['.env', 'a.ts'])
    expect(state.revealTarget?.uri).toBe(`${HOME}/git/.env`)
    // The row is no highlight owner: `revealedUri` stays as it was.
    expect(state.revealedUri).not.toBe(`${HOME}/git/.env`)
  })
})
