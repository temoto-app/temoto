/**
 * The icon of a `.app` row in the Files tree (TODO 562).
 *
 * It is obtained with electron's `app.getFileIcon` (on macOS `NSWorkspace iconForFile`). This file does not
 * import electron and receives the way of obtaining it (`load`) from outside, so `test/app-icon.test.ts` can run on plain Node.
 *
 * - **The URI from the renderer is re-validated**: the `.app` name, the gate (`assertAllowed`, read), and a directory that really exists by `lstat`
 *   (symlinks are not followed). If any fails, null. **Does not throw** (a reject from ipcMain.handle always appears in
 *   main's log - the same judgment as item 149).
 * - **Cached by path + mtime.** Updating an app changes the bundle's mtime, so it is fetched again.
 *   However many times the same row is drawn (scrolling the virtual list), it is fetched once. A second request while one is being fetched
 *   returns the same Promise. Beyond the limit `MAX_ENTRIES`, the oldest are dropped.
 */
import { lstatSync } from 'node:fs'
import { basename } from 'node:path'
import { isAppBundleName } from '@shared/app-bundle.js'
import { log, errorFields } from '../../common/logger.js'
import type { PathAccess } from '../../common/fs-policy.js'

/** How many icons to remember. Enough to hold all of them even if hundreds line up in `/Applications`. */
export const MAX_APP_ICONS = 512

/** How to obtain an icon. A PNG data URL, or null if it cannot be obtained. */
export type AppIconLoader = (path: string) => Promise<string | null>

interface Cached {
  readonly mtimeMs: number
  readonly icon: Promise<string | null>
}

export class AppIconCache {
  private readonly entries = new Map<string, Cached>()

  constructor(
    private readonly fs: { assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string },
    private readonly load: AppIconLoader,
    private readonly max: number = MAX_APP_ICONS
  ) {}

  /** The entry point that receives a value from the renderer (`unknown`). **Does not throw**. */
  async iconFor(uri: unknown): Promise<string | null> {
    if (typeof uri !== 'string') return null
    let path: string
    try {
      path = this.fs.assertAllowed(uri, true, 'read')
    } catch {
      return null
    }
    if (!isAppBundleName(basename(path))) return null
    let mtimeMs: number
    try {
      const stats = lstatSync(path)
      if (!stats.isDirectory()) return null
      mtimeMs = stats.mtimeMs
    } catch {
      return null
    }
    const cached = this.entries.get(path)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      // Reorder by use (a Map keeps insertion order, so deleting and reinserting moves it to the end = the newest side).
      this.entries.delete(path)
      this.entries.set(path, cached)
      return cached.icon
    }
    const icon = this.load(path).catch((err: unknown) => {
      log.warn('fs.appIcon.failed', { path, ...errorFields(err) })
      return null
    })
    this.entries.delete(path)
    this.entries.set(path, { mtimeMs, icon })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return icon
  }

  /** For tests: the number currently remembered. */
  get size(): number {
    return this.entries.size
  }
}
