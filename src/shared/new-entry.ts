/**
 * Types and name validation used by both main and the renderer for creating a "new file / folder" from the Files tree
 * (TODO 370, wave 20 bundle C).
 *
 * - **The canonical name validation is in main** (`src/main/fs/create.ts`). The renderer calls the same function
 *   on every keystroke in the inline input and tells the user with a red bubble before creating (as in VS Code's explorer). Main
 *   does not trust the renderer's result: it validates again with the same function, then goes through realpath, the choke point (`assertAllowed`) and
 *   `O_CREAT | O_EXCL | O_NOFOLLOW`.
 * - Including `/`, as in `a/b/c.txt`, also creates the intermediate folders (as in VS Code). The only separator is `/`.
 * - Pure functions that depend on neither node nor the DOM (the convention of `shared/`).
 */
import type { ReasonCode, ReasonParams } from './reason.js'

export type NewEntryKind = 'file' | 'folder'

/**
 * The result of `fs.createFile` / `fs.createFolder`. **Main does not throw**: when it refuses, `reason` holds
 * a bare code from `shared/reason.ts` (the same shape as `DirectoryListing.reason`) and `params` to embed in the sentence.
 */
export interface CreateEntryResult {
  /** The URI of what was created (file / folder). null if refused. */
  readonly uri: string | null
  readonly reason: string | null
  readonly params?: ReasonParams
}

/**
 * The result of `fs.rename` (TODO 1145). **Main does not throw**: when it refuses, `reason` holds a reason code and `params`.
 * If it was renamed (or the name was the same), `uri` is the new URI.
 */
export interface RenameEntryResult {
  readonly uri: string | null
  readonly reason: string | null
  readonly params?: ReasonParams
}

/** Upper limit in bytes of one name (between separators). The same as `NAME_MAX` of APFS / HFS+ / ext4. */
export const NAME_MAX_BYTES = 255

export type NewEntryNameCheck =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly code: ReasonCode; readonly params?: ReasonParams }

/** Control characters (including NUL). A name containing one is refused. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Turns the string in the input into a sequence of names from the parent folder.
 *
 * - Leading and trailing whitespace is dropped (VS Code does not make it part of the name either). If empty, `create-name-empty`.
 * - A leading `/` (absolute path) gives `create-name-absolute`. `~` is not expanded either (it is just a name).
 * - Control characters (including NUL) give `create-name-invalid-char` (`params.char` is in the form `U+0000`).
 * - An empty segment (`a//b`), `.` and `..` give `create-name-segment` (so there is no way out of the parent).
 *   Only for folders, a trailing `/` is allowed (`foo/` = `foo`). A trailing `/` on a file is an empty segment.
 * - If one name exceeds 255 bytes, `create-name-too-long`.
 */
export function checkNewEntryName(raw: string, kind: NewEntryKind): NewEntryNameCheck {
  let name = raw.trim()
  if (name === '') return { ok: false, code: 'create-name-empty' }
  if (name.startsWith('/')) return { ok: false, code: 'create-name-absolute' }
  const control = CONTROL_CHAR.exec(name)
  if (control !== null) {
    const point = control[0].codePointAt(0) ?? 0
    return {
      ok: false,
      code: 'create-name-invalid-char',
      params: { char: `U+${point.toString(16).toUpperCase().padStart(4, '0')}` }
    }
  }
  if (kind === 'folder') name = name.replace(/\/+$/, '')
  const segments = name.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, code: 'create-name-segment' }
    }
    if (utf8Length(segment) > NAME_MAX_BYTES) {
      return { ok: false, code: 'create-name-too-long', params: { max: NAME_MAX_BYTES } }
    }
  }
  return { ok: true, segments }
}

export type RenameNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly code: ReasonCode; readonly params?: ReasonParams }

/**
 * Validates the new name for a rename (TODO 1145). It is **only within the same parent folder**, so `/` is refused (moving is separate).
 * Empty, control characters, `.` / `..` and too-long names give the same reason codes as `checkNewEntryName`. Leading and trailing whitespace is dropped.
 */
export function checkRenameName(raw: string): RenameNameCheck {
  const trimmed = raw.trim()
  if (trimmed.includes('/')) return { ok: false, code: 'rename-name-slash' }
  const checked = checkNewEntryName(trimmed, 'file')
  if (!checked.ok) return checked.params === undefined ? { ok: false, code: checked.code } : { ok: false, code: checked.code, params: checked.params }
  return { ok: true, name: checked.segments[0] as string }
}
