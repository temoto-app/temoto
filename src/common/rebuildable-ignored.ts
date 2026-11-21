/**
 * The table of known rebuildable locations (TODO 748, owner decision (a1) 2026-10-12, ARCHITECTURE 4.4).
 *
 * When a conversation is deleted, the worktree cleanup (`src/main/git/worktree-cleanup.ts`) keeps the worktree
 * (`kept = 'ignored'`) **if even one git-ignored file** (something matching `.gitignore`) **does not match this table**.
 * `git worktree remove` deletes everything inside without looking at ignored files, and restore only recreates from the
 * HEAD at cleanup time, so `.env` and notes that were ignored do not come back. Only locations where "the same thing can be rebuilt by
 * installing dependencies, building or caching" go in the table - doubtful ones (`vendor/`, `.idea/` etc., which may be
 * edited by hand) are not listed (the choice leans toward keeping).
 *
 * It does not depend on electron (the `src/common/` convention).
 */

/** If any segment of a path is a directory with one of these names, what is under it can be rebuilt. */
export const REBUILDABLE_IGNORED_DIRS: ReadonlySet<string> = new Set([
  // JavaScript / TypeScript
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.vite',
  'coverage',
  '.nyc_output',
  // Python
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  // Rust / JVM / Swift / Dart
  'target',
  '.gradle',
  '.build',
  'DerivedData',
  '.dart_tool'
])

/** A file with one of these names can be rebuilt (things the OS puts there on its own). */
export const REBUILDABLE_IGNORED_FILES: ReadonlySet<string> = new Set(['.DS_Store'])

/**
 * Whether one git-ignored entry (a path relative to the worktree root, directories end in `/`) matches a rebuildable location
 * (pure function). A directory entry is checked at any segment; a file entry by its parent segment or file name.
 */
export function isRebuildableIgnoredPath(relative: string): boolean {
  const isDir = relative.endsWith('/')
  const parts = relative.split('/').filter((part) => part !== '')
  if (parts.length === 0) return false
  const dirParts = isDir ? parts : parts.slice(0, -1)
  if (dirParts.some((part) => REBUILDABLE_IGNORED_DIRS.has(part))) return true
  return !isDir && REBUILDABLE_IGNORED_FILES.has(parts[parts.length - 1] ?? '')
}
