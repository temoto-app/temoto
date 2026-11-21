/**
 * Assignment and persistence of rainbow colors for working directories (item 108, ARCHITECTURE.md 4.3 "color of the
 * working directory"). `ThreadStore` holds one (see the comment in that file for why it lives there).
 *
 * - The table is in `app_settings` (`RAINBOW_TABLE`). Owner is main. The pure function `assignRainbow`
 *   (`src/common/rainbow.ts`) decides "which number to hand out next"; this code calls it
 *   once per cwd, remembers the result, and persists only when it changes.
 * - **Unaffiliated, empty and old rows (`cwdName === ''`) have no color and are not written to the table.** The scratch area is a
 *   different path for every thread, so writing them would grow the table without bound (same reason as item 58).
 * - **There is no dedicated code for coloring existing rows.** `ThreadStore.listThreads()` /
 *   `listThreadRecords()` read all rows in descending `threadRecency` order at startup and call
 *   `indexFor` for each row (`toThread`). On the first launch (empty table) this is exactly the spec "fill
 *   the table in display order"; from the second launch on, it only reads the cwds already in the table and writes nothing.
 */
import { resolve } from 'node:path'
import { assignRainbow } from '../../common/rainbow.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { RAINBOW_TABLE } from '../../common/settings-keys.js'
import { foldPath } from '../../common/uri.js'

export class RainbowRegistry {
  private table: Record<string, number>

  constructor(private readonly settings: AppSettingsStore) {
    this.table = { ...settings.readTyped(RAINBOW_TABLE) }
  }

  /**
   * The color number for a cwd (raw path). **Always null when `cwdName` is the empty string (scratch area, or an old row with no cwd,
   * the same test as `threadCwdName`)**, and the table is not touched.
   */
  indexFor(cwd: string, cwdName: string): number | null {
    if (cwdName === '') return null
    const key = foldPath(resolve(cwd))
    const existing = this.table[key]
    if (existing !== undefined) return existing
    const assigned = assignRainbow(this.table, key)
    this.table = { ...this.table, [key]: assigned }
    this.settings.writeTyped(RAINBOW_TABLE, this.table)
    return assigned
  }
}
