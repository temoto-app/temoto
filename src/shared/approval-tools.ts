/**
 * Tools the approval box recognizes by name (TODO 1020). The names are neutral names given by aios, not the backend's words
 * (which backend thing is read as which name is held by each Adapter's compat table, constraint 6).
 */

/**
 * A confirmation before touching a path outside the working folder (something the backend asks separately from running a tool). The arguments are
 * `{ path, resources }` (`path` is the target directories joined with `, `).
 */
export const EXTERNAL_DIRECTORY_TOOL = 'ExternalDirectory'

/** The path to show, taken from the arguments of the confirmation for a path outside the working folder. Null if unreadable. */
export function externalDirectoryPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const path = (input as Record<string, unknown>)['path']
  return typeof path === 'string' && path.trim() !== '' ? path : null
}
