/**
 * Material for the search that puts "inside the current cwd" first (item 100, ARCHITECTURE.md 6.6.7).
 *
 * fs rows carry no absolute path (12.4), so "is it under the cwd?" is decided with a
 * **subtree of the directory tree**. The material is the covering partial index of `documents_dir_tree`
 * (`IndexStore.fsDirectories`), built from the same single read as the path table of file-name search (6.6).
 *
 * - The subtree is walked **by id parent/child links, not by string prefix match**. This structurally
 *   guarantees that `/a/foobar` is not included for a cwd of `/a/foo` (the same pitfall as T19), and that
 *   NFKC folding for matching (`foldForMatch`) cannot collapse `①` and `1` into the same path.
 * - The cwd path -> row id lookup walks the tree rows from the root (names folded with `foldPath`,
 *   the same folding as the unique index on `documents_tree`). `IndexStore.findByPath` is not used:
 *   on an empty DB it **creates** the root row (`ensureRoot`), which would make the search path write.
 * - The tree is rebuilt only when `treeRevision` changes (a file-row upsert does not change it).
 *
 * **Never writes.** IndexService is the only writer (6.2); this only reads.
 */
import { foldPath } from '../common/uri.js'
import type { IndexStore } from './store.js'
import { foldForMatch } from './name-search.js'
import { nfkc } from './smart-case.js'

/** Subtree of a cwd (ids of the directories, including the cwd itself). */
export interface CwdSubtree {
  readonly rootId: number
  readonly ids: ReadonlySet<number>
  /** The form passed to the full-text search SQL via `json_each(?)` (`[1,2,3]`). Built only the first time. */
  readonly json: string
}

type DirRow = readonly [number, number | null, string]

/** Number of subtrees kept (TODO 437: for the scope, the cwd, and re-typing of each). */
const SUBTREE_CACHE_SIZE = 4

export class DirectoryTree {
  private revision = -1
  private rows: readonly DirRow[] = []
  private paths: ReadonlyMap<number, string> | null = null
  private casedPaths: ReadonlyMap<number, string> | null = null
  private children: ReadonlyMap<number | null, readonly DirRow[]> | null = null
  /**
   * Cache of subtrees (keyed by the `foldPath`-ed path). TODO 437 added a scope (the badge on the Search screen), and the scope and the
   * cwd (`@` completion, Files filter) alternate on every keystroke, so a design that remembered only one redid the BFS every time.
   * Keeps the most recent `SUBTREE_CACHE_SIZE` (an insertion-ordered Map serves as the LRU). Everything is dropped when the tree changes.
   */
  private readonly cached = new Map<string, CwdSubtree | null>()

  constructor(private readonly store: IndexStore) {}

  private refresh(): void {
    if (this.revision === this.store.treeRevision) return
    this.rows = this.store.fsDirectories()
    this.paths = null
    this.casedPaths = null
    this.children = null
    this.cached.clear()
    this.revision = this.store.treeRevision
  }

  /** Directory id -> absolute path folded with `foldForMatch` (the root is the empty string). For file-name search. */
  dirPaths(): ReadonlyMap<number, string> {
    this.refresh()
    this.paths ??= buildDirPaths(this.rows)
    return this.paths
  }

  /**
   * Directory id -> NFKC absolute path without lowercasing (smart case, TODO 291).
   * Built the first time a word containing an uppercase letter is looked up; normally not held (there are hundreds of thousands of directory rows).
   */
  casedDirPaths(): ReadonlyMap<number, string> {
    this.refresh()
    this.casedPaths ??= buildDirPaths(this.rows, nfkc)
    return this.casedPaths
  }

  /**
   * Subtree of `path` (an absolute path, validated in both main and the index process).
   * Null if the index has no such directory (= the cwd section is not shown).
   */
  subtree(path: string): CwdSubtree | null {
    this.refresh()
    const key = foldPath(path)
    if (this.cached.has(key)) {
      const hit = this.cached.get(key) ?? null
      // Move the used entry to the end (LRU).
      this.cached.delete(key)
      this.cached.set(key, hit)
      return hit
    }
    const value = this.compute(path)
    this.cached.set(key, value)
    while (this.cached.size > SUBTREE_CACHE_SIZE) {
      const oldest = this.cached.keys().next().value
      if (oldest === undefined) break
      this.cached.delete(oldest)
    }
    return value
  }

  private compute(path: string): CwdSubtree | null {
    if (this.children === null) {
      const children = new Map<number | null, DirRow[]>()
      for (const row of this.rows) {
        const list = children.get(row[1])
        if (list === undefined) children.set(row[1], [row])
        else list.push(row)
      }
      this.children = children
    }
    const children = this.children
    const root = children.get(null)?.[0]
    if (root === undefined) return null
    let id = root[0]
    for (const segment of path.split('/')) {
      if (segment === '') continue
      const folded = foldPath(segment)
      const next = children.get(id)?.find((row) => foldPath(row[2]) === folded)
      if (next === undefined) return null
      id = next[0]
    }
    const ids = new Set<number>([id])
    const queue = [id]
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i]
      if (current === undefined) continue
      for (const child of children.get(current) ?? []) {
        if (ids.has(child[0])) continue
        ids.add(child[0])
        queue.push(child[0])
      }
    }
    let json: string | null = null
    return {
      rootId: id,
      ids,
      get json(): string {
        json ??= JSON.stringify([...ids])
        return json
      }
    }
  }
}

/**
 * One per store. File-name search (held by `FsIndexer`) and full-text search (`IndexService`)
 * share the same table: on a real machine there are hundreds of thousands of directory rows, and holding two would double the tens of MB.
 */
const trees = new WeakMap<IndexStore, DirectoryTree>()

export function directoryTreeOf(store: IndexStore): DirectoryTree {
  let tree = trees.get(store)
  if (tree === undefined) {
    tree = new DirectoryTree(store)
    trees.set(store, tree)
  }
  return tree
}

/**
 * Builds the folded path table from directory rows. **Does not keep the original paths**:
 * the absolute path used for display is assembled by `IndexStore.pathOf` only for the top N.
 * (A real machine has hundreds of thousands of directories, so keeping both would cost tens of MB.)
 */
export function buildDirPaths(
  rows: readonly DirRow[],
  fold: (path: string) => string = foldForMatch
): ReadonlyMap<number, string> {
  const byId = new Map<number, { parent: number | null; name: string }>()
  for (const [id, parent, name] of rows) byId.set(id, { parent, name })

  const paths = new Map<number, string>()
  const resolve = (id: number, depth: number): string => {
    const hit = paths.get(id)
    if (hit !== undefined) return hit
    const row = byId.get(id)
    if (row === undefined || depth > 64) return ''
    // The path of the root (`/`) is the empty string. A file directly below it becomes `'' + '/' + name`.
    const path = row.parent === null ? '' : `${resolve(row.parent, depth + 1)}/${row.name}`
    const folded = fold(path)
    paths.set(id, folded)
    return folded
  }
  for (const [id] of byId) resolve(id, 0)
  return paths
}
