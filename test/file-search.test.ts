/**
 * Matching rules for filename search (ARCHITECTURE.md 6.6).
 *
 * The viewpoints are carried over as they are from the "6b. VSCode Quick Open style matching" section of `tools/kbfiles_test.mjs` in qlm: the owner's example `ax pdf` → `AX_51610ABC.pdf`, exclusion by AND, **that scattered (subsequence) matches do not hold**, matching of `/` and `\` paths, full-width spaces, a query of only spaces, tiers and sort order, and reporting of truncation.
 *
 * **This carries over a decision that was tried once over there and withdrawn (subsequence matching is not adopted).** If it is revived, first decide how to push down the noise of real data, where `ax pdf` hits `axi-spdif.c` and gives 52,998 results, by ranking.
 *
 * The model is not called. The DB is in memory. Constraint 11 is "no plaintext on disk", so this test, which writes nothing, does not use `PRAGMA key`. In memory a key is rejected in the first place (a Phase 1 fact).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { FileNameSearch } from '../src/index-kernel/file-search.js'
import { foldForMatch, parseNameQuery } from '../src/index-kernel/name-search.js'
import { CaseFilter, isCaseSensitiveQuery } from '../src/index-kernel/smart-case.js'

let db: Db
let store: IndexStore
let search: FileNameSearch

/** Builds a tree equivalent to the check KB of qlm. */
const FILES = [
  '/Users/alice/uploads/main.c',
  '/Users/alice/uploads/AX_51610ABC.pdf',
  '/Users/alice/uploads/ax_sk3kaf43.pdf',
  '/Users/alice/uploads/axi-spdif.c',
  '/Users/alice/uploads/axg-spdifout.c',
  '/Users/alice/uploads/manual/readme_ax.txt',
  '/Users/alice/report.md',
  '/Users/alice/weekly-report.md',
  '/Users/alice/report/notes.md',
  '/Users/alice/議事録_2026年度.md'
]

function add(path: string): void {
  const cut = path.lastIndexOf('/')
  const parentId = store.ensureDirectory(path.slice(0, cut), 1)
  const name = path.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  store.upsertFsEntry({
    parentId,
    name,
    isDirectory: false,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    size: 10,
    mtimeMs: 1,
    seenAt: 1
  })
}

async function names(query: string, limit = 50): Promise<readonly string[]> {
  const result = await search.search(query, limit)
  return store.entriesByIds(result.ids).map((row) => row.name)
}

beforeAll(() => {
  db = new Database(':memory:')
  runMigrations(db)
  store = new IndexStore(db)
  for (const path of FILES) add(path)
  search = new FileNameSearch(store)
})

describe('folding and word splitting', () => {
  it('NFKC + lowercase (full-width and half-width become the same)', () => {
    expect(foldForMatch('ＡＸ')).toBe('ax')
    expect(foldForMatch('AX_51610ABC.pdf')).toBe('ax_51610abc.pdf')
  })

  it('a full-width space (U+3000) is a separator too', () => {
    expect(parseNameQuery('ａｘ　ｐｄｆ').map((t) => t.text)).toEqual(['ax', 'pdf'])
  })

  it('smart case (TODO 291): only words containing uppercase are not lowercased (decided after NFKC, per word)', () => {
    expect(parseNameQuery('ＡＸ　ｐｄｆ').map((t) => [t.text, t.cased])).toEqual([
      ['AX', true],
      ['pdf', false]
    ])
    expect(parseNameQuery('System config').map((t) => t.cased)).toEqual([true, false])
    // Uppercase letters that are not ASCII are also picked up. Words made only of Japanese characters are on the side that does not distinguish case.
    expect(parseNameQuery('Äpfel').map((t) => t.cased)).toEqual([true])
    expect(parseNameQuery('議事録').map((t) => t.cased)).toEqual([false])
  })

  it('a whitespace-only query makes no words', () => {
    expect(parseNameQuery('  　 ')).toHaveLength(0)
  })

  it('a `\\` in the query folds to `/`, and a word containing `/` becomes path matching', () => {
    const terms = parseNameQuery('manual\\readme ax')
    expect(terms[0]).toMatchObject({ text: 'manual/readme', path: true })
    expect(terms[1]).toMatchObject({ text: 'ax', path: false })
  })
})

describe('qlm 6b: matching in the style of VSCode Quick Open', () => {
  it("owner's example: 'ax pdf' matches AX_51610ABC.pdf", async () => {
    const hit = await names('ax pdf')
    expect(hit).toContain('AX_51610ABC.pdf')
    expect(hit).toContain('ax_sk3kaf43.pdf')
  })

  it('all words AND: ones containing only one of them do not appear', async () => {
    const hit = await names('ax pdf')
    expect(hit).not.toContain('readme_ax.txt')
    expect(hit).not.toContain('main.c')
  })

  it('the order of words does not matter', async () => {
    expect([...(await names('pdf ax'))].sort()).toEqual([...(await names('ax pdf'))].sort())
  })

  it('withdrawn: scattered matches do not count (contiguous matches only)', async () => {
    expect(await names('axabc')).not.toContain('AX_51610ABC.pdf')
    expect(await names('k43')).not.toContain('ax_sk3kaf43.pdf')
    // Matches if the characters are consecutive.
    expect(await names('sk3')).toContain('ax_sk3kaf43.pdf')
  })

  it("narrowing: .c is not mixed into 'ax pdf' (pdf does not match spdif scattered)", async () => {
    const hit = await names('ax pdf')
    expect(hit).not.toContain('axi-spdif.c')
    expect(hit).not.toContain('axg-spdifout.c')
  })

  it("a word containing `/` matches against the path; `\\` is the same", async () => {
    expect(await names('manual/readme')).toEqual(['readme_ax.txt'])
    expect(await names('manual\\readme')).toEqual(['readme_ax.txt'])
  })

  it('matches even when mixing name words and path words', async () => {
    expect(await names('manual ax')).toContain('readme_ax.txt')
  })

  it('a full-width query + full-width space splits the same way', async () => {
    expect(await names('ａｘ　ｐｄｆ')).toContain('AX_51610ABC.pdf')
    // Full-width uppercase letters follow smart case (TODO 291): full-width AX matches AX_ and does not match ax_.
    expect(await names('ＡＸ　ｐｄｆ')).toEqual(['AX_51610ABC.pdf'])
  })

  it('a whitespace-only query gives an empty result', async () => {
    const result = await search.search('  　 ', 50)
    expect(result.ids).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('Japanese names can also be looked up through NFKC', async () => {
    expect(await names('議事録')).toContain('議事録_2026年度.md')
    expect(await names('2026')).toContain('議事録_2026年度.md')
  })
})

describe('tier and sort order', () => {
  it('name prefix match → name partial match → path partial match', async () => {
    const hit = await names('report')
    expect(hit).toContain('report.md')
    expect(hit).toContain('weekly-report.md')
    expect(hit).toContain('notes.md')
    // tier 0 (prefix match) comes before tier 1 (partial match), and tier 1 comes before tier 2 (path).
    expect(hit.indexOf('report.md')).toBeLessThan(hit.indexOf('weekly-report.md'))
    expect(hit.indexOf('weekly-report.md')).toBeLessThan(hit.indexOf('notes.md'))
  })

  it('within the same tier, an earlier match position comes first', async () => {
    const hit = await names('ax')
    // ax_sk3kaf43.pdf and AX_51610ABC.pdf are prefix matches (tier 0), and readme_ax.txt is a partial match (tier 1), so it comes after them.
    expect(hit.indexOf('readme_ax.txt')).toBeGreaterThan(hit.indexOf('AX_51610ABC.pdf'))
  })

  it('the same rank gives a stable order (the same however many times it is queried)', async () => {
    expect(await names('ax')).toEqual(await names('ax'))
  })
})

describe('reporting of cutoff (does not silently drop)', () => {
  it('returns the top N + the total hit count + truncated', async () => {
    const result = await search.search('ax', 1)
    expect(result.ids).toHaveLength(1)
    expect(result.total).toBeGreaterThan(1)
    expect(result.truncated).toBe(true)
    expect(result.scanTruncated).toBe(false)
  })

  it('scanTruncated is set when the count limit is hit', async () => {
    const tiny = new FileNameSearch(store, { maxMatches: 1, pageRows: 1 })
    const result = await tiny.search('ax', 10)
    expect(result.scanTruncated).toBe(true)
    // Hits beyond the limit are **still counted**.
    expect(result.total).toBeGreaterThan(1)
  })

  it('scanTruncated is set when the time limit is hit', async () => {
    const impatient = new FileNameSearch(store, { budgetMs: -1, pageRows: 1 })
    const result = await impatient.search('ax', 10)
    expect(result.scanTruncated).toBe(true)
  })
})

describe('being discarded midway (does not keep running once typing has moved on)', () => {
  it('returns no result once cancelled is set', async () => {
    const slow = new FileNameSearch(store, { pageRows: 1 })
    const result = await slow.search('ax', 10, () => true)
    expect(result.cancelled).toBe(true)
    expect(result.ids).toHaveLength(0)
  })

  it('a query that ends in one page is not discarded (it finishes before the scan starts)', async () => {
    const result = await search.search('ax', 10, () => true)
    expect(result.cancelled).toBe(false)
  })
})

/**
 * Item 100: returns the files inside the current working folder first, in a separate partition.
 *
 * The tree is built in a different DB (the checks above count results, so the two must not be mixed). Files inside cwd are created **last**: a high id means a position that is read last in a full-tree scan, which reproduces the shape that is cut off by the limit.
 */
describe('inside the current working folder first (item 100)', () => {
  const CWD = '/Users/bob/app'
  let cwdStore: IndexStore

  function addTo(target: IndexStore, path: string): void {
    const cut = path.lastIndexOf('/')
    const parentId = target.ensureDirectory(path.slice(0, cut), 1)
    target.upsertFsEntry({
      parentId,
      name: path.slice(cut + 1),
      isDirectory: false,
      ext: '',
      size: 1,
      mtimeMs: 1,
      seenAt: 1
    })
  }

  function pathsOf(ids: readonly number[]): readonly string[] {
    return ids.map((id) => cwdStore.pathOf(id) ?? '')
  }

  beforeAll(() => {
    const cwdDb = new Database(':memory:')
    runMigrations(cwdDb)
    cwdStore = new IndexStore(cwdDb)
    // The whole tree (created first, so the ids are small). `appx` and `app-old` are neighboring folders whose names start the same as cwd.
    for (let i = 0; i < 20; i += 1) addTo(cwdStore, `/Users/bob/other/d${i}/foo-${i}.md`)
    addTo(cwdStore, '/Users/bob/appx/foo.ts')
    addTo(cwdStore, '/Users/bob/app-old/foo.ts')
    // Inside cwd (created last). Includes two levels down.
    addTo(cwdStore, `${CWD}/src/foo.ts`)
    addTo(cwdStore, `${CWD}/test/foo.test.ts`)
    addTo(cwdStore, `${CWD}/src/deep/nested/foo.js`)
    addTo(cwdStore, `${CWD}/foo.md`)
  })

  it('returns matches inside cwd in a separate section and does not overlap them in the everywhere section', async () => {
    const result = await new FileNameSearch(cwdStore).search('foo', 50, () => false, CWD)
    expect(result.cwd).not.toBeNull()
    expect([...pathsOf(result.cwd?.ids ?? [])].sort()).toEqual([
      `${CWD}/foo.md`,
      `${CWD}/src/deep/nested/foo.js`,
      `${CWD}/src/foo.ts`,
      `${CWD}/test/foo.test.ts`
    ])
    expect(result.cwd?.total).toBe(4)
    expect(pathsOf(result.ids).some((path) => path.startsWith(`${CWD}/`))).toBe(false)
    expect(result.total).toBe(22)
  })

  it('looks up to the separator: `appx` / `app-old` do not enter a cwd of `/Users/bob/app`', async () => {
    const result = await new FileNameSearch(cwdStore).search('foo.ts', 50, () => false, CWD)
    expect(pathsOf(result.cwd?.ids ?? [])).toEqual([`${CWD}/src/foo.ts`])
    expect([...pathsOf(result.ids)].sort()).toEqual([
      '/Users/bob/app-old/foo.ts',
      '/Users/bob/appx/foo.ts'
    ])
  })

  it('inside the cwd section sorts by the usual rank (name prefix match → shorter name)', async () => {
    const result = await new FileNameSearch(cwdStore).search('foo', 50, () => false, CWD)
    const inside = pathsOf(result.cwd?.ids ?? [])
    expect(inside[0]).toBe(`${CWD}/foo.md`)
    expect(inside[inside.length - 1]).toBe(`${CWD}/test/foo.test.ts`)
  })

  it('even under a cutoff, matches inside cwd remain (walks the subtree first)', async () => {
    // A scan of the whole tree times out in one page (one row). The files inside cwd have the last ids, so relying only on the whole-tree scan finds none of them.
    const hurried = new FileNameSearch(cwdStore, { budgetMs: -1, pageRows: 1, cwdPassMaxShare: 1 })
    const result = await hurried.search('foo', 50, () => false, CWD)
    expect(result.cwd?.total).toBe(4)
    expect(result.cwd?.scanTruncated).toBe(false)
    // The whole-tree search reports that it was cut off (it does not drop results silently).
    expect(result.scanTruncated).toBe(true)
  })

  it('when not walking the subtree first (a large tree), also reports the cutoff in the cwd section', async () => {
    const hurried = new FileNameSearch(cwdStore, { budgetMs: -1, pageRows: 1, cwdPassMaxShare: 0 })
    const result = await hurried.search('foo', 50, () => false, CWD)
    expect(result.cwd?.scanTruncated).toBe(true)
    expect(result.cwd?.total).toBe(0)
  })

  it('with or without walking first, gives the same result when there is no cutoff', async () => {
    const walked = await new FileNameSearch(cwdStore, { cwdPassMaxShare: 1 }).search(
      'foo',
      50,
      () => false,
      CWD
    )
    const sorted = await new FileNameSearch(cwdStore, { cwdPassMaxShare: 0 }).search(
      'foo',
      50,
      () => false,
      CWD
    )
    expect(walked.cwd?.ids).toEqual(sorted.cwd?.ids)
    expect(walked.ids).toEqual(sorted.ids)
    expect(walked.total).toBe(sorted.total)
  })

  it('folds the case of cwd for lookup (APFS does not distinguish by default)', async () => {
    const result = await new FileNameSearch(cwdStore).search('foo', 50, () => false, '/users/BOB/App')
    expect(result.cwd?.total).toBe(4)
  })

  it('with no cwd or a cwd not in the index, only the one everywhere section', async () => {
    const none = await new FileNameSearch(cwdStore).search('foo', 50)
    expect(none.cwd).toBeNull()
    expect(none.total).toBe(26)
    const missing = await new FileNameSearch(cwdStore).search(
      'foo',
      50,
      () => false,
      '/Users/bob/nowhere'
    )
    expect(missing.cwd).toBeNull()
    expect(missing.total).toBe(26)
  })

  it('when cwd is a file, makes no section (only a directory can be cwd)', async () => {
    const result = await new FileNameSearch(cwdStore).search('foo', 50, () => false, `${CWD}/foo.md`)
    expect(result.cwd).toBeNull()
  })
})

/**
 * TODO 291: smart case. Only words containing uppercase letters compare names and parent paths with NFKC, without lowercasing them.
 * The tree is built in a different DB (the checks above count results, so the two must not be mixed).
 */
describe('smart case (TODO 291)', () => {
  let caseStore: IndexStore
  let caseSearch: FileNameSearch

  async function caseNames(query: string): Promise<readonly string[]> {
    const result = await caseSearch.search(query, 50)
    return result.ids.map((id) => caseStore.pathOf(id) ?? '').sort()
  }

  beforeAll(() => {
    const caseDb = new Database(':memory:')
    runMigrations(caseDb)
    caseStore = new IndexStore(caseDb)
    for (const path of [
      '/Users/carol/src/system.ts',
      '/Users/carol/src/System.md',
      '/Users/carol/src/system-config.json',
      // `name_folded` (NFC and lowercase) is the identity key, so names that differ only in case cannot be placed under the same parent.
      '/Users/carol/src/System-Config.yaml',
      '/Users/carol/Docs/readme.md',
      '/Users/carol/old-docs/notes.md'
    ]) {
      const cut = path.lastIndexOf('/')
      const parentId = caseStore.ensureDirectory(path.slice(0, cut), 1)
      caseStore.upsertFsEntry({
        parentId,
        name: path.slice(cut + 1),
        isDirectory: false,
        ext: '',
        size: 1,
        mtimeMs: 1,
        seenAt: 1
      })
    }
    caseSearch = new FileNameSearch(caseStore)
  })

  it('`System` does not match system.ts', async () => {
    expect(await caseNames('System')).toEqual([
      '/Users/carol/src/System-Config.yaml',
      '/Users/carol/src/System.md'
    ])
    expect((await caseSearch.search('System', 50)).caseSensitive).toBe(true)
  })

  it('`system` (all lowercase) matches both', async () => {
    expect(await caseNames('system')).toHaveLength(4)
    expect((await caseSearch.search('system', 50)).caseSensitive).toBe(false)
  })

  it('full-width `Ｓｙｓｔｅｍ` is folded to `System` by NFKC and then distinguished', async () => {
    expect(await caseNames('Ｓｙｓｔｅｍ')).toEqual(await caseNames('System'))
  })

  it('mixed `System config`: only System is distinguished, config is not', async () => {
    expect(await caseNames('System config')).toEqual(['/Users/carol/src/System-Config.yaml'])
    expect(await caseNames('System CONFIG')).toEqual([])
    expect(await caseNames('system config')).toEqual([
      '/Users/carol/src/System-Config.yaml',
      '/Users/carol/src/system-config.json'
    ])
  })

  it('the parent path side is not lowercased either (tier 2 and words containing `/`)', async () => {
    // TODO 436 (revision of 357): rows for the folders themselves also count as hits (`caseNames` re-sorts them in path order).
    expect(await caseNames('Docs')).toEqual(['/Users/carol/Docs', '/Users/carol/Docs/readme.md'])
    expect(await caseNames('docs')).toEqual([
      '/Users/carol/Docs',
      '/Users/carol/Docs/readme.md',
      '/Users/carol/old-docs',
      '/Users/carol/old-docs/notes.md'
    ])
    expect(await caseNames('Docs/read')).toEqual(['/Users/carol/Docs/readme.md'])
    expect(await caseNames('Docs/notes')).toEqual([])
    expect(await caseNames('carol/Docs')).toEqual([
      '/Users/carol/Docs',
      '/Users/carol/Docs/readme.md'
    ])
    expect(await caseNames('Carol/docs')).toEqual([])
  })
})

/**
 * TODO 436 (revision of 357): folders are included in the results of filename search. 357 removed them once because of a small observation (proxy verification in wave 19): opening a folder row was refused by the viewer's read with `reason: directory`. With 436 the side that opens (the renderer) selects a folder in the Files tree instead, so there is no reason left to remove them.
 * Whether an entry is a folder is decided by the key in `dirPaths` (the set of all directory ids) (no migration, and no extra SQL).
 */
describe('TODO 436: folders also go into results (files first within the same tier)', () => {
  let dirStore: IndexStore
  let dirSearch: FileNameSearch

  beforeAll(() => {
    const dirDb = new Database(':memory:')
    runMigrations(dirDb)
    dirStore = new IndexStore(dirDb)
    for (const path of ['/Users/dave/projects/widget/readme.md', '/Users/dave/projects/widget-old.md']) {
      const cut = path.lastIndexOf('/')
      const parentId = dirStore.ensureDirectory(path.slice(0, cut), 1)
      dirStore.upsertFsEntry({
        parentId,
        name: path.slice(cut + 1),
        isDirectory: false,
        ext: 'md',
        size: 1,
        mtimeMs: 1,
        seenAt: 1
      })
    }
    dirSearch = new FileNameSearch(dirStore)
  })

  it('a query matching the folder name itself also returns the folder row; files come first within the same tier', async () => {
    const result = await dirSearch.search('widget', 50)
    const rows = result.ids.map((id) => dirStore.entriesByIds([id])[0])
    // widget-old.md and widget both match the name as a prefix (tier 0). widget is the shorter name, but files are placed first (the default of TODO 436). readme.md is a path match (tier 2), so it comes last.
    expect(rows.map((row) => row?.name)).toEqual(['widget-old.md', 'widget', 'readme.md'])
    expect(rows.map((row) => row?.kind)).toEqual(['file', 'directory', 'file'])
    expect(result.total).toBe(3)
  })

  it('a word containing `/` in path matching (tier 2) matches only files inside across the boundary', async () => {
    const names = await (
      await dirSearch.search('widget/read', 50)
    ).ids.reduce<string[]>((out, id) => {
      const row = dirStore.entriesByIds([id])[0]
      if (row !== undefined) out.push(row.name)
      return out
    }, [])
    expect(names).toEqual(['readme.md'])
  })
})

describe('CaseFilter (re-matching of full-text search, TODO 291)', () => {
  it('a query without uppercase is not re-matched (null)', () => {
    expect(CaseFilter.of('system config')).toBeNull()
    expect(CaseFilter.of('議事録 2026')).toBeNull()
    expect(isCaseSensitiveQuery('system')).toBe(false)
    expect(isCaseSensitiveQuery('Ｓｙｓｔｅｍ')).toBe(true)
  })

  it('the needle is only the run containing uppercase within words that contain uppercase', () => {
    expect(CaseFilter.of('System config')?.needles).toEqual(['System'])
    expect(CaseFilter.of('Systemの設定')?.needles).toEqual(['System'])
    expect(CaseFilter.of('Foo.bar')?.needles).toEqual(['Foo'])
    expect(CaseFilter.of('Ｓｙｓｔｅｍ')?.needles).toEqual(['System'])
  })

  it('case is kept as is, and diacritics are folded on both sides', () => {
    const filter = CaseFilter.of('Cafe')
    expect(filter?.accepts('Café Latte')).toBe(true)
    expect(filter?.accepts('café latte')).toBe(false)
    expect(CaseFilter.of('Café')?.accepts('Cafe menu')).toBe(true)
    expect(CaseFilter.of('System')?.accepts('ＳｙｓｔｅｍＤ')).toBe(true)
  })
})

/**
 * TODO 437: the scope of the Search screen. Returns only what is inside the scoped subtree, as one partition (`ids` of the body, `cwd` null).
 * The subtree is walked in the same two ways as 100 (walk first, or dispatch by a full-tree scan), and neither returns anything outside.
 */
describe('scope (TODO 437)', () => {
  let scopeStore: IndexStore

  beforeAll(() => {
    const scopeDb = new Database(':memory:')
    runMigrations(scopeDb)
    scopeStore = new IndexStore(scopeDb)
    for (const path of [
      '/a/foo/notes.md',
      '/a/foo/sub/notes-2.md',
      '/a/foobar/notes.md',
      '/b/notes.md'
    ]) {
      const cut = path.lastIndexOf('/')
      const parentId = scopeStore.ensureDirectory(path.slice(0, cut), 1)
      scopeStore.upsertFsEntry({
        parentId,
        name: path.slice(cut + 1),
        isDirectory: false,
        ext: 'md',
        size: 1,
        mtimeMs: 1,
        seenAt: 1
      })
    }
  })

  const paths = (ids: readonly number[]): readonly string[] =>
    ids.map((id) => scopeStore.pathOf(id) ?? '').sort()

  for (const [label, share] of [
    ['部分木を先に歩く', 1],
    ['全域の走査で振り分ける', 0]
  ] as const) {
    it(`${label}: /a/foobar does not enter a scope of /a/foo`, async () => {
      const search = new FileNameSearch(scopeStore, { cwdPassMaxShare: share })
      const result = await search.search('notes', 50, () => false, '/b', '/a/foo')
      expect(paths(result.ids)).toEqual(['/a/foo/notes.md', '/a/foo/sub/notes-2.md'])
      expect(result.total).toBe(2)
      expect(result.cwd).toBeNull()
      expect(result.scanTruncated).toBe(false)
    })
  }

  it("folders inside the scope are also returned (TODO 436); the scope's own folder is not returned", async () => {
    const search = new FileNameSearch(scopeStore, { cwdPassMaxShare: 1 })
    const result = await search.search('sub', 50, () => false, null, '/a/foo')
    expect(paths(result.ids)).toEqual(['/a/foo/sub', '/a/foo/sub/notes-2.md'])
    const self = await search.search('foo', 50, () => false, null, '/a/foo')
    expect(paths(self.ids)).not.toContain('/a/foo')
  })

  it('a scope not in the index gives 0 hits (does not drop it and return everywhere)', async () => {
    const search = new FileNameSearch(scopeStore)
    const result = await search.search('notes', 50, () => false, null, '/nowhere')
    expect(result.ids).toEqual([])
    expect(result.total).toBe(0)
  })
})
