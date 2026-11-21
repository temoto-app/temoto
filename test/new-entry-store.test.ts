// @vitest-environment jsdom
/**
 * TODO 370 (wave 20 bundle C): reflecting the tree right after creation (`store.noteCreated`).
 *
 * - File: opens in the viewer (`select`), and re-reads the list of the parent that has a cache. **Even when names starting with "." are hidden**,
 *   the chosen file goes into `keep`, so it stays in the re-read list (`.env`).
 * - Folder: re-reads the cached list in the middle and opens itself too. If its name starts with ".", it is pinned and appears in the parent's list.
 *
 * `window.aios.fs.listDirectory` is a fake (it records the arguments it was called with and returns the list it is set to). Neither the model nor Electron is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, FileEntry, ListDirectoryOptions } from '../src/shared/types.js'
import { useStore } from '../src/renderer/src/store.js'
import { useHiddenFiles } from '../src/renderer/src/hiddenFilesStore.js'

const ROOT = 'file:///w'
function entry(uri: string, isDirectory: boolean): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri: uri.slice(0, uri.lastIndexOf('/')), name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}

let listCalls: { uri: string; options: ListDirectoryOptions | undefined }[]
let disk: Record<string, FileEntry[]>

beforeEach(() => {
  listCalls = []
  disk = {
    [ROOT]: [entry(`${ROOT}/a`, true), entry(`${ROOT}/b.ts`, false)],
    [`${ROOT}/a`]: []
  }
  ;(window as unknown as { aios: unknown }).aios = {
    fs: {
      listDirectory: vi.fn(async (uri: string, options?: ListDirectoryOptions): Promise<DirectoryListing> => {
        listCalls.push({ uri, options })
        return { uri, entries: disk[uri] ?? [], live: true, reason: null }
      })
    }
  }
  useHiddenFiles.setState({ show: false, pins: new Set() })
  useStore.setState({
    roots: [entry(ROOT, true)],
    children: { [ROOT]: disk[ROOT] as FileEntry[] },
    expanded: new Set([ROOT]),
    loading: new Set(),
    results: null,
    selectedUri: null,
    revealedUri: null,
    revealTick: 0,
    revealTarget: null
  })
})

describe('store.noteCreated (TODO 370)', () => {
  it('隠しファイル (.env) を作ったら viewer に開き、隠していても引き直した親の一覧に残る (keep)', async () => {
    disk[ROOT] = [...(disk[ROOT] as FileEntry[]), entry(`${ROOT}/.env`, false)]
    await useStore.getState().noteCreated(ROOT, `${ROOT}/.env`, false)
    expect(useStore.getState().selectedUri).toBe(`${ROOT}/.env`)
    const refresh = listCalls.find((call) => call.uri === ROOT)
    expect(refresh?.options).toEqual({ showHidden: false, keep: [`${ROOT}/.env`] })
    expect(useStore.getState().children[ROOT]?.map((e) => e.name)).toContain('.env')
  })

  it('a/b/c.ts: 控えのある途中の一覧 (親・a) を引き直す', async () => {
    useStore.setState({ children: { ...useStore.getState().children, [`${ROOT}/a`]: [] } })
    disk[`${ROOT}/a`] = [entry(`${ROOT}/a/b`, true)]
    disk[`${ROOT}/a/b`] = [entry(`${ROOT}/a/b/c.ts`, false)]
    await useStore.getState().noteCreated(ROOT, `${ROOT}/a/b/c.ts`, false)
    expect(listCalls.map((call) => call.uri)).toEqual(expect.arrayContaining([ROOT, `${ROOT}/a`]))
    expect(useStore.getState().children[`${ROOT}/a`]?.map((e) => e.name)).toEqual(['b'])
  })

  it('フォルダは自身も開く。「.」始まりなら pin されて親の一覧に出る', async () => {
    disk[ROOT] = [...(disk[ROOT] as FileEntry[]), entry(`${ROOT}/.cache`, true)]
    disk[`${ROOT}/.cache`] = []
    await useStore.getState().noteCreated(ROOT, `${ROOT}/.cache`, true)
    expect(useStore.getState().expanded.has(`${ROOT}/.cache`)).toBe(true)
    expect(useHiddenFiles.getState().pins.has(`${ROOT}/.cache`)).toBe(true)
    // The parent re-read after the pin adds .cache to keep.
    await vi.waitFor(() =>
      expect(
        listCalls.some((call) => call.uri === ROOT && call.options?.keep?.includes(`${ROOT}/.cache`) === true)
      ).toBe(true)
    )
    // Not opened in the viewer (a folder is not selected).
    expect(useStore.getState().selectedUri).toBeNull()
  })
})
