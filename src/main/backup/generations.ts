/**
 * Names of backup generations and which ones to delete (TODO 1306, ARCHITECTURE 8.7). Pure functions, independent of electron.
 *
 * - A finished generation is `backup-YYYYMMDD-HHMMSSZ-<owner>.aiosdata` (UTC). `<owner>` is the profile's random id (16 hex digits,
 *   `ownerId` in `service.ts`; no machine or user name), so two machines / profiles sharing one folder never rotate out, list or restore
 *   each other's generations.
 * - A file being written is `.backup-YYYYMMDD-HHMMSSZ-<owner>-<nonce>.aiosdata.partial` (`<nonce>` = 16 random hex digits, so the name
 *   cannot be predicted and planted in advance), created exclusively and renamed to the final name only after it is complete, so a
 *   crash midway never leaves a broken generation.
 * - **Only names of exactly this shape are ours.** Rotation and the cleanup of leftovers never touch any other file in the folder
 *   (the folder may be one the user chose, holding their own files), nor another owner's generations.
 * - **A generation stamped further in the future than `futureMs` (the clock went back) is ordered after every other one**: it is
 *   neither "the newest" (for the schedule and the restore) nor protected by rotation, so it is pushed out first.
 */
import { DATA_TRANSFER_EXTENSION } from '@shared/data-transfer.js'

const ID_RE_SOURCE = '[0-9a-f]{16}'
const OWNER_RE = new RegExp(`^${ID_RE_SOURCE}$`)
const FINAL_RE = new RegExp(`^backup-(\\d{8})-(\\d{6})Z-(${ID_RE_SOURCE})\\.${DATA_TRANSFER_EXTENSION}$`)
const PARTIAL_RE = new RegExp(`^\\.backup-(\\d{8})-(\\d{6})Z-(${ID_RE_SOURCE})-${ID_RE_SOURCE}\\.${DATA_TRANSFER_EXTENSION}\\.partial$`)

/** A valid owner id / nonce (16 lowercase hex digits). */
export function isBackupId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_RE.test(value)
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

/** Parses the 8 + 6 digits back into ms. null if the date is not a real one (e.g. month 13), so a look-alike name is not ours. */
function parseStamp(date: string, time: string): number | null {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(2, 4))
  const second = Number(time.slice(4, 6))
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(ms)
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return null
  }
  return ms
}

export function backupFileName(ms: number, owner: string): string {
  if (!isBackupId(owner)) throw new Error('backup: invalid owner id')
  return `backup-${stampOf(ms)}Z-${owner}.${DATA_TRANSFER_EXTENSION}`
}

export function partialFileName(ms: number, owner: string, nonce: string): string {
  if (!isBackupId(owner) || !isBackupId(nonce)) throw new Error('backup: invalid owner id or nonce')
  return `.backup-${stampOf(ms)}Z-${owner}-${nonce}.${DATA_TRANSFER_EXTENSION}.partial`
}

/** The time and owner of a finished generation's name. null if the name is not a generation (of any owner). */
export function parseGenerationName(name: string): { readonly at: number; readonly owner: string } | null {
  const match = FINAL_RE.exec(name)
  if (match === null) return null
  const at = parseStamp(match[1]!, match[2]!)
  return at === null ? null : { at, owner: match[3]! }
}

/** The time of a finished generation's name (of any owner). null if the name is not a generation. */
export function generationTime(name: string): number | null {
  return parseGenerationName(name)?.at ?? null
}

/** The time and owner of a leftover partial file's name. null if the name is not ours. */
export function parsePartialName(name: string): { readonly at: number; readonly owner: string } | null {
  const match = PARTIAL_RE.exec(name)
  if (match === null) return null
  const at = parseStamp(match[1]!, match[2]!)
  return at === null ? null : { at, owner: match[3]! }
}

export interface GenerationOrder {
  readonly now: number
  /** A stamp more than this far in the future counts as "from the future" (the clock went back) and is ordered last. */
  readonly futureMs: number
}

/** The generation is stamped beyond the future tolerance. */
export function isFutureStamp(at: number, order: GenerationOrder): boolean {
  return at - order.now > order.futureMs
}

/**
 * `owner`'s generations among the folder's names, newest first. Generations from the future (see the file comment) come after the
 * others, newest first among themselves.
 */
export function generationsOf(
  names: readonly string[],
  owner: string,
  order: GenerationOrder
): { readonly name: string; readonly at: number }[] {
  const found: { name: string; at: number; future: boolean }[] = []
  for (const name of names) {
    const parsed = parseGenerationName(name)
    if (parsed !== null && parsed.owner === owner) found.push({ name, at: parsed.at, future: isFutureStamp(parsed.at, order) })
  }
  return found
    .sort((a, b) => Number(a.future) - Number(b.future) || b.at - a.at || (a.name < b.name ? 1 : -1))
    .map(({ name, at }) => ({ name, at }))
}

/**
 * The generations to delete so that `keep` of `owner`'s remain, in the order of `generationsOf`. `justWritten` (the generation this run
 * wrote) is always kept, whatever its stamp.
 */
export function generationsToPrune(
  names: readonly string[],
  keep: number,
  owner: string,
  order: GenerationOrder,
  justWritten: string | null = null
): string[] {
  const ordered = generationsOf(names, owner, order).map((entry) => entry.name)
  const kept = new Set<string>()
  if (justWritten !== null && ordered.includes(justWritten) && keep > 0) kept.add(justWritten)
  for (const name of ordered) {
    if (kept.size >= Math.max(0, keep)) break
    kept.add(name)
  }
  return ordered.filter((name) => !kept.has(name))
}

/**
 * `owner`'s leftover partial files to delete (a crash or a stop midway). Only ones whose stamp is more than `graceMs` away from now
 * (in either direction: a clock that went back must not keep a leftover forever).
 */
export function partialsToSweep(names: readonly string[], owner: string, now: number, graceMs: number): string[] {
  return names.filter((name) => {
    const parsed = parsePartialName(name)
    return parsed !== null && parsed.owner === owner && Math.abs(now - parsed.at) > graceMs
  })
}
