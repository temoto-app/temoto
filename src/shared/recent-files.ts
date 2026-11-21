/**
 * "Recent files" (TODO 999, ARCHITECTURE.md 4.5.12). Types and tables used by the Composer's "recent" popover, the recent-file badge (TODO 1172) and
 * the empty `@` suggestions. Imported from 3 places: main / the index process / the renderer (independent of electron).
 *
 * Definition of "recent" (owner decision 2026-10-25): excluding machine updates (`git checkout`, builds, etc.), only updates by the user and the AI.
 * Applied in this order - (1) files the AI wrote in an aios conversation are included, (2) under git management only modified / untracked
 * (clean and ignored are dropped), (3) otherwise, "`BULK_COUNT` or more files in one folder within `BULK_WINDOW_MS`" is dropped as a bulk update.
 */

/** Order of the kind filter (the order of the UI buttons). */
export const RECENT_KINDS = ['image', 'video', 'document', 'code'] as const
export type RecentKind = (typeof RECENT_KINDS)[number]

/**
 * Extensions per kind (lowercase, no dot. Same form as `FileEntry.ext`). Extensions not listed here do not appear in "recent"
 * (noise such as `.o` / `.lock` / no extension is dropped from the start).
 */
export const RECENT_EXTENSIONS: Readonly<Record<RecentKind, readonly string[]>> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'avif'],
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
  document: [
    'pdf',
    'txt',
    'md',
    'markdown',
    'rtf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'csv',
    'tsv',
    'ppt',
    'pptx',
    'pages',
    'numbers',
    'key',
    'odt',
    'ods',
    'odp',
    'html',
    'htm',
    'zip',
    'epub'
  ],
  code: [
    'c',
    'h',
    'cc',
    'cpp',
    'cxx',
    'hpp',
    'hh',
    'm',
    'mm',
    'swift',
    'rs',
    'go',
    'py',
    'rb',
    'js',
    'jsx',
    'mjs',
    'ts',
    'tsx',
    'java',
    'kt',
    'cs',
    'php',
    'sh',
    'zsh',
    'lua',
    's',
    'asm',
    'sql',
    'json',
    'yaml',
    'yml',
    'toml',
    'xml',
    'css',
    'scss',
    'vue',
    'svelte'
  ]
}

const KIND_BY_EXT: ReadonlyMap<string, RecentKind> = new Map(
  RECENT_KINDS.flatMap((kind) => RECENT_EXTENSIONS[kind].map((ext) => [ext, kind] as const))
)

/** The kind of an extension. null if it is not in the table (= does not appear in "recent"). */
export function recentKindOf(ext: string): RecentKind | null {
  return KIND_BY_EXT.get(ext.toLowerCase()) ?? null
}

/** All extensions in the table (the index process's filter). */
export const RECENT_EXTENSION_SET: ReadonlySet<string> = new Set(KIND_BY_EXT.keys())

/**
 * TODO 1180: extensions shown in the recent-file badge (the automatically offered one). Only common documents, images and videos, narrower than the popover (`RECENT_EXTENSIONS`)
 * (no code, config, archives, installers or audio). A set independent of the popover's table (the popover is not narrowed).
 */
export const RECENT_OFFER_EXTENSIONS: ReadonlySet<string> = new Set([
  ...['txt', 'md', 'markdown', 'rtf', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'pages', 'numbers', 'key'],
  ...['odt', 'ods', 'odp', 'html', 'htm', 'epub'],
  ...['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'tiff', 'tif', 'bmp', 'svg'],
  ...['mov', 'mp4', 'm4v', 'webm']
])
/** Folders shown in the badge (names directly under home. The real names are English; Finder's localized names are display names). */
export const RECENT_OFFER_FOLDERS = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Pictures'] as const

/** The period of the list (owner decision: the last 7 days). */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** The cap on the number of items in the list (owner decision: at most 200). */
export const RECENT_MAX = 200
/** The count treated as a bulk update (same folder, within `BULK_WINDOW_MS`). A provisional value to settle with real data. */
export const BULK_COUNT = 20
/** The time width treated as a bulk update. */
export const BULK_WINDOW_MS = 2 * 60 * 1000
/**
 * How long the recent-file badge is shown (owner decision for the 999 screenshot badge: within 5 minutes. TODO 1172 uses the same width).
 */
export const RECENT_OFFER_MS = 5 * 60 * 1000
/** The cap on the number of badges (TODO 1172 owner decision 2026-11-07: at most 3, newest first. 12 by TODO 1198 owner decision 2026-11-10). */
export const RECENT_OFFER_MAX = 12
/**
 * The number of badge candidates main (`recent.offers`) returns (wave 75 review). Removing dismissed / already attached badges is the renderer's job (`visibleOffers`),
 * so if main cut at the limit, the next badge would not appear after one is dismissed. Return somewhat more, and the renderer takes the first `RECENT_OFFER_MAX` after removal.
 */
export const RECENT_OFFER_FETCH = RECENT_OFFER_MAX * 2
// Badges are narrowed by folder and extension first and then counted (`accept` of collect), so this number stays the number remaining after narrowing.

/**
 * Candidates the index process returns (`fs.recentFiles`). After narrowing by the extension table, exclusions and hidden folders, before the git and AI checks.
 * `bulk` says whether it hit a bulk update (many files in the same folder in a short time) - even then main keeps files the AI wrote.
 */
export interface RecentCandidate {
  readonly uri: string
  readonly parentUri: string
  readonly name: string
  readonly ext: string
  readonly size: number
  readonly mtimeMs: number
  readonly bulk: boolean
}

/** One entry of the list (passed to the renderer). The renderer may see the path (item 55). */
export interface RecentFile {
  readonly uri: string
  readonly parentUri: string
  readonly name: string
  readonly ext: string
  readonly size: number
  readonly mtimeMs: number
  readonly kind: RecentKind
  /** A file the AI wrote in an aios conversation (shows "AI" on the badge). */
  readonly ai: boolean
}

/** Arguments of `recent.list`. Omitted means all kinds and `RECENT_MAX` items. */
export interface RecentListOptions {
  readonly kinds?: readonly RecentKind[]
  readonly limit?: number
}

/** Validates a value from the renderer (unknown kinds are dropped, the count is 1 to `RECENT_MAX`). */
export function asRecentListOptions(value: unknown): { kinds: readonly RecentKind[] | null; limit: number } {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const rawKinds = record['kinds']
  const kinds = Array.isArray(rawKinds)
    ? rawKinds.filter((kind): kind is RecentKind => typeof kind === 'string' && (RECENT_KINDS as readonly string[]).includes(kind))
    : null
  const rawLimit = record['limit']
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), RECENT_MAX) : RECENT_MAX
  return { kinds: kinds === null || kinds.length === 0 ? null : kinds, limit }
}

/** Kinds whose thumbnail is taken with QuickLook (images, videos, PDF). Others get an icon and a name. */
export function hasRecentThumbnail(ext: string): boolean {
  const kind = recentKindOf(ext)
  return kind === 'image' || kind === 'video' || ext.toLowerCase() === 'pdf'
}
