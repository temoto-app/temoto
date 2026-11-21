/**
 * Ancestor computation for "open the tree down to this URI" (item 49, ARCHITECTURE.md 5.3).
 *
 * The renderer has no paths and sees only URIs (IMPLEMENTATION_BRIEF chapter 7), so
 * this too is a pure function that handles only URI strings, depending on neither `node:path` nor `window`.
 * The actual expansion (the `listDirectory` round trips) is done by `reveal` in `store.ts`.
 */

/** Drop the trailing slash. Only the root `file:///` is left as is. */
function trimSlash(uri: string): string {
  return uri.length > 'file:///'.length && uri.endsWith('/') ? uri.slice(0, -1) : uri
}

/** If it is under `root` (including root itself), the remaining sequence of segments seen from root. null otherwise. */
function relativeSegments(root: string, uri: string): readonly string[] | null {
  if (uri === root) return []
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!uri.startsWith(prefix)) return null
  return uri.slice(prefix.length).split('/')
}

/**
 * The sequence of URIs leading to a `uri` that is under one of `roots` (from the root to `uri` itself,
 * top to bottom). null if it is not under any root.
 *
 * - **Pick the longest-matching root.** roots are not necessarily just the one home (`/` and `~`, allowed
 *   volumes, T4 / T20), and a `~/git/x` that is under both `/` and `~` opens in the `~` tree
 *   (going down `Users/alice/...` in the `/` tree would give a different row).
 * - A trailing slash is ignored (the scratch cwd can come in the form `.../<id>/`).
 * - It is a string prefix match, so `..` and `%2F` are not interpreted. It is assumed that the URI is a canonical form built by main
 *   with `pathToUri` (the renderer does not build one itself).
 */
export function revealChain(roots: readonly string[], uri: string): readonly string[] | null {
  const target = trimSlash(uri)
  let best: { root: string; segments: readonly string[] } | null = null
  for (const raw of roots) {
    const root = trimSlash(raw)
    const segments = relativeSegments(root, target)
    if (segments === null) continue
    if (best === null || root.length > best.root.length) best = { root, segments }
  }
  if (best === null) return null
  const chain = [best.root]
  let current = best.root
  for (const segment of best.segments) {
    if (segment === '') return null // Broken URIs such as `a//b` are not handled.
    current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`
    chain.push(current)
  }
  return chain
}
