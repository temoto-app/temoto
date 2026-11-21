/**
 * TODO 1099: installing a CLI plugin from Skills in settings (ARCHITECTURE.md 4.5.3.3). Reading and shape-checking the catalog cache,
 * searching, the list of installed plugins, building the command, and interpreting the result rows and exit codes.
 *
 * Neither the model nor the CLI is called. The catalog is built under a fake home (a temporary folder), and the CLI is a fake runner.
 * The real config directory is neither read nor written (constraint 2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBackendPaths, loadCompatTable, type PluginsTable } from '../src/main/session/adapter/compat.js'
import {
  PluginCatalogReader,
  cleanText,
  marketplaceManifestPath,
  marketplaceRepositoryUrl,
  parseDirectoryCache,
  parseInstalledPlugins,
  parseMarketplaceManifest,
  readJsonGuarded,
  searchCatalog,
  withInstalledCandidates
} from '../src/main/session/adapter/plugin-catalog.js'
import {
  CliPluginManager,
  hasResultLine,
  judgePluginRun,
  parseResultLine,
  runPluginCommand,
  type PluginRunOptions,
  type PluginRunResult
} from '../src/main/session/adapter/plugin-install.js'

const table = loadCompatTable()
const spec = table.plugins as PluginsTable
const paths = loadBackendPaths()
const MARKET = spec.marketplace
const NOW = Date.parse('2026-11-03T07:00:00.000Z')
const COMMIT = 'a'.repeat(40)

function listing(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    summary: `${name} summary`,
    release: { version: '1.0.0' },
    surfaces: [spec.surface, 'other_surface'],
    source: { type: 'directory', repository: { url: `https://github.com/example/${id}`, reviewed_commit: COMMIT } },
    ...extra
  }
}

function cache(listings: unknown[], names: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: spec.catalogSchemaVersion, fetchedAt: '2026-11-03T06:42:22.140Z', listings, entryNames: names, ...extra }
}

const reviewerOf = (label: 'first-party' | 'partner'): string =>
  Object.entries(spec.reviewers).find(([, value]) => value === label)?.[0] ?? ''

/** The official marketplace's own repository (`source.repo` in the list of registered marketplaces). */
const OFFICIAL_REPO = 'example/official'
const OFFICIAL = `https://github.com/${OFFICIAL_REPO}`
const SHA = 'b'.repeat(40)
/** The source of a listing that points at a plugin inside the official marketplace. */
const inOfficial = (path: string): Record<string, unknown> => ({
  source: { type: 'directory', repository: { url: OFFICIAL, path, reviewed_commit: COMMIT } }
})

/** The official marketplace's `marketplace.json` (TODO 1177). */
const manifest = (): Record<string, unknown> => ({
  name: MARKET,
  plugins: [
    // The same as the catalog name (code-simplifier type).
    { name: 'frontend-design', source: './plugins/frontend-design' },
    // An external repository (url type, with `.git`).
    { name: 'superpowers', source: { source: 'url', url: 'https://github.com/example/p2.git', sha: SHA } },
    // Differs from the catalog name (`code-review-official`) (code-review type).
    { name: 'code-review', source: './plugins/code-review' },
    // Two names for the same source.
    { name: 'shared-a', source: { source: 'git-subdir', url: 'https://github.com/example/shared', path: 'plugin', sha: SHA } },
    { name: 'shared-b', source: { source: 'git-subdir', url: 'https://github.com/example/shared/', path: './plugin/', sha: SHA } },
    { name: 'runs-command', source: { source: 'command', command: 'make it' } }
  ]
})
const INDEX = parseMarketplaceManifest(manifest(), OFFICIAL)!

const fixture = (): Record<string, unknown> =>
  cache(
    [
      listing('p1', 'Frontend Design', {
        ...inOfficial('plugins/frontend-design'),
        checks: { review: { state: 'done', by: { type: reviewerOf('first-party') } } }
      }),
      listing('p2', 'Superpowers', {
        summary: 'Core skills library: TDD, debugging',
        publisher: { name: 'Jesse' },
        checks: { review: { state: 'done', by: { type: reviewerOf('partner') } } }
      }),
      listing('p3', 'Web only', { surfaces: ['other_surface'] }),
      listing('p4', 'Unpinned', { source: { type: 'directory', repository: { url: 'https://x/y', reviewed_commit: 'main' } } }),
      listing('p5', 'Runs a command', { source: { type: spec.commandSourceTypes[0] ?? 'command' } }),
      listing('p6', 'Strange', { source: { type: 'teleport' } }),
      listing('p7', 'No name'),
      listing('p8', 'Duplicate of p1'),
      listing('p9', 'Bad\u0007name\nsplit'),
      listing('p10', 'Empty surfaces', { surfaces: [] }),
      listing('p11', 'No surfaces', { surfaces: undefined }),
      // Its listing name carries a suffix to avoid a collision, and differs from the official name.
      listing('p12', 'code-review', inOfficial('plugins/code-review')),
      // Only in the listing, not in the official marketplace.
      listing('p13', 'Directory only'),
      // Two names from the same source in the official marketplace (both differ from the listing name, or both are the same).
      listing('p14', 'Shared A', {
        source: { type: 'directory', repository: { url: 'https://github.com/example/shared', path: 'plugin', reviewed_commit: COMMIT } }
      }),
      listing('p15', 'Shared B', {
        source: { type: 'directory', repository: { url: 'https://github.com/example/shared', path: 'plugin', reviewed_commit: COMMIT } }
      })
    ],
    {
      p12: 'code-review-official',
      p13: 'directory-only',
      p14: 'shared-x',
      p15: 'shared-b',
      p1: 'frontend-design',
      p2: 'superpowers',
      p3: 'web-only',
      p4: 'unpinned',
      p5: 'runs-command',
      p6: 'strange',
      p8: 'frontend-design',
      p9: 'bad-name',
      p10: 'empty-surfaces',
      p11: 'no-surfaces'
    }
  )

describe('parseDirectoryCache', () => {
  it('lists only what the CLI can install (drops other surfaces, no surface, no commit, no name and duplicates)', () => {
    const parsed = parseDirectoryCache(fixture(), spec, NOW, INDEX)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.records.map((record) => record.name)).toEqual([
      'frontend-design',
      'superpowers',
      'runs-command',
      'strange',
      'bad-name',
      'code-review-official',
      'directory-only',
      'shared-x',
      'shared-b'
    ])
    const byName = new Map(parsed.records.map((record) => [record.name, record]))
    expect(byName.get('frontend-design')?.review).toBe('first-party')
    expect(byName.get('superpowers')?.review).toBe('partner')
    expect(byName.get('superpowers')?.publisher).toBe('Jesse')
    expect(byName.get('runs-command')?.blocked).toBe('command-source')
    expect(byName.get('strange')?.blocked).toBe('unsupported-source')
    expect(byName.get('frontend-design')?.blocked).toBeNull()
    // Control characters and newlines become spaces.
    expect(byName.get('bad-name')?.title).toBe('Bad name split')
    expect(parsed.fetchedAt).toBe(Date.parse('2026-11-03T06:42:22.140Z'))
  })

  it('re-resolves the install name from the source of the official marketplace (TODO 1177)', () => {
    const parsed = parseDirectoryCache(fixture(), spec, NOW, INDEX)
    if (!parsed.ok) throw new Error('not ok')
    const byName = new Map(parsed.records.map((record) => [record.name, record]))
    // A match (the listing name = the official name). A relative source is inside the marketplace's own repository.
    expect(byName.get('frontend-design')).toMatchObject({ installName: 'frontend-design', blocked: null })
    // An external repository (whether `.git` is present is treated as the same).
    expect(byName.get('superpowers')).toMatchObject({ installName: 'superpowers', blocked: null })
    // The listing name has a suffix; the name to install is the official name.
    expect(byName.get('code-review-official')).toMatchObject({ installName: 'code-review', blocked: null })
    // Not in the official marketplace.
    expect(byName.get('directory-only')).toMatchObject({ installName: null, blocked: 'not-in-marketplace' })
    expect(byName.get('bad-name')).toMatchObject({ installName: null, blocked: 'not-in-marketplace' })
    // Several names from the same source: the one matching the listing name if there is one; otherwise it is not decided.
    expect(byName.get('shared-x')).toMatchObject({ installName: null, blocked: 'ambiguous-in-marketplace' })
    expect(byName.get('shared-b')).toMatchObject({ installName: 'shared-b', blocked: null })
    // For a command-type source, the reason comes first, without looking at the source.
    expect(byName.get('runs-command')).toMatchObject({ installName: null, blocked: 'command-source' })
  })

  it('old, wrong version, wrong shape, no content', () => {
    const later = NOW + (spec.staleAfterDays + 1) * 24 * 60 * 60 * 1000
    expect(parseDirectoryCache(fixture(), spec, later, INDEX)).toEqual({ ok: false, reason: 'stale' })
    expect(parseDirectoryCache({ ...fixture(), schemaVersion: 1 }, spec, NOW, INDEX)).toEqual({ ok: false, reason: 'malformed' })
    expect(parseDirectoryCache({ ...fixture(), fetchedAt: 'yesterday' }, spec, NOW, INDEX)).toEqual({ ok: false, reason: 'malformed' })
    expect(parseDirectoryCache({ ...fixture(), listings: {} }, spec, NOW, INDEX)).toEqual({ ok: false, reason: 'malformed' })
    expect(parseDirectoryCache([], spec, NOW, INDEX)).toEqual({ ok: false, reason: 'malformed' })
    expect(parseDirectoryCache({ ...fixture(), listingsOmitted: true }, spec, NOW, INDEX)).toEqual({ ok: false, reason: 'no-cache' })
    expect(parseDirectoryCache(cache([], {}), spec, NOW, INDEX)).toEqual({ ok: false, reason: 'no-cache' })
    const noNames = fixture()
    delete noNames['entryNames']
    expect(parseDirectoryCache(noNames, spec, NOW, INDEX)).toEqual({ ok: false, reason: 'no-cache' })
  })

  it('drops the second one that resolves to the same install name (even if the catalog names differ); keeps the one that came first (wave 76 review X)', () => {
    const parsed = parseDirectoryCache(
      cache(
        [
          listing('p2', 'Superpowers'),
          // The same source as p2 (url + path). The listing name differs.
          listing('m2', 'Superpowers mirror', {
            source: { type: 'directory', repository: { url: 'https://github.com/example/p2/', reviewed_commit: COMMIT } }
          }),
          listing('p13', 'Directory only'),
          listing('m13', 'Directory only mirror', {
            source: { type: 'directory', repository: { url: 'https://github.com/example/p13', reviewed_commit: COMMIT } }
          })
        ],
        { p2: 'superpowers', m2: 'superpowers-mirror', p13: 'directory-only', m13: 'directory-only-mirror' }
      ),
      spec,
      NOW,
      INDEX
    )
    if (!parsed.ok) throw new Error('not ok')
    // Items whose install name is not decided (null) are not dropped.
    expect(parsed.records.map((record) => [record.name, record.installName])).toEqual([
      ['superpowers', 'superpowers'],
      ['directory-only', null],
      ['directory-only-mirror', null]
    ])
    const entries = searchCatalog(parsed.records, 'superpowers', new Set(['superpowers'])).entries
    expect(entries.map((entry) => [entry.name, entry.installed])).toEqual([['superpowers', true]])
  })

  it('only names in a form that cannot turn into a flag', () => {
    const parsed = parseDirectoryCache(cache([listing('x', 'X'), listing('y', 'Y')], { x: '--yes', y: 'a b' }), spec, NOW, INDEX)
    expect(parsed).toEqual({ ok: false, reason: 'no-cache' })
  })
})

describe('parseMarketplaceManifest', () => {
  it("makes a table per source form; relative ones only when the marketplace's own repository is known, and `..` and odd forms are not listed", () => {
    const index = parseMarketplaceManifest(
      {
        plugins: [
          { name: 'rel', source: './plugins/rel' },
          { name: 'gh', source: { source: 'github', repo: 'Example/GH-Repo', path: 'x' } },
          { name: 'up', source: './plugins/../secret' },
          { name: 'abs', source: '/plugins/abs' },
          // A relative path without `./` is also relative to the marketplace root (wave 76 review X).
          { name: 'bare', source: 'external_plugins/bare/' },
          { name: 'bare-up', source: 'plugins/../../x' },
          { name: 'url-str', source: 'https://github.com/example/url-str' },
          { name: 'file-str', source: 'file:///tmp/x' },
          { name: 'ssh-str', source: 'git@github.com:example/ssh-str.git' },
          { name: 'home-str', source: '~/plugins/x' },
          { name: 'http', source: { source: 'url', url: 'http://example.com/a' } },
          { name: '--flag', source: './plugins/flag' },
          { name: 'cmd', source: { source: 'command', command: 'x' } },
          'not an object'
        ]
      },
      OFFICIAL
    )
    expect(index === null ? null : [...index.entries()]).toEqual([
      [`${OFFICIAL}\nplugins/rel`, ['rel']],
      ['https://github.com/example/gh-repo\nx', ['gh']],
      [`${OFFICIAL}\nexternal_plugins/bare`, ['bare']]
    ])
    // If the marketplace's own source is not known, relative sources do not match.
    expect([...(parseMarketplaceManifest({ plugins: [{ name: 'rel', source: './plugins/rel' }] }, null) ?? [])]).toEqual([])
    expect(parseMarketplaceManifest({ plugins: {} }, OFFICIAL)).toBeNull()
    expect(parseMarketplaceManifest([], OFFICIAL)).toBeNull()
  })

  it("the marketplace's own source comes from the source of the registered marketplace list", () => {
    expect(marketplaceRepositoryUrl({ [MARKET]: { source: { source: 'github', repo: OFFICIAL_REPO } } }, MARKET)).toBe(OFFICIAL)
    expect(marketplaceRepositoryUrl({ [MARKET]: { source: { source: 'git', url: `${OFFICIAL}.git` } } }, MARKET)).toBe(OFFICIAL)
    expect(marketplaceRepositoryUrl({ [MARKET]: { source: { source: 'github', repo: '../x' } } }, MARKET)).toBeNull()
    expect(marketplaceRepositoryUrl({ [MARKET]: { source: { source: 'directory', path: '/tmp/x' } } }, MARKET)).toBeNull()
    expect(marketplaceRepositoryUrl({}, MARKET)).toBeNull()
  })
})

describe('searchCatalog', () => {
  const parsed = parseDirectoryCache(fixture(), spec, NOW, INDEX)
  const records = parsed.ok ? parsed.records : []

  it('empty term gives everything (in the order of the review badge), cuts at the limit, and the count is before the cut', () => {
    const all = searchCatalog(records, '', new Set(), 2)
    expect(all.matched).toBe(records.length)
    expect(all.entries.map((entry) => entry.name)).toEqual(['frontend-design', 'superpowers'])
  })

  it('those containing all terms; a name prefix match comes before a description match; the installed mark', () => {
    expect(searchCatalog(records, 'tdd debug', new Set()).entries.map((entry) => entry.name)).toEqual(['superpowers'])
    const hits = searchCatalog(records, 'front', new Set(['frontend-design']))
    expect(hits.entries[0]?.name).toBe('frontend-design')
    expect(hits.entries[0]?.installed).toBe(true)
    expect(searchCatalog(records, 'ＳＵＰＥＲ', new Set()).entries.map((entry) => entry.name)).toEqual(['superpowers'])
    expect(searchCatalog(records, 'zzz', new Set())).toEqual({ entries: [], matched: 0 })
  })

  it('the installed mark is judged by the install name; a catalog-name match gets no mark (TODO 1177)', () => {
    const byName = (installed: string[]): Map<string, boolean> =>
      new Map(searchCatalog(records, 'code review', new Set(installed)).entries.map((entry) => [entry.name, entry.installed]))
    expect(byName(['code-review']).get('code-review-official')).toBe(true)
    expect(byName(['code-review-official']).get('code-review-official')).toBe(false)
    const entry = searchCatalog(records, 'code-review', new Set()).entries[0]
    expect(entry).toMatchObject({ name: 'code-review-official', installName: 'code-review', title: 'code-review' })
    // Items that cannot be installed have a null name, and no installed mark is attached either.
    const blocked = searchCatalog(records, 'directory only', new Set(['directory-only'])).entries[0]
    expect(blocked).toMatchObject({ name: 'directory-only', installName: null, installed: false, blocked: 'not-in-marketplace' })
  })

  it('an undecided listing becomes Installed under a candidate name if it is installed (wave 76 review X)', () => {
    const byName = (installed: string[]): Map<string, unknown> =>
      new Map(searchCatalog(records, 'shared', new Set(installed)).entries.map((entry) => [entry.name, entry]))
    // The candidates for shared-x are shared-a / shared-b. If shared-a is installed, it resolves to shared-a.
    expect(byName(['shared-a']).get('shared-x')).toMatchObject({ installName: 'shared-a', installed: true, blocked: null })
    // shared-b is taken as the install name by a different listing (its listing name is shared-b), so it is not taken for shared-x.
    expect(byName(['shared-b']).get('shared-x')).toMatchObject({
      installName: null,
      installed: false,
      blocked: 'ambiguous-in-marketplace'
    })
    expect(byName(['shared-b']).get('shared-b')).toMatchObject({ installName: 'shared-b', installed: true })
    // If nothing is installed, it is not decided, as before.
    expect(byName([]).get('shared-x')).toMatchObject({ installName: null, installed: false, blocked: 'ambiguous-in-marketplace' })
    expect(records.find((record) => record.name === 'shared-x')?.candidates).toEqual(['shared-a'])
  })

  it('a candidate name is taken by only one entry (the earlier one in catalog order)', () => {
    const shared = { url: 'https://github.com/example/shared', path: 'plugin', reviewed_commit: COMMIT }
    const parsed = parseDirectoryCache(
      cache(
        [
          listing('q1', 'Q one', { source: { type: 'directory', repository: shared } }),
          listing('q2', 'Q two', { source: { type: 'directory', repository: shared } })
        ],
        { q1: 'q-one', q2: 'q-two' }
      ),
      spec,
      NOW,
      INDEX
    )
    if (!parsed.ok) throw new Error('not ok')
    const resolved = withInstalledCandidates(parsed.records, new Set(['shared-a']))
    expect(resolved.map((record) => [record.name, record.installName, record.blocked])).toEqual([
      ['q-one', 'shared-a', null],
      ['q-two', null, 'ambiguous-in-marketplace']
    ])
    // If nothing is installed, the same array is returned.
    expect(withInstalledCandidates(parsed.records, new Set())).toBe(parsed.records)
  })

  it('with the same kind of match, installable ones come first', () => {
    const names = searchCatalog(records, 'shared', new Set()).entries.map((entry) => entry.name)
    expect(names).toEqual(['shared-b', 'shared-x'])
  })

  it('the catalog side is also matched with NFKC + lowercase like the term (full-width, half-width kana)', () => {
    const wide = parseDirectoryCache(
      cache([listing('w', 'Ｚｅｎ Ｔｏｏｌｓ', { summary: 'ﾃｽﾄ helper' })], { w: 'zen-tools' }),
      spec,
      NOW,
      INDEX
    )
    const wideRecords = wide.ok ? wide.records : []
    expect(searchCatalog(wideRecords, 'zen tools', new Set()).entries.map((entry) => entry.name)).toEqual(['zen-tools'])
    expect(searchCatalog(wideRecords, 'テスト', new Set()).entries.map((entry) => entry.name)).toEqual(['zen-tools'])
    expect(searchCatalog(wideRecords, 'ｚｅｎ', new Set()).entries.map((entry) => entry.name)).toEqual(['zen-tools'])
  })
})

describe('parseInstalledPlugins', () => {
  it('one row per id; removable if there is a user scope; drops ids of the wrong shape', () => {
    const rows = parseInstalledPlugins({
      version: 2,
      plugins: {
        [`superpowers@${MARKET}`]: [{ scope: 'user', version: '6.4.2', installPath: '/x' }],
        'proj-only@other-market': [{ scope: 'project', projectPath: '/p' }],
        'both@m': [{ scope: 'local' }, { scope: 'user', version: '1' }],
        '--evil@m': [{ scope: 'user' }],
        'noat': [{ scope: 'user' }],
        'weird@m': [{ scope: 'galaxy' }]
      }
    })
    expect(rows.map((row) => [row.id, row.scope, row.removable])).toEqual([
      ['both@m', 'user', true],
      ['proj-only@other-market', 'project', false],
      [`superpowers@${MARKET}`, 'user', true],
      ['weird@m', 'other', false]
    ])
    expect(parseInstalledPlugins(null)).toEqual([])
    expect(parseInstalledPlugins({ plugins: [] })).toEqual([])
  })
})

describe('cleanText', () => {
  it('non-strings are empty and long ones are cut', () => {
    expect(cleanText(3, 10)).toBe('')
    expect(cleanText('abcdefghijkl', 5)).toBe('abcde…')
    expect(cleanText('a b', 10)).toBe('a b')
  })
})

let base: string
let home: string

function writeHomeFile(rel: string, data: unknown): string {
  const path = join(home, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
  return path
}

const rel = (value: string): string => value.replace(/^~\//, '')
const catalogPaths = paths.pluginCatalog!
const writeKnown = (data: unknown = { [MARKET]: { source: { source: 'github', repo: OFFICIAL_REPO } } }): string =>
  writeHomeFile(rel(catalogPaths.knownMarketplaces), data)
const writeCache = (data: unknown = fixture()): string => writeHomeFile(rel(catalogPaths.directoryCache), data)
const writeManifest = (data: unknown = manifest()): string =>
  writeHomeFile(rel(marketplaceManifestPath(catalogPaths.marketplaceManifest, MARKET)!), data)
const writeInstalled = (data: unknown): string => writeHomeFile(rel(paths.skills!.pluginsManifest), data)

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aios-plugin-catalog-')))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('marketplaceManifestPath', () => {
  it('the marketplace name has one source of truth in the table and the path table holds only locations (wave 76 review X)', () => {
    expect(catalogPaths.marketplaceManifest).toContain('<marketplace>')
    expect(catalogPaths.marketplaceManifest).not.toContain(MARKET)
    const path = marketplaceManifestPath(catalogPaths.marketplaceManifest, MARKET)
    expect(path).toContain(`/${MARKET}/`)
    expect(path).not.toContain('<marketplace>')
    expect(marketplaceManifestPath('~/x/<marketplace>/m.json', '../evil')).toBeNull()
    expect(marketplaceManifestPath('~/x/<marketplace>/m.json', 'a/b')).toBeNull()
    expect(marketplaceManifestPath('~/x/fixed/m.json', MARKET)).toBeNull()
  })
})

describe('readJsonGuarded', () => {
  it('missing, symlink, too large, not JSON', async () => {
    expect(await readJsonGuarded(join(home, 'nope.json'), 100)).toEqual({ state: 'missing' })
    const real = writeHomeFile('real.json', { a: 1 })
    const link = join(home, 'link.json')
    symlinkSync(real, link)
    expect((await readJsonGuarded(link, 100)).state).toBe('bad')
    expect((await readJsonGuarded(real, 3)).state).toBe('bad')
    expect((await readJsonGuarded(writeHomeFile('broken.json', '{'), 100)).state).toBe('bad')
    const ok = await readJsonGuarded(real, 100)
    expect(ok.state === 'ok' ? ok.data : null).toEqual({ a: 1 })
  })
})

describe('PluginCatalogReader', () => {
  const reader = (): PluginCatalogReader => new PluginCatalogReader({ home, paths, table: spec, now: () => NOW })

  it('no-marketplace when no marketplace is registered, no-cache when there is no catalog, malformed when the shape is wrong', async () => {
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'no-marketplace' })
    writeKnown({ 'someone-else': { source: {} } })
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'no-marketplace' })
    writeKnown('[1,2]')
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'malformed' })
    writeKnown()
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'no-cache' })
    writeCache('not json')
    // If the official marketplace's marketplace.json is missing (registered but with no contents), it is no-marketplace.
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'no-marketplace' })
    writeManifest('{')
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'malformed' })
    writeManifest({ plugins: 'none' })
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'malformed' })
    writeManifest()
    expect((await reader().read()).catalog).toEqual({ ok: false, reason: 'malformed' })
    writeCache()
    expect((await reader().read()).catalog.ok).toBe(true)
  })

  it('re-resolves the install name when marketplace.json changes (even if the catalog is the same)', async () => {
    writeKnown()
    writeCache()
    writeManifest()
    const r = reader()
    const record = async (): Promise<unknown> => {
      const snapshot = await r.read()
      return snapshot.catalog.ok ? snapshot.catalog.records.find((entry) => entry.name === 'code-review-official') : null
    }
    expect(await record()).toMatchObject({ installName: 'code-review', blocked: null })
    const next = manifest()
    next['plugins'] = (next['plugins'] as Array<Record<string, unknown>>).filter((plugin) => plugin['name'] !== 'code-review')
    writeManifest(next)
    expect(await record()).toMatchObject({ installName: null, blocked: 'not-in-marketplace' })
    // Re-fetched even when the marketplace's own source changes (the relative source no longer matches).
    writeManifest()
    writeKnown({ [MARKET]: { source: { source: 'github', repo: 'someone/fork' } } })
    expect(await record()).toMatchObject({ installName: null, blocked: 'not-in-marketplace' })
  })

  it('reads the catalog and installed plugins; does not re-resolve the same file', async () => {
    writeKnown()
    writeCache()
    writeManifest()
    writeInstalled({ plugins: { [`superpowers@${MARKET}`]: [{ scope: 'user' }] } })
    const r = reader()
    const first = await r.read()
    expect(first.catalog.ok).toBe(true)
    expect(first.installed.map((row) => row.id)).toEqual([`superpowers@${MARKET}`])
    const second = await r.read()
    expect(second.catalog).toBe(first.catalog)
  })

  it('keeps an old catalog without re-resolving and judges age with now each time', async () => {
    writeKnown()
    writeManifest()
    const path = writeCache()
    const fixedTime = 1_700_000_000
    utimesSync(path, fixedTime, fixedTime)
    let now = NOW + (spec.staleAfterDays + 1) * 24 * 60 * 60 * 1000
    const r = new PluginCatalogReader({ home, paths, table: spec, now: () => now })
    expect((await r.read()).catalog).toEqual({ ok: false, reason: 'stale' })
    // Replace it with broken contents of the same size and the same mtime: re-reading should give malformed.
    writeHomeFile(rel(catalogPaths.directoryCache), ' '.repeat(statSync(path).size))
    utimesSync(path, fixedTime, fixedTime)
    expect((await r.read()).catalog).toEqual({ ok: false, reason: 'stale' })
    now = NOW
    expect((await r.read()).catalog.ok).toBe(true)
  })

  it('no-backend-support when there is no table', async () => {
    const r = new PluginCatalogReader({ home, paths, table: undefined })
    expect((await r.read()).catalog).toEqual({ ok: false, reason: 'no-backend-support' })
  })
})

describe('parseResultLine', () => {
  it('hasResultLine: when a nonce is passed, only when a matching line exists; when not, lines without a nonce count', () => {
    expect(hasResultLine('{"outcome":"ok","nonce":"n1"}\n', 'n1')).toBe(true)
    expect(hasResultLine('{"outcome":"ok"}\n', 'n1')).toBe(false)
    expect(hasResultLine('{"outcome":"ok"}\n', null)).toBe(true)
    expect(hasResultLine('progress', null)).toBe(false)
  })

  it('takes the line whose nonce matches and takes no other JSON', () => {
    const out = [
      '{"outcome":"ok","nonce":"other"}',
      'progress text',
      '{"command":"install","outcome":"failed","failureCode":"command_source_refused","message":"/secret/path","nonce":"n1"}',
      ''
    ].join('\n')
    expect(parseResultLine(out, 'n1')).toEqual({ outcome: 'failed', failureCode: 'command_source_refused' })
  })

  it('for a version that does not echo the nonce, a line without a nonce field; null if there is none', () => {
    expect(parseResultLine('{"outcome":"ok"}\n', 'n1')).toEqual({ outcome: 'ok', failureCode: null })
    expect(parseResultLine('{"outcome":"ok","nonce":"zz"}\n', 'n1')).toBeNull()
    expect(parseResultLine('plain text', 'n1')).toBeNull()
    expect(parseResultLine('{"failureCode":"x"}', null)).toBeNull()
  })

  it('the reason code is only an identifier shape (no sentence)', () => {
    expect(parseResultLine('{"outcome":"failed","failureCode":"see /Users/x"}', null)).toEqual({
      outcome: 'failed',
      failureCode: 'unrecognized'
    })
  })
})

describe('judgePluginRun', () => {
  const run = (code: number | null, extra: Partial<PluginRunResult> = {}): PluginRunResult => ({
    code,
    stdout: '',
    timedOut: false,
    spawnError: null,
    ...extra
  })
  const line = (outcome: string, failureCode: string | null = null): { outcome: string; failureCode: string | null } => ({
    outcome,
    failureCode
  })

  it('exit code and the result line', () => {
    expect(judgePluginRun(spec, run(0), line('ok'))).toEqual({ ok: true, already: false })
    expect(judgePluginRun(spec, run(0), null)).toEqual({ ok: true, already: false })
    expect(judgePluginRun(spec, run(1), line('failed', 'already_in_goal_state'))).toEqual({ ok: true, already: true })
    expect(judgePluginRun(spec, run(1), line('failed', 'command_source_refused'))).toEqual({
      ok: false,
      reason: 'command-source'
    })
    expect(judgePluginRun(spec, run(1), line('failed', 'plugin_policy_blocked'))).toEqual({ ok: false, reason: 'policy' })
    expect(judgePluginRun(spec, run(1), line('failed', 'directory_unavailable'))).toEqual({ ok: false, reason: 'network' })
    expect(judgePluginRun(spec, run(1), line('failed', 'not_installed'))).toEqual({ ok: false, reason: 'not-installed' })
    expect(judgePluginRun(spec, run(1), line('failed', 'error_mystery'))).toEqual({
      ok: false,
      reason: 'failed',
      exitCode: 1
    })
    expect(judgePluginRun(spec, run(0), line('failed', 'error_mystery'))).toEqual({
      ok: false,
      reason: 'failed',
      exitCode: 0
    })
    expect(judgePluginRun(spec, run(null, { timedOut: true }), null)).toEqual({ ok: false, reason: 'timeout' })
    expect(judgePluginRun(spec, run(null, { spawnError: 'ENOENT' }), null)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('when the exit code and the result line are both present, looks at them before the timeout mark; timeout when neither a line nor an exit code exists', () => {
    expect(judgePluginRun(spec, run(0, { timedOut: true }), line('ok'))).toEqual({ ok: true, already: false })
    expect(judgePluginRun(spec, run(0, { timedOut: true }), null)).toEqual({ ok: false, reason: 'timeout' })
    expect(judgePluginRun(spec, run(null, { timedOut: true }), line('ok'))).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('runPluginCommand', () => {
  const sh = (script: string, timeoutMs: number, resultReady?: (stdout: string) => boolean): Promise<PluginRunResult> =>
    runPluginCommand('/bin/sh', ['-c', script], {
      timeoutMs,
      env: { PATH: '/usr/bin:/bin' },
      cwd: base,
      ...(resultReady === undefined ? {} : { resultReady })
    })

  it('when the CLI has ended and a line with a matching nonce exists, does not wait for close even if a grandchild holds stdout', async () => {
    const started = Date.now()
    const result = await sh(
      `echo '{"outcome":"ok","nonce":"n1"}'; sleep 3 & exit 0`,
      20_000,
      (stdout) => hasResultLine(stdout, 'n1')
    )
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(result).toMatchObject({ code: 0, timedOut: false, spawnError: null })
    expect(judgePluginRun(spec, result, parseResultLine(result.stdout, 'n1'))).toEqual({ ok: true, already: false })
  })

  it("does not consider lines without a nonce as complete; when time is up, stops the grandchild and returns with the CLI's exit code", async () => {
    const result = await sh(`echo '{"outcome":"ok"}'; sleep 5 & exit 0`, 300, (stdout) => hasResultLine(stdout, 'n1'))
    expect(result).toMatchObject({ code: 0, timedOut: false })
  })

  it('timeout if the CLI itself does not end', async () => {
    const result = await sh('sleep 5', 200, () => true)
    expect(result.timedOut).toBe(true)
    expect(judgePluginRun(spec, result, parseResultLine(result.stdout, 'n1'))).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('CliPluginManager', () => {
  interface Call {
    readonly command: string
    readonly args: readonly string[]
    readonly options: PluginRunOptions
  }

  function manager(
    options: { disabled?: 'dev' | null; blocker?: () => string | null; reply?: (call: Call) => PluginRunResult | Promise<PluginRunResult> } = {}
  ): { m: CliPluginManager; calls: Call[] } {
    const calls: Call[] = []
    const m = new CliPluginManager({
      opsDisabled: options.disabled ?? null,
      blocker: options.blocker ?? (() => null),
      home,
      env: { PATH: '/usr/bin' },
      now: () => NOW,
      run: async (command, args, runOptions) => {
        const call = { command, args, options: runOptions }
        calls.push(call)
        if (options.reply !== undefined) return options.reply(call)
        const nonce = spec.nonceEnv === undefined ? undefined : runOptions.env[spec.nonceEnv]
        return { code: 0, stdout: `${JSON.stringify({ outcome: 'ok', nonce })}\n`, timedOut: false, spawnError: null }
      }
    })
    return { m, calls }
  }

  beforeEach(() => {
    writeKnown()
    writeCache()
    writeManifest()
  })

  it('passes the official marketplace name to the CLI and, after installing, becomes 「入っている」 by that name (TODO 1177)', async () => {
    const { m, calls } = manager()
    expect((await m.catalog('code review')).entries.find((entry) => entry.name === 'code-review-official')).toMatchObject({
      installName: 'code-review',
      installed: false,
      blocked: null
    })
    // The renderer returns the listing name. main re-fetches it and passes the official name.
    expect(await m.install('code-review-official')).toEqual({ ok: true, already: false })
    expect(calls[0]?.args).toEqual([...spec.installArgs, `code-review@${MARKET}`, spec.jsonFlag])
    // The list of plugins the CLI installed writes the official name.
    writeInstalled({ plugins: { [`code-review@${MARKET}`]: [{ scope: 'user' }] } })
    expect((await m.catalog('code review')).entries.find((entry) => entry.name === 'code-review-official')?.installed).toBe(true)
  })

  it('even for an undecided listing, passes the same name as the list if the candidate is installed (wave 76 review X)', async () => {
    writeInstalled({ plugins: { [`shared-a@${MARKET}`]: [{ scope: 'user' }] } })
    const { m, calls } = manager()
    expect((await m.catalog('shared')).entries.find((entry) => entry.name === 'shared-x')).toMatchObject({
      installName: 'shared-a',
      installed: true,
      blocked: null
    })
    expect(await m.install('shared-x')).toEqual({ ok: true, already: false })
    expect(calls[0]?.args).toEqual([...spec.installArgs, `shared-a@${MARKET}`, spec.jsonFlag])
  })

  it('refuses without calling the CLI for listings not in the official marketplace or whose install name is undecided', async () => {
    const { m, calls } = manager()
    expect(await m.install('directory-only')).toEqual({ ok: false, reason: 'not-installable' })
    expect(await m.install('shared-x')).toEqual({ ok: false, reason: 'not-installable' })
    expect(calls).toEqual([])
  })

  it('reads the CLI not knowing the name (not_found) as not-installable (does not leave it as failed)', async () => {
    const { m } = manager({
      reply: (call) => ({
        code: 1,
        stdout: `${JSON.stringify({ outcome: 'failed', failureCode: 'not_found', nonce: spec.nonceEnv === undefined ? undefined : call.options.env[spec.nonceEnv] })}\n`,
        timedOut: false,
        spawnError: null
      })
    })
    expect(await m.install('frontend-design')).toEqual({ ok: false, reason: 'not-installable' })
  })

  it('calls the non-interactive subcommand with the marketplace added to the catalog name; passes the nonce by environment variable and cwd is home', async () => {
    const { m, calls } = manager()
    expect(await m.install('frontend-design')).toEqual({ ok: true, already: false })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe(table.command)
    expect(call.args).toEqual([...spec.installArgs, `frontend-design@${MARKET}`, spec.jsonFlag])
    expect(call.args).not.toContain('-y')
    expect(call.options.cwd).toBe(home)
    expect(call.options.timeoutMs).toBe(spec.timeoutMs)
    if (spec.nonceEnv !== undefined) expect(call.options.env[spec.nonceEnv]).toMatch(/^[0-9a-f]{32}$/)
    expect(call.options.env['PATH']).toBe('/usr/bin')
  })

  it('refuses without calling the CLI for names not in the catalog, of the wrong shape, or command type', async () => {
    const { m, calls } = manager()
    expect(await m.install('not-in-catalog')).toEqual({ ok: false, reason: 'invalid' })
    expect(await m.install('--yes')).toEqual({ ok: false, reason: 'invalid' })
    expect(await m.install(42)).toEqual({ ok: false, reason: 'invalid' })
    expect(await m.install('runs-command')).toEqual({ ok: false, reason: 'command-source' })
    expect(await m.install('strange')).toEqual({ ok: false, reason: 'not-installable' })
    expect(calls).toEqual([])
  })

  it('only the reason in dev and the fake backend; 「終わってから」 when a conversation is running', async () => {
    const disabled = manager({ disabled: 'dev' })
    expect(await disabled.m.install('frontend-design')).toEqual({ ok: false, reason: 'disabled' })
    const result = await disabled.m.catalog('')
    expect(result.opsDisabled).toBe('dev')
    expect(result.entries.length).toBeGreaterThan(0)
    const busy = manager({ blocker: () => 'streaming' })
    expect(await busy.m.install('frontend-design')).toEqual({ ok: false, reason: 'session-busy' })
    expect(disabled.calls).toEqual([])
    expect(busy.calls).toEqual([])
  })

  it('only one at a time', async () => {
    let release: (value: PluginRunResult) => void = () => undefined
    const { m } = manager({ reply: () => new Promise((resolve) => (release = resolve)) })
    const first = m.install('frontend-design')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await m.install('superpowers')).toEqual({ ok: false, reason: 'op-busy' })
    release({ code: 0, stdout: '', timedOut: false, spawnError: null })
    expect(await first).toEqual({ ok: true, already: false })
  })

  it('removes only those listed in the installed plugin list under the user scope', async () => {
    writeInstalled({
      plugins: {
        [`superpowers@${MARKET}`]: [{ scope: 'user' }],
        [`proj@${MARKET}`]: [{ scope: 'project', projectPath: '/p' }]
      }
    })
    const { m, calls } = manager()
    expect(await m.uninstall(`proj@${MARKET}`)).toEqual({ ok: false, reason: 'invalid' })
    expect(await m.uninstall('ghost@x')).toEqual({ ok: false, reason: 'not-installed' })
    expect(calls).toEqual([])
    expect(await m.uninstall(`superpowers@${MARKET}`)).toEqual({ ok: true, already: false })
    expect(calls[0]?.args).toEqual([...spec.uninstallArgs, `superpowers@${MARKET}`, spec.jsonFlag])
  })

  it('list: the installed mark, count and the command to type in a terminal; empty with a reason when there is no catalog', async () => {
    writeInstalled({ plugins: { [`superpowers@${MARKET}`]: [{ scope: 'user' }] } })
    const { m } = manager()
    const result = await m.catalog('super')
    expect(result.unavailable).toBeNull()
    expect(result.entries.map((entry) => [entry.name, entry.installed])).toEqual([['superpowers', true]])
    expect(result.total).toBe(9)
    expect(result.refreshCommand).toBe([table.command, ...spec.refreshHint].join(' '))
    rmSync(join(home, rel(catalogPaths.directoryCache)))
    const empty = await manager().m.catalog('')
    expect(empty.unavailable).toBe('no-cache')
    expect(empty.entries).toEqual([])
    expect(empty.installed.map((row) => row.id)).toEqual([`superpowers@${MARKET}`])
  })
})
