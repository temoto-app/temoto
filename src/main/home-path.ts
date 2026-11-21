import { join } from 'node:path'

/** Expand `~` / `~/…` with the home. Anything else is returned as is. Both the adapter and `session/sandbox-home.ts` use this (no copies). */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}
