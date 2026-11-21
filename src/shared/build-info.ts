/**
 * The app version and the identity of the build (TODO 316, wave 17 bundle A, ARCHITECTURE.md 5.6 / 5.8).
 *
 * Following the VS Code split: **the version (`version`) is a number a person assigns** (`package.json`, the minor is raised each wave),
 * and **the identity of the build is `commit` + `date`**; the time is not mixed into the version string. The values are embedded into main at build time by
 * electron-vite's `define` (`__AIOS_BUILD__`) (`src/common/build-stamp.ts`),
 * and main passes them to the renderer as `AppInfo.build`.
 *
 * This file has only pure functions for display formats (shared by main's About panel and the renderer's settings screen and BottomBar).
 * Words that depend on language ("n minutes ago") are not returned; only the number and unit of `RelativeAge` are returned, and the caller turns them into a sentence with its dictionary.
 */

/** Values filled in at build time. */
export interface BuildInfo {
  /** The `version` of `package.json`. */
  readonly version: string
  /** The 40 digits of `git rev-parse HEAD`. `unknown` if there is no git or it is outside a repository. */
  readonly commit: string
  /** Whether tracked files had uncommitted changes (`git status --porcelain --untracked-files=no`). */
  readonly dirty: boolean
  /**
   * The date of the HEAD commit (committer date, ISO 8601, with time zone). Not the time of the build (TODO 1010).
   * Empty if there is no git or it is outside a repository. Also HEAD's when dirty.
   */
  readonly date: string
}

/** Versions of the runtime foundation (the same order as VS Code's About). main builds it from `process.versions` and `os`. */
export interface RuntimeInfo {
  readonly electron: string
  readonly chromium: string
  readonly node: string
  readonly v8: string
  /** `os.type() os.arch() os.release()` (for example `Darwin arm64 25.6.0`, the same form as VS Code). */
  readonly os: string
}

/** The value when the commit could not be obtained. */
export const UNKNOWN_COMMIT = 'unknown'

/** The short form of the commit (7 digits). `unknown` is returned as is. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,}$/i.test(commit) ? commit.slice(0, 7) : commit
}

/** The short commit shown on the badge and in About. Empty if there is no commit (`unknown`; the distributed build does not embed the build source's hash, TODO 1190). */
export function commitLabel(build: BuildInfo): string {
  if (build.commit === UNKNOWN_COMMIT) return ''
  return `${shortCommit(build.commit)}${build.dirty ? DIRTY_MARK : ''}`
}

/** The dirty mark. Used in the BottomBar's short form and the About panel (the settings screen adds it as a word). */
export const DIRTY_MARK = '*'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Reads an ISO date-time. Null if unreadable. */
function parseDate(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** English month abbreviations (built by hand without `Intl`, TODO 457: to avoid the whitespace character changing with the ICU version). */
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/**
 * The English-style format `Oct 4, 10:27 PM` in local time (for the BottomBar, TODO 457). The badge is a build identifier, so
 * **it is fixed to this format regardless of the display language (EN / JA)** (even in JA it does not become the Japanese month-day form). The year is not shown
 * (the exact date and time are in `formatLocalDate` of About / settings "About"). An unreadable value is returned as is.
 */
export function formatShortDate(iso: string): string {
  const date = parseDate(iso)
  if (date === null) return iso
  const month = SHORT_MONTHS[date.getMonth()]
  const day = date.getDate()
  const hours24 = date.getHours()
  const minutes = pad2(date.getMinutes())
  const period = hours24 < 12 ? 'AM' : 'PM'
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  return `${month} ${day}, ${hours12}:${minutes} ${period}`
}

/** `YYYY-MM-DD HH:mm` in local time (for the About panel). An unreadable value is returned as is. */
export function formatLocalDate(iso: string): string {
  const date = parseDate(iso)
  if (date === null) return iso
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * The short form in the corner of the BottomBar: `0.23.0 · 514bcd9 · Oct 4, 10:27 PM`. If dirty, `*` after the commit.
 */
export function formatBuildBadge(build: BuildInfo): string {
  const date = build.date === '' ? '' : formatShortDate(build.date)
  return [build.version, commitLabel(build), date].filter((part) => part !== '').join(' · ')
}

/** The number and unit of "n minutes ago". Under 1 minute is `now`, and a future time (clock skew) is also rounded to `now`. */
export type RelativeAge =
  | { readonly unit: 'now' }
  | { readonly unit: 'minute' | 'hour' | 'day'; readonly count: number }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Elapsed time from the build time to `nowMs`. Null for an unreadable date-time. */
export function relativeAge(iso: string, nowMs: number): RelativeAge | null {
  const date = parseDate(iso)
  if (date === null) return null
  const elapsed = nowMs - date.getTime()
  if (elapsed < MINUTE_MS) return { unit: 'now' }
  if (elapsed < HOUR_MS) return { unit: 'minute', count: Math.floor(elapsed / MINUTE_MS) }
  if (elapsed < DAY_MS) return { unit: 'hour', count: Math.floor(elapsed / HOUR_MS) }
  return { unit: 'day', count: Math.floor(elapsed / DAY_MS) }
}

/**
 * The string put on the clipboard by "Copy" (the same form as VS Code's About "Copy", for pasting into an issue).
 * The headings are fixed in English regardless of the display language, and the relative time is not included (it would go stale where it is pasted).
 */
export function formatBuildCopyText(build: BuildInfo, runtime: RuntimeInfo): string {
  return [
    `Version: ${build.version}`,
    `Commit: ${build.commit}${build.dirty ? ' (dirty)' : ''}`,
    // For a distributed build (commit is unknown) the date is the build time (TODO 1190). Do not call it the commit date.
    `${build.commit === UNKNOWN_COMMIT ? 'Build date' : 'Commit date'}: ${build.date}`,
    `Electron: ${runtime.electron}`,
    `Chromium: ${runtime.chromium}`,
    `Node.js: ${runtime.node}`,
    `V8: ${runtime.v8}`,
    `OS: ${runtime.os}`
  ].join('\n')
}

/**
 * Values passed to the macOS About panel (`app.setAboutPanelOptions`). It shows the running build's values, not the version in Info.plist (the
 * `pkg.version` at the time the `.app` was made). `version` is shown in parentheses after the version in About.
 */
export function aboutPanelValues(
  build: BuildInfo,
  runtime: RuntimeInfo
): { readonly applicationVersion: string; readonly version: string; readonly credits: string } {
  return {
    applicationVersion: build.version,
    version: [commitLabel(build), build.date === '' ? '' : formatLocalDate(build.date)]
      .filter((part) => part !== '')
      .join(' · '),
    credits: formatBuildCopyText(build, runtime)
  }
}
