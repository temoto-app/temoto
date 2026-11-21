/**
 * Breakdown of the DB (the measurement stage of TODO 846 / 914 / 988, wave 61 bundle D).
 *
 * The index process (`aios-index`) measures, and main only relays (constraint 8.1). It runs once, only when "Count the breakdown" in the settings
 * "About" is pressed. A row whose `bytes` is null is a sign that `dbstat` was not available.
 */
export interface DbBreakdownEntry {
  readonly name: string
  /** Kind of table / index. Internal rows that are neither a table nor an index are `other`. */
  readonly kind: 'table' | 'index' | 'other'
  /** Null if there is no `dbstat`. */
  readonly bytes: number | null
  /** Tables only. Null for indexes and rows that could not be obtained. */
  readonly rows: number | null
}

export interface DbBreakdown {
  /** `page_count × page_size`. */
  readonly fileBytes: number
  readonly walBytes: number
  readonly pageSize: number
  readonly freelistPages: number
  /** An estimate of the bytes VACUUM would free (`freelist_count × page_size`). */
  readonly reclaimableBytes: number
  readonly dbstatAvailable: boolean
  /** The top entries, largest first. In name order when there is no `dbstat`. */
  readonly entries: readonly DbBreakdownEntry[]
  /** The total number of tables and indexes (entries has only the top ones). */
  readonly totalEntries: number
  readonly tookMs: number
}
