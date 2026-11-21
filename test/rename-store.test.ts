// @vitest-environment jsdom
/**
 * Code review of TODO 1145: moving the copies after a rename (`store.noteRenamed`).
 * The draft table, the open folders and the list keys do not remain on the old URI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, FileEntry } from '../src/shared/types.js'
import { useStore } from '../src/renderer/src/store.js'

const ROOT = 'file:///w'
function entry(uri: string, isDirectory: boolean): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri: uri.slice(0, uri.lastIndexOf('/')), name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}

beforeEach(() => {
  const disk: Record<string, FileEntry[]> = {
    [ROOT]: [entry(`${ROOT}/new`, true)],
    [`${ROOT}/new`]: [entry(`${ROOT}/new/sub`, true), entry(`${ROOT}/new/f.txt`, false)],
    [`${ROOT}/new/sub`]: []
  }
  ;(window as unknown as { aios: unknown }).aios = {
    fs: {
      listDirectory: vi.fn(
        async (uri: string): Promise<DirectoryListing> => ({ uri, entries: disk[uri] ?? [], live: true, reason: null })
      )
    }
  }
  useStore.setState({
    roots: [entry(ROOT, true)],
    children: {
      [ROOT]: [entry(`${ROOT}/old`, true)],
      [`${ROOT}/old`]: [entry(`${ROOT}/old/sub`, true), entry(`${ROOT}/old/f.txt`, false)],
      [`${ROOT}/old/sub`]: []
    },
    expanded: new Set([ROOT, `${ROOT}/old`, `${ROOT}/old/sub`]),
    loading: new Set(),
    viewerDrafts: {
      [`${ROOT}/old/f.txt`]: { text: 'draft', baseMtimeMs: 1 },
      [`${ROOT}/other.txt`]: { text: 'keep', baseMtimeMs: 2 }
    }
  })
})

describe('store.noteRenamed (TODO 1145)', () => {
  it('moves drafts from the old URI to the new URI (descendants too, by prefix)', async () => {
    await useStore.getState().noteRenamed(`${ROOT}/old`, `${ROOT}/new`)
    expect(Object.keys(useStore.getState().viewerDrafts).sort()).toEqual([`${ROOT}/new/f.txt`, `${ROOT}/other.txt`])
    expect(useStore.getState().viewerDrafts[`${ROOT}/new/f.txt`]?.text).toBe('draft')
  })
  it('drafts also move when the file itself is renamed', async () => {
    useStore.setState({ viewerDrafts: { [`${ROOT}/a.txt`]: { text: 'x', baseMtimeMs: 1 } } })
    await useStore.getState().noteRenamed(`${ROOT}/a.txt`, `${ROOT}/b.txt`)
    expect(Object.keys(useStore.getState().viewerDrafts)).toEqual([`${ROOT}/b.txt`])
  })
  it('removes the old URI from expanded and children, opens with the new URI and re-queries', async () => {
    await useStore.getState().noteRenamed(`${ROOT}/old`, `${ROOT}/new`)
    const { expanded, children } = useStore.getState()
    expect([...expanded].sort()).toEqual([ROOT, `${ROOT}/new`, `${ROOT}/new/sub`])
    expect(Object.keys(children).sort()).toEqual([ROOT, `${ROOT}/new`, `${ROOT}/new/sub`])
    expect(children[`${ROOT}/new`]?.map((e) => e.name)).toEqual(['sub', 'f.txt'])
  })
})
