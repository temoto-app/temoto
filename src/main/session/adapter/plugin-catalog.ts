/**
 * Reads the CLI plugin catalog and the list of installed plugins (TODO 1099, ARCHITECTURE.md 4.5.3.3).
 *
 * The catalog is a cache the CLI fetches itself and places in the settings directory (`pluginCatalog` in `compat/backend-paths.json`).
 * aios **only reads** it: it does not write or fetch (constraint 2). It reads exactly four things: the catalog, the list of registered marketplaces,
 * the official marketplace's `marketplace.json`, and the list of installed plugins. All sit next to credentials, so they go through the same checks:
 *
 * - `lstat` for a regular file (symlinks and directories are not read), a size limit, open with `O_NOFOLLOW` and `fstat` again.
 * - Check the JSON shape (version, arrays, string types). Strings have control characters removed and their length clipped. Names must match `NAME_RE`.
 * - If the shape is wrong, stale, or missing, the catalog is emptied and a reason is returned (no silent failure).
 *
 * Whether something can be installed follows the CLI's reading of the catalog (the 2.1.317 binary): a listing whose `surfaces` lacks the table's `surface`
 * (including one where `surfaces` is absent or empty: the CLI lets an empty one through, but aios does not show it), and one
 * whose reviewed commit is not 40 hex digits, are not shown, since the CLI would not install them. A `source.type` in `commandSourceTypes`
 * (a form that runs an arbitrary command at install time) is shown with a reason and cannot be installed (stage 1, owner decision 2026-11-03).
 *
 * **The name to install (`installName`) is not the catalog's `entryNames`** (TODO 1177). `entryNames` are names of another virtual marketplace that the CLI builds from the catalog,
 * with a suffix added to avoid same-name collisions (`code-review-anthropics`). The official marketplace is looked up by the
 * name in `marketplace.json` (`code-review`), so the listing's `source.repository` `url` + `path` is matched against each plugin's `source` in
 * `marketplace.json` to look it up again. A listing with no match gets the reason `not-in-marketplace`, and one whose source has several names so that it cannot be decided gets
 * `ambiguous-in-marketplace`; both are shown and not installed
 * (option 1 of owner decision 2026-11-07). The "is installed" check also uses `installName`.
 *
 * Independent of electron (tests run with a fake home in a temporary directory).
 */
import { constants } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type {
  InstalledCliPlugin,
  PluginCatalogEntry,
  PluginCatalogUnavailable,
  PluginEntryBlock,
  PluginReview
} from '../../../shared/skills.js'
import type { BackendPaths, PluginsTable } from './compat.js'
import { expandHome } from '../../home-path.js'
import { openNoFollow } from '../../../common/os/open-flags.js'

/** Upper bound on the size of the installed-plugin list and the marketplace list. */
export const SMALL_FILE_MAX_BYTES = 1024 * 1024
/** Upper bound on the size of the official marketplace's `marketplace.json` (on 2026-11-07: 317 entries, about 190 KB). */
export const MARKETPLACE_MAX_BYTES = 4 * 1024 * 1024
/** Upper bound on the number of plugins counted in `marketplace.json`. */
const MAX_MARKETPLACE_PLUGINS = 10_000
/** Upper bound on the number of listings counted in the catalog (so an abnormal count cannot stall us). */
const MAX_LISTINGS = 50_000
/** Upper bound on installed plugins. */
const MAX_INSTALLED = 500
/** Default number of entries returned at once. */
export const CATALOG_PAGE = 50
const DAY_MS = 24 * 60 * 60 * 1000

/** The shape of an install name / marketplace name (CLI names are lowercase letters, digits and `._-`). It starts with an alphanumeric (so it cannot turn into a flag). */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COMMIT_RE = /^[0-9a-f]{40}$/

export type GuardedRead =
  | { readonly state: 'missing' }
  | { readonly state: 'bad' }
  | { readonly state: 'ok'; readonly data: unknown; readonly mtimeMs: number; readonly size: number }

/** Reads one file next to the credentials. `ok` only if it is a regular file, within the limit, and JSON. Does not throw. */
export async function readJsonGuarded(path: string, maxBytes: number): Promise<GuardedRead> {
  let first
  try {
    first = await lstat(path)
  } catch {
    return { state: 'missing' }
  }
  if (!first.isFile() || first.size > maxBytes) return { state: 'bad' }
  let handle
  try {
    handle = await openNoFollow(path, constants.O_RDONLY, { nonBlock: false })
  } catch {
    return { state: 'bad' }
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxBytes) return { state: 'bad' }
    const buffer = Buffer.alloc(stats.size)
    let read = 0
    while (read < stats.size) {
      const { bytesRead } = await handle.read(buffer, read, stats.size - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { state: 'ok', data: JSON.parse(buffer.subarray(0, read).toString('utf8')), mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return { state: 'bad' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Turns control characters into spaces, collapses runs of spaces to one, and clips the length. An empty string if not a string. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** One catalog entry (with search material). */
export interface CatalogRecord extends Omit<PluginCatalogEntry, 'installed'> {
  /** The name, display name, description and provider, NFKC-normalized and lowercased (used for word matching). */
  readonly haystack: string
  /** The catalog name (`name`), lowercased. Names coming back from the renderer are looked up by this. */
  readonly nameKey: string
  /**
   * Candidate names when `ambiguous-in-marketplace` (names in the same source's `marketplace.json`, excluding those taken as another listing's
   * install name). If a candidate is installed from a terminal, `withInstalledCandidates` takes it as the install name. Empty otherwise.
   */
  readonly candidates: readonly string[]
}

export type CatalogParse =
  | { readonly ok: true; readonly records: readonly CatalogRecord[]; readonly fetchedAt: number }
  | { readonly ok: false; readonly reason: PluginCatalogUnavailable }

/** A table that looks up the official marketplace's plugins by source (`<url>\n<path>`). The values are names (in `marketplace.json` order). */
export type MarketplaceIndex = ReadonlyMap<string, readonly string[]>

/** How source URLs are compared: strip surrounding whitespace, a trailing `/` and `.git`, and lowercase. Null if not in https form. */
function normalizeRepositoryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null
  let url = value.trim().toLowerCase().replace(/\/+$/, '')
  if (url.endsWith('.git')) url = url.slice(0, -4)
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?\/\S+$/.test(url) ? url : null
}

/** How paths inside a repository are compared: strip a leading `./` and surrounding `/`. Empty if absent. Null for `..` or odd shapes. */
function normalizeRepositoryPath(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 500) return null
  let path = value.trim()
  while (path.startsWith('./')) path = path.slice(2)
  path = path.replace(/^\/+|\/+$/g, '')
  if (path === '' || path === '.') return ''
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(path)) return null
  return path.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : path
}

const sourceKey = (url: string, path: string): string => `${url}\n${path}`

/**
 * Whether a string source in `marketplace.json` is relative to the marketplace root (both `./plugins/x` and `plugins/x`).
 * Absolute paths (`/`, `~`), URLs (`https://`, `file:` and other `<scheme>:` forms) and the `git@host:` form are not relative.
 */
function isRelativeSource(source: string): boolean {
  const text = source.trim()
  if (text === '' || text.startsWith('/') || text.startsWith('~') || text.startsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return false
  return !text.startsWith('git@') && !/^[^/\s]+@[^/\s]+:/.test(text)
}

/** The `owner/repo` form (neither part is `.` / `..`). */
const GITHUB_REPO_RE = /^(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/** Derives the source URL from the `{ source: 'github', repo }` / `{ source: 'git' | 'url' | 'git-subdir', url }` forms. */
function repositoryUrlOf(source: Record<string, unknown>): string | null {
  const kind = source['source']
  if (kind === 'github') {
    const repo = source['repo']
    return typeof repo === 'string' && GITHUB_REPO_RE.test(repo) ? normalizeRepositoryUrl(`https://github.com/${repo}`) : null
  }
  if (kind === 'git' || kind === 'url' || kind === 'git-subdir') return normalizeRepositoryUrl(source['url'])
  return null
}

/**
 * From the list of registered marketplaces, looks up that marketplace's own repository URL (to resolve relative sources
 * like `./plugins/<dir>` in `marketplace.json`). Null if absent or malformed (relative sources then match nothing).
 */
export function marketplaceRepositoryUrl(data: unknown, name: string): string | null {
  if (!isRecord(data) || !Object.prototype.hasOwnProperty.call(data, name)) return null
  const entry = data[name]
  if (!isRecord(entry) || !isRecord(entry['source'])) return null
  return repositoryUrlOf(entry['source'])
}

/**
 * Turns the official marketplace's `marketplace.json` into a source → name table (pure function). Null if the shape is wrong.
 * Source forms: a string (`./plugins/<dir>` or `plugins/<dir>`, relative inside the marketplace's own repository),
 * `{ source: 'url' | 'git-subdir' | 'git', url, path? }`, `{ source: 'github', repo, path? }`.
 * Others, such as forms that run a command, are not listed (they match nothing).
 */
export function parseMarketplaceManifest(data: unknown, repositoryUrl: string | null): MarketplaceIndex | null {
  if (!isRecord(data)) return null
  const plugins = data['plugins']
  if (!Array.isArray(plugins)) return null
  const index = new Map<string, string[]>()
  for (const plugin of plugins.slice(0, MAX_MARKETPLACE_PLUGINS)) {
    if (!isRecord(plugin)) continue
    const name = plugin['name']
    if (typeof name !== 'string' || !NAME_RE.test(name)) continue
    const source = plugin['source']
    let url: string | null
    let path: string | null
    if (typeof source === 'string') {
      // A relative source is inside the marketplace's own repository (the CLI resolves it relative to the marketplace root whether or not there is a `./`).
      // Absolute paths, URLs (`<scheme>:`) and the `git@` form do not match.
      if (!isRelativeSource(source)) continue
      url = repositoryUrl
      path = normalizeRepositoryPath(source)
    } else if (isRecord(source)) {
      url = repositoryUrlOf(source)
      path = normalizeRepositoryPath(source['path'])
    } else continue
    if (url === null || path === null) continue
    const key = sourceKey(url, path)
    const names = index.get(key)
    if (names === undefined) index.set(key, [name])
    else if (!names.includes(name)) names.push(name)
  }
  return index
}

/**
 * Looks up the install name from a listing's source. If it settles on one, that name; if nothing matches, `not-in-marketplace`; if the same source has
 * several names and none equals the catalog's name, `ambiguous-in-marketplace` (with the candidate names).
 */
function resolveInstallName(
  repository: unknown,
  entryName: string,
  index: MarketplaceIndex
): { name: string } | { blocked: PluginEntryBlock; candidates: readonly string[] } {
  if (!isRecord(repository)) return { blocked: 'not-in-marketplace', candidates: [] }
  const url = normalizeRepositoryUrl(repository['url'])
  const path = normalizeRepositoryPath(repository['path'])
  if (url === null || path === null) return { blocked: 'not-in-marketplace', candidates: [] }
  const names = index.get(sourceKey(url, path))
  if (names === undefined || names.length === 0) return { blocked: 'not-in-marketplace', candidates: [] }
  if (names.length === 1) return { name: names[0]! }
  const same = names.find((name) => name.toLowerCase() === entryName.toLowerCase())
  return same === undefined ? { blocked: 'ambiguous-in-marketplace', candidates: names } : { name: same }
}

/** Reads one entry. Null for what the CLI would not install (another surface, no commit, no name). */
function parseListing(
  listing: unknown,
  names: Record<string, unknown>,
  table: PluginsTable,
  index: MarketplaceIndex
): CatalogRecord | null {
  if (!isRecord(listing)) return null
  const id = listing['id']
  if (typeof id !== 'string' || id === '' || id.length > 200 || !Object.prototype.hasOwnProperty.call(names, id)) return null
  const name = names[id]
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null
  // A listing that does not include the table's surface (`surfaces` absent, empty, or only other surfaces) is not shown. The CLI lets an empty `surfaces` through,
  // but aios does not recommend something that does not say which surface it is for (the same treatment as the form other CLIs reject).
  const surfaces = listing['surfaces']
  if (!Array.isArray(surfaces) || !surfaces.includes(table.surface)) return null
  const source = listing['source']
  if (!isRecord(source) || typeof source['type'] !== 'string') return null
  const type = source['type']
  let blocked: PluginEntryBlock | null = null
  let installName: string | null = null
  let candidates: readonly string[] = []
  if (table.commandSourceTypes.includes(type)) blocked = 'command-source'
  else if (!table.sourceTypes.includes(type)) blocked = 'unsupported-source'
  else {
    const repository = source['repository']
    const commit = isRecord(repository) ? repository['reviewed_commit'] : undefined
    // The CLI does not install what is not pinned to a reviewed commit (no_pin).
    if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) return null
    const resolved = resolveInstallName(repository, name, index)
    if ('name' in resolved) installName = resolved.name
    else {
      blocked = resolved.blocked
      candidates = resolved.candidates
    }
  }
  const title = cleanText(listing['name'], 100) || name
  const summary = cleanText(listing['summary'] ?? listing['description'], 300)
  const release = listing['release']
  const version = isRecord(release) ? cleanText(release['version'], 40) || null : null
  const publisherRecord = listing['publisher']
  const publisher = isRecord(publisherRecord) ? cleanText(publisherRecord['name'], 100) || null : null
  const checks = listing['checks']
  const reviewRecord = isRecord(checks) ? checks['review'] : undefined
  let review: PluginReview | null = null
  if (isRecord(reviewRecord) && reviewRecord['state'] === 'done' && isRecord(reviewRecord['by'])) {
    const by = reviewRecord['by']['type']
    if (typeof by === 'string' && Object.prototype.hasOwnProperty.call(table.reviewers, by)) review = table.reviewers[by] ?? null
  }
  return {
    name,
    installName,
    title,
    summary,
    version,
    publisher,
    review,
    blocked,
    nameKey: name.toLowerCase(),
    candidates,
    haystack: foldText([name, installName ?? '', title, summary, publisher ?? ''].join('\n'))
  }
}

/** Folding for matching (NFKC → lowercase). The same is used for the search terms and the catalog side. */
function foldText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** Checks the contents of the catalog cache (pure function). `index` is the official marketplace's source → name table. */
export function parseDirectoryCache(data: unknown, table: PluginsTable, now: number, index: MarketplaceIndex): CatalogParse {
  return judgeFreshness(parseDirectoryCacheBody(data, table, index), table, now)
}

/**
 * Judges freshness and whether there is any content. `body` is the result of `parseDirectoryCacheBody` (records may be empty). If old, stale;
 * if there is not a single listing to show, no-cache. The reader caches `body` and applies this every time.
 */
function judgeFreshness(body: CatalogParse, table: PluginsTable, now: number): CatalogParse {
  if (!body.ok) return body
  if (now - body.fetchedAt > table.staleAfterDays * DAY_MS) return { ok: false, reason: 'stale' }
  if (body.records.length === 0) return { ok: false, reason: 'no-cache' }
  return body
}

/** The check without looking at freshness. It is ok even if no listing is included (records are empty). */
function parseDirectoryCacheBody(data: unknown, table: PluginsTable, index: MarketplaceIndex): CatalogParse {
  if (!isRecord(data)) return { ok: false, reason: 'malformed' }
  if (data['schemaVersion'] !== table.catalogSchemaVersion) return { ok: false, reason: 'malformed' }
  const fetchedRaw = data['fetchedAt']
  const fetchedAt = typeof fetchedRaw === 'string' ? Date.parse(fetchedRaw) : NaN
  if (!Number.isFinite(fetchedAt)) return { ok: false, reason: 'malformed' }
  const listings = data['listings']
  if (!Array.isArray(listings)) return { ok: false, reason: 'malformed' }
  const names = data['entryNames']
  if (names !== undefined && !isRecord(names)) return { ok: false, reason: 'malformed' }
  // A catalog written with names only (the form where the CLI omitted the listings because it was too big) is the same as having no contents.
  if (data['listingsOmitted'] === true || listings.length === 0 || names === undefined) return { ok: false, reason: 'no-cache' }
  const records: CatalogRecord[] = []
  const seen = new Set<string>()
  // A second entry that resolves to the same install name (a different catalog name but the same source) is also dropped. The one that came first stays (wave 76 review X).
  const seenInstall = new Set<string>()
  for (const listing of listings.slice(0, MAX_LISTINGS)) {
    const record = parseListing(listing, names, table, index)
    if (record === null || seen.has(record.nameKey)) continue
    const installKey = record.installName?.toLowerCase() ?? null
    if (installKey !== null && seenInstall.has(installKey)) continue
    seen.add(record.nameKey)
    if (installKey !== null) seenInstall.add(installKey)
    records.push(record)
  }
  // From an undecided listing's candidates, remove those taken as another listing's install name (so two rows do not become Installed under the same name).
  const narrowed = records.map((record) => {
    if (record.candidates.length === 0) return record
    const candidates = record.candidates.filter((name) => !seenInstall.has(name.toLowerCase()))
    return candidates.length === record.candidates.length ? record : { ...record, candidates }
  })
  return { ok: true, records: narrowed, fetchedAt }
}

/**
 * For an undecided listing (`ambiguous-in-marketplace`), if one of the candidate names is already installed (from a terminal, for example), that name is
 * taken as the install name and the listing is treated as installable (wave 76 review X). The installed names are `installedNames` (those of the official marketplace,
 * lowercase). A name is taken by only one listing (the earlier one in catalog order). A record that does not change is returned as is.
 */
export function withInstalledCandidates(
  records: readonly CatalogRecord[],
  installedNames: ReadonlySet<string>
): readonly CatalogRecord[] {
  if (installedNames.size === 0 || !records.some((record) => record.candidates.length > 0)) return records
  const taken = new Set<string>()
  return records.map((record) => {
    if (record.blocked !== 'ambiguous-in-marketplace') return record
    const name = record.candidates.find((candidate) => {
      const key = candidate.toLowerCase()
      return installedNames.has(key) && !taken.has(key)
    })
    if (name === undefined) return record
    taken.add(name.toLowerCase())
    return { ...record, installName: name, blocked: null, haystack: `${record.haystack}\n${foldText(name)}` }
  })
}

/** The names (lowercase) of the installed plugins that belong to `marketplace`. Compared with `installName`. */
export function installedNamesOf(installed: readonly InstalledCliPlugin[], marketplace: string | undefined): Set<string> {
  return new Set(installed.filter((plugin) => plugin.marketplace === marketplace).map((plugin) => plugin.name.toLowerCase()))
}

/** Whether `name` is in the list of registered marketplaces. Null if the shape is wrong. */
export function hasMarketplace(data: unknown, name: string): boolean | null {
  if (!isRecord(data)) return null
  return Object.prototype.hasOwnProperty.call(data, name) && isRecord(data[name])
}

const SCOPES = new Set(['user', 'project', 'local'])

/** The list of installed plugins (empty if the shape is wrong). If one id has several scopes, the user scope is the representative. */
export function parseInstalledPlugins(data: unknown): InstalledCliPlugin[] {
  if (!isRecord(data)) return []
  const plugins = data['plugins']
  if (!isRecord(plugins)) return []
  const out: InstalledCliPlugin[] = []
  for (const [id, value] of Object.entries(plugins).slice(0, MAX_INSTALLED)) {
    const at = id.lastIndexOf('@')
    if (at <= 0) continue
    const name = id.slice(0, at)
    const marketplace = id.slice(at + 1)
    if (!NAME_RE.test(name) || !NAME_RE.test(marketplace)) continue
    const installs = (Array.isArray(value) ? value : [value]).filter(isRecord)
    if (installs.length === 0) continue
    const user = installs.find((install) => install['scope'] === 'user')
    const chosen = user ?? installs[0]!
    const rawScope = chosen['scope']
    const scope =
      typeof rawScope === 'string' && SCOPES.has(rawScope) ? (rawScope as InstalledCliPlugin['scope']) : 'other'
    out.push({
      id,
      name,
      marketplace,
      scope,
      version: cleanText(chosen['version'], 40) || null,
      removable: user !== undefined
    })
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/**
 * Filters by words (those that contain all the words). Order: name match → prefix match → in the name → in the description; ties go to installable ones,
 * then the review badge, then the display name. `installedNames` are the installed plugins' names (those of the official marketplace, lowercase) and are compared with `installName`
 * (for an undecided listing, by the candidate's name if it is installed: `withInstalledCandidates`).
 */
export function searchCatalog(
  records: readonly CatalogRecord[],
  query: string,
  installedNames: ReadonlySet<string>,
  limit = CATALOG_PAGE
): { entries: PluginCatalogEntry[]; matched: number } {
  const terms = foldText(query).split(/\s+/).filter((term) => term !== '')
  const whole = terms.join(' ')
  const rank = (record: CatalogRecord): number => {
    if (terms.length === 0) return 0
    const title = foldText(record.title)
    const install = record.installName === null ? null : record.installName.toLowerCase()
    const named = (test: (name: string) => boolean): boolean =>
      test(record.nameKey) || test(title) || (install !== null && test(install))
    if (named((name) => name === whole)) return 0
    if (named((name) => name.startsWith(whole))) return 1
    if (terms.every((term) => named((name) => name.includes(term)))) return 2
    return 3
  }
  const reviewRank = (review: PluginReview | null): number => (review === 'first-party' ? 0 : review === 'partner' ? 1 : 2)
  const hits = withInstalledCandidates(records, installedNames)
    .filter((record) => terms.every((term) => record.haystack.includes(term)))
    .map((record) => ({ record, rank: rank(record) }))
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(a.record.blocked !== null) - Number(b.record.blocked !== null) ||
      reviewRank(a.record.review) - reviewRank(b.record.review) ||
      a.record.title.localeCompare(b.record.title, 'en', { sensitivity: 'base' })
  )
  const entries = hits.slice(0, Math.max(0, limit)).map(({ record }) => ({
    name: record.name,
    installName: record.installName,
    title: record.title,
    summary: record.summary,
    version: record.version,
    publisher: record.publisher,
    review: record.review,
    installed: record.installName !== null && installedNames.has(record.installName.toLowerCase()),
    blocked: record.blocked
  }))
  return { entries, matched: hits.length }
}

/** Fills the `<marketplace>` placeholder in the path table's `marketplace.json` location with the table's marketplace name. */
const MARKETPLACE_PLACEHOLDER = '<marketplace>'

/**
 * The path of the official marketplace's `marketplace.json` (still starting with `~/`). The single source of truth for the marketplace name is the table's
 * `plugins.marketplace`; the path table has only the `<marketplace>` placeholder (wave 76 review X).
 * Null if there is no placeholder or the name does not match `NAME_RE` (a `/` or a leading `.` would shift the path).
 */
export function marketplaceManifestPath(template: string, marketplace: string): string | null {
  if (!template.includes(MARKETPLACE_PLACEHOLDER) || !NAME_RE.test(marketplace)) return null
  return template.split(MARKETPLACE_PLACEHOLDER).join(marketplace)
}

export interface CatalogSnapshot {
  readonly catalog: CatalogParse
  readonly installed: readonly InstalledCliPlugin[]
}

export interface CatalogReaderDeps {
  readonly home?: string
  readonly paths: BackendPaths
  readonly table: PluginsTable | undefined
  readonly now?: () => number
}

/**
 * Reads four files and returns the catalog and the list of installed plugins. The catalog is large (several MB), so if mtime and size are the same,
 * the previous read is reused (the JSON is not re-parsed every time settings open). A stale catalog is kept the same way, and staleness is checked against `now` every time.
 */
export class PluginCatalogReader {
  private cached: { key: string; body: CatalogParse } | null = null

  constructor(private readonly deps: CatalogReaderDeps) {}

  async read(): Promise<CatalogSnapshot> {
    const { paths, table } = this.deps
    const home = this.deps.home ?? homedir()
    const installed = await this.readInstalled(home)
    const files = paths.pluginCatalog
    if (table === undefined || files === undefined) {
      return { catalog: { ok: false, reason: 'no-backend-support' }, installed }
    }
    const known = await readJsonGuarded(expandHome(files.knownMarketplaces, home), SMALL_FILE_MAX_BYTES)
    if (known.state === 'missing') return { catalog: { ok: false, reason: 'no-marketplace' }, installed }
    if (known.state === 'bad') return { catalog: { ok: false, reason: 'malformed' }, installed }
    const registered = hasMarketplace(known.data, table.marketplace)
    if (registered === null) return { catalog: { ok: false, reason: 'malformed' }, installed }
    if (!registered) return { catalog: { ok: false, reason: 'no-marketplace' }, installed }
    const repositoryUrl = marketplaceRepositoryUrl(known.data, table.marketplace)
    const path = expandHome(files.directoryCache, home)
    const manifestTemplate = marketplaceManifestPath(files.marketplaceManifest, table.marketplace)
    if (manifestTemplate === null) return { catalog: { ok: false, reason: 'no-backend-support' }, installed }
    const manifestPath = expandHome(manifestTemplate, home)
    const now = (this.deps.now ?? Date.now)()
    // If the sizes and mtimes of the catalog and marketplace.json and the marketplace source are the same as before, do not re-parse (staleness is still checked every time).
    let stats
    try {
      stats = await lstat(path)
    } catch {
      return { catalog: { ok: false, reason: 'no-cache' }, installed }
    }
    let manifestStats
    try {
      manifestStats = await lstat(manifestPath)
    } catch {
      return { catalog: { ok: false, reason: 'no-marketplace' }, installed }
    }
    const keyOf = (cacheMtime: number, cacheSize: number, manifestMtime: number, manifestSize: number): string =>
      [path, cacheMtime, cacheSize, manifestPath, manifestMtime, manifestSize, repositoryUrl ?? ''].join('\n')
    const key = keyOf(stats.mtimeMs, stats.size, manifestStats.mtimeMs, manifestStats.size)
    if (this.cached === null || this.cached.key !== key) {
      const manifest = await readJsonGuarded(manifestPath, MARKETPLACE_MAX_BYTES)
      if (manifest.state === 'missing') return { catalog: { ok: false, reason: 'no-marketplace' }, installed }
      if (manifest.state === 'bad') return { catalog: { ok: false, reason: 'malformed' }, installed }
      const index = parseMarketplaceManifest(manifest.data, repositoryUrl)
      if (index === null) return { catalog: { ok: false, reason: 'malformed' }, installed }
      const cache = await readJsonGuarded(path, table.catalogMaxBytes)
      if (cache.state === 'missing') return { catalog: { ok: false, reason: 'no-cache' }, installed }
      if (cache.state === 'bad') return { catalog: { ok: false, reason: 'malformed' }, installed }
      // Keep the result of the check that ignores freshness (a stale catalog is not re-parsed either). Staleness is checked below against `now` every time.
      this.cached = {
        key: keyOf(cache.mtimeMs, cache.size, manifest.mtimeMs, manifest.size),
        body: parseDirectoryCacheBody(cache.data, table, index)
      }
    }
    // When ok, return the cached object itself.
    return { catalog: judgeFreshness(this.cached.body, table, now), installed }
  }

  private async readInstalled(home: string): Promise<InstalledCliPlugin[]> {
    const manifest = this.deps.paths.skills?.pluginsManifest
    if (manifest === undefined) return []
    const read = await readJsonGuarded(expandHome(manifest, home), SMALL_FILE_MAX_BYTES)
    return read.state === 'ok' ? parseInstalledPlugins(read.data) : []
  }
}
