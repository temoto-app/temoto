/**
 * Open links in the body as files (item 254, ARCHITECTURE.md 5.1 "file paths ... open in the
 * ViewerPane on click. A relative path is resolved against the thread's cwd").
 *
 * The renderer does **only the dispatch** (`linkAction`). Relative, scheme-less and `file:` links are passed to
 * main's `fs.resolveLink`; main builds candidates in the order cwd -> auto memory, checks them against the choke point
 * (`FsAccess.assertAllowed`, 12.7) and for existence, and returns a `file://` URI or a reason code.
 * The renderer decides nothing (main checks the relative base, the exclusion rules and existence).
 *
 * Pure functions that depend on neither the DOM nor Node (the renderer, plugins and main use the same logic).
 */
import { isOpenableExternally } from './open-external.js'
import { parseThreadLink } from './thread-link.js'

/** The input of `fs.resolveLink`. */
export interface LinkResolveInput {
  /** The raw `href` of the link (percent-encoded by markdown-it). */
  readonly href: string
  /** The thread used to look up the relative base and auto memory. null if none. */
  readonly threadId: string | null
  /**
   * The file used as the relative base (in the `aios.markdown` viewer: the open .md). If present, its folder
   * is the first candidate and takes priority over the thread's cwd. If null, the thread's cwd.
   */
  readonly baseUri: string | null
}

/**
 * The result. `reason` is a string of a reason code (`shared/reason.ts`), which the renderer turns into
 * text with `describeReason` (`link-not-found` / `path-excluded` / `invalid-value`, etc.).
 */
export type LinkResolution =
  | {
      readonly ok: true
      readonly uri: string
      /**
       * Line (1-based, item 273). Present only for the forms `foo.ts:42` / `foo.ts#L42` / `foo.ts:3:1`.
       * The renderer passes it to the ViewerPane as a one-shot instruction with `select(uri, { line, column })`
       * (it is not written to the memory (item 63), owner decision 2026-10-01).
       */
      readonly line?: number
      /** Column (1-based). Only for the forms `:3:1` / `#L3C1`. */
      readonly column?: number
      /**
       * It was a folder (TODO 586). The renderer opens the folder in Files mode, not in a viewer
       * (`revealFolderInFiles`). No line or column is attached.
       */
      readonly directory?: true
    }
  | LinkFailure

/** One candidate for a partial path (TODO 816). `line` / `column` mean the same as on success. */
export interface LinkChoice {
  readonly uri: string
  readonly line?: number
  readonly column?: number
}

/**
 * Could not be resolved (TODO 808 / 816). `reason` is as before. It may carry material for a next step.
 * The renderer turns `reason` into text, and if extras are attached it shows a list or buttons in the band (`LinkNotice`).
 */
export interface LinkFailure {
  readonly ok: false
  readonly reason: string
  /**
   * Paths that were checked and not found (absolute, in the order checked, capped at `MAX_LINK_TRIED`). The renderer may see paths (item 55).
   * Only for `link-not-found`.
   */
  readonly tried?: readonly string[]
  /** The term to put into "search by name" (the Sidebar's file name search) (the name of the link target). Only for `link-not-found`. */
  readonly searchName?: string
  /**
   * Multiple candidates (`link-ambiguous`, nearest to cwd first, capped at `MAX_LINK_CHOICES`). The renderer lets the user choose and opens the chosen URI
   * as is in the ViewerPane (for viewer reads, the Broker applies the choke point again).
   */
  readonly choices?: readonly LinkChoice[]
  /**
   * It exists but is in an excluded place (`link-excluded`, TODO 808). A URI that is allowed if only handed to an external editor / Finder
   * (main's `editor.open` / `editor.reveal` re-check it at the `'handoff'` choke point). `handoffDirectory` is for folders.
   */
  readonly handoffUri?: string
  readonly handoffDirectory?: true
  /**
   * A link to a deleted conversation (`thread-link-deleted`, TODO 1155). The band's "restore and open" restores it and then jumps to this message.
   * Only the renderer creates it (main's `fs.resolveLink` does not set it).
   */
  readonly restoreThread?: { readonly threadId: string; readonly eventId: string | null }
}

/** Upper bound of `LinkFailure.tried`. */
export const MAX_LINK_TRIED = 8
/** Upper bound of `LinkFailure.choices`. */
export const MAX_LINK_CHOICES = 20

/** Upper bound of `href` (characters). Matches the gateway's `openFile` path limit (`MAX_TOOL_PATH`). */
export const MAX_LINK_HREF = 4096

/** The line number tail (`foo.ts:42` / `foo.ts:42:7`). The first group is the line, the second (if any) is the column. */
export const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/

/** A GitHub-style line fragment (`#L42` / `#L42C7` / `#L42-L50`). The first group is the line, the second (if any) is the column. */
export const LINE_FRAGMENT = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/

/** Reads line / column digits as a safe integer of 1 or more (item 273). 0 and overflow give null. */
export function positiveLine(digits: string | undefined): number | null {
  if (digits === undefined) return null
  const value = Number(digits)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

/** A line position (item 273). Both are 1-based. `column` is null if absent. */
export interface LinePosition {
  readonly line: number
  readonly column: number | null
}

/** Builds a position from a `LINE_SUFFIX` / `LINE_FRAGMENT` match. null if the line cannot be read (if only the column is broken, the column is dropped). */
export function linePositionOf(match: RegExpExecArray | null): LinePosition | null {
  if (match === null) return null
  const line = positiveLine(match[1])
  if (line === null) return null
  return { line, column: positiveLine(match[2]) }
}

/**
 * Whether it starts with `scheme:`. But a "name + line number" such as `README.md:42` is not regarded as a scheme
 * (only digits after `:`, or further `:digits`).
 */
export function hasScheme(href: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(href)
  if (match === null) return false
  return !/^\d+(?::\d+)?(?:#.*)?$/.test(match[2] ?? '')
}

/**
 * How a clicked link is handled (dispatch for the renderer / viewer).
 *
 * - `external`: `http:` / `https:` / `mailto:` - ask main to "open externally" (5.1.1).
 * - `resolve`: `file:`, relative, scheme-less (`memory/x.md`, `src/a.ts:42`, `/abs/path`) -
 *   resolve with main's `fs.resolveLink` and open in the ViewerPane (item 254).
 * - `none`: empty, an in-page `#heading`, and other schemes (such as `thread:`) - do nothing.
 */
export function linkAction(href: string | null): 'external' | 'resolve' | 'none' {
  if (href === null) return 'none'
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.length > MAX_LINK_HREF) return 'none'
  if (isOpenableExternally(trimmed)) return 'external'
  if (/^file:/i.test(trimmed)) return 'resolve'
  if (hasScheme(trimmed)) return 'none'
  return 'resolve'
}

/**
 * Dispatch for links in the body of a plugin viewer (iframe) (TODO 1161). In addition to `linkAction`, `thread://<id>[/<id>]` is
 * 'thread': the viewer hands it to the host with `bridge.openLink`, and the host's `openLinkHref` picks it up with `parseThreadLink` and
 * asks main to confirm where it is (1155). A malformed `thread:` stays 'none'.
 */
export function viewerLinkAction(href: string | null): 'external' | 'resolve' | 'thread' | 'none' {
  if (href !== null && href.length <= MAX_LINK_HREF && parseThreadLink(href) !== null) return 'thread'
  return linkAction(href)
}
