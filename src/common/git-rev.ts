/**
 * The rule for strings that may be passed as a git rev (TODO 826, TODO 828).
 *
 * main (`src/main/git/show.ts`) and the gateway (`src/gateway/viewer-schemas.ts`) import this same single definition.
 * Hand-written copies would drift when only one is fixed. It depends on neither electron nor Node.
 *
 * `:` is not allowed, so a `rev:path` form cannot be built from outside, and a rev cannot start with `-`, so it cannot turn into a flag.
 */

/** Upper bound on a rev (characters). */
export const MAX_GIT_REV = 200

/** The character rule for a rev (length is checked separately with `MAX_GIT_REV`). */
export const GIT_REV_PATTERN = /^(?!-)[A-Za-z0-9_./~^@{}+-]+$/

/** Whether the string may be passed as a git rev (pure function). */
export function isGitRev(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GIT_REV && GIT_REV_PATTERN.test(value)
}
