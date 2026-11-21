// @vitest-environment jsdom
/**
 * `.app` rows (TODO 871): even if an open state remains (the reveal path, the memory of the previous version), the rows inside are not shown.
 * How the icon is fetched (main) uses electron's `nativeImage.createThumbnailFromPath`, which cannot run under plain Node, so it is not checked here
 * (for the real check, see the bundle C section of the note `wave43.md`).
 */
import { describe, expect, it } from 'vitest'
import { selectRows, type TreeState } from '../src/renderer/src/store.js'
import type { FileEntry } from '../src/shared/types.js'

function entry(uri: string, name: string, isDirectory: boolean): FileEntry {
  return { uri, parentUri: uri.slice(0, uri.lastIndexOf('/')), name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}

describe('selectRows and .app (TODO 871)', () => {
  const apps = entry('file:///Applications', 'Applications', true)
  const bundle = entry('file:///Applications/X.app', 'X.app', true)
  const folder = entry('file:///Applications/Tools', 'Tools', true)
  const state = (expanded: string[]): TreeState => ({
    roots: [apps],
    children: {
      [apps.uri]: [bundle, folder],
      [bundle.uri]: [entry(`${bundle.uri}/Contents`, 'Contents', true)],
      [folder.uri]: [entry(`${folder.uri}/a.txt`, 'a.txt', false)]
    },
    expanded: new Set(expanded),
    loading: new Set()
  })

  it('an opened .app shows no inner rows and expanded is false', () => {
    const rows = selectRows(state([apps.uri, bundle.uri]))
    expect(rows.map((row) => row.entry.name)).toEqual(['Applications', 'X.app', 'Tools'])
    expect(rows[1]?.expanded).toBe(false)
  })

  it('a normal folder opens as before', () => {
    const rows = selectRows(state([apps.uri, folder.uri]))
    expect(rows.map((row) => row.entry.name)).toEqual(['Applications', 'X.app', 'Tools', 'a.txt'])
  })
})
