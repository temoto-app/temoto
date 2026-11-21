/**
 * The gate before turning a file dropped on the viewer into a Markdown link (TODO 366, wave 20 bundle E, ARCHITECTURE 7.4.8).
 *
 * It **re-validates from the type** a list of URIs from the renderer and passes each through `FsAccess.assertAllowed` (read, 12.7).
 * Anything under an exclusion, anything not `file:`, and relative paths are refused with a reason code. For those that pass, the URI is rebuilt from the logical path and returned
 * (the renderer's spelling is not returned as is). **It does not open or read the file** - all it needs is whether it is a folder.
 * Does not throw (the same shape as `fs.resolveLink`).
 */
import { statSync } from 'node:fs'
import { pathToUri } from '../../common/uri.js'
import { PathDenied, pathDenialReason, type PathAccess } from '../../common/fs-policy.js'
import { MAX_DROP_LINKS, type DropLinkCheck, type DropLinkDenial, type DropLinkTarget } from '@shared/drop-link.js'
import { formatReason } from '@shared/reason.js'

export interface DropLinkGate {
  assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string
}

export interface DropLinkDeps {
  readonly gate: DropLinkGate
  /** true if the path is a folder, false if a file, null if it does not exist. The default is `statSync` (follows symlinks). */
  readonly kindOf?: (path: string) => boolean | null
}

function statKind(path: string): boolean | null {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  // TODO 918: a FIFO, device or socket is not made into a link (opening it could block main in the viewer's read. The read entry point's
  // `openChecked` also refuses it, but the reason is returned here first).
  if (!stat.isDirectory() && !stat.isFile()) throw new PathDenied('not-regular')
  return stat.isDirectory()
}

/** The body of `drop.checkLinks`. If the shape is wrong, everything is refused with `invalid-value`. */
export function checkDropLinks(input: unknown, deps: DropLinkDeps): DropLinkCheck {
  if (!Array.isArray(input)) {
    return { allowed: [], denied: [{ uri: '', reason: formatReason('invalid-value', { field: 'uris' }) }] }
  }
  const kindOf = deps.kindOf ?? statKind
  const allowed: DropLinkTarget[] = []
  const denied: DropLinkDenial[] = []
  const seen = new Set<string>()
  for (const value of input.slice(0, MAX_DROP_LINKS)) {
    if (typeof value !== 'string' || value.length > 8192) {
      denied.push({ uri: '', reason: formatReason('invalid-value', { field: 'uri' }) })
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)
    let path: string
    let isDirectory: boolean
    try {
      // First pass it "as a file". Some exclusion rules apply only to folders (such as `node_modules/`),
      // so once it is known to be a folder, pass it again as a folder.
      path = deps.gate.assertAllowed(value, false, 'read')
      const kind = kindOf(path)
      if (kind === null) {
        denied.push({ uri: value, reason: 'path-not-found' })
        continue
      }
      isDirectory = kind
      if (isDirectory) deps.gate.assertAllowed(value, true, 'read')
    } catch (err) {
      denied.push({ uri: value, reason: pathDenialReason(err) })
      continue
    }
    allowed.push({ uri: pathToUri(path), isDirectory })
  }
  return { allowed, denied }
}
