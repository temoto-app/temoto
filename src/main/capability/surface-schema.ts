/**
 * Validation of requests for the "surfaces" a plugin shows (the sidebar list, sync progress) (TODO 1039 / 1038, ARCHITECTURE.md 7.5).
 * The policy is the same as `request-schema.ts`: unknown keys are rejected, wrong types are rejected, nothing is filled in by guessing.
 * Whether a row URI's scheme belongs to the plugin's viewer is checked by the side that holds state (`PluginSurfaces`).
 */
import { z } from 'zod'
import {
  MAX_SIDEBAR_DEPTH,
  MAX_SIDEBAR_ROWS,
  PLUGIN_SYNC_STATES,
  type PluginSidebarRow,
  type PluginSyncState
} from '@shared/plugin-surfaces.js'

const ROW_ID = z.string().min(1).max(256)
const LABEL = z.string().max(512)

const ROW: z.ZodType<PluginSidebarRow> = z.lazy(() =>
  z
    .object({
      id: ROW_ID,
      label: LABEL,
      description: z.string().max(512).optional(),
      badge: z.number().int().min(0).max(1_000_000_000).optional(),
      uri: z.string().min(1).max(2048).optional(),
      children: z.array(ROW).max(MAX_SIDEBAR_ROWS).optional()
    })
    .strict()
)

/** Checks the number of rows (all levels), the depth, and duplicate ids. true if they pass. */
export function sidebarRowsWithinLimits(rows: readonly PluginSidebarRow[]): boolean {
  const ids = new Set<string>()
  let count = 0
  const walk = (list: readonly PluginSidebarRow[], depth: number): boolean => {
    if (depth > MAX_SIDEBAR_DEPTH) return false
    for (const row of list) {
      count += 1
      if (count > MAX_SIDEBAR_ROWS || ids.has(row.id)) return false
      ids.add(row.id)
      if (row.children !== undefined && !walk(row.children, depth + 1)) return false
    }
    return true
  }
  return walk(rows, 1)
}

export const UI_SIDEBAR_ROWS = z
  .object({
    capability: z.literal('ui'),
    op: z.literal('setSidebarRows'),
    rows: z.array(ROW).max(MAX_SIDEBAR_ROWS).refine(sidebarRowsWithinLimits, 'too many rows, too deep or duplicate ids')
  })
  .strict()

const COUNT = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const UI_STATUS = z
  .object({
    capability: z.literal('ui'),
    op: z.literal('reportStatus'),
    done: COUNT,
    total: COUNT.nullable(),
    state: z.enum(PLUGIN_SYNC_STATES as readonly [PluginSyncState, ...PluginSyncState[]])
  })
  .strict()
