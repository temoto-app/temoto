/**
 * Message types between main <-> the index process (`aios-index`) (P1, ARCHITECTURE.md chapter 3).
 *
 * **The renderer does not import this file.** It lives in `shared/` only because of
 * the convention (Conventions) that "types crossing a process boundary go in `shared/`";
 * the recipients are main and the index process, two of them.
 *
 * There are only three shapes:
 *
 * ```
 * req  main -> kernel / kernel -> main   a request with an id
 * res  its response (either ok or error)
 * ntf  a notification that does not wait for a response (scan progress, diffs, index progress, rule updates)
 * ```
 *
 * `id` is **independent per direction**, and each side remembers only the requests it issued.
 * If the other side dies, all unanswered requests are rejected together (`RpcPeer.rejectAll`).
 */

/** Notifications that do not wait for a response. */
export type IndexRpcNotifyEvent =
  /** Scan progress (`ScanStatus`). main pushes it to the renderer as is. */
  | 'scanStatus'
  /** Watch diffs (`FileChangeBatch`). */
  | 'fileChanges'
  /** Index build progress (`IndexStatus`). */
  | 'indexStatus'
  /**
   * The material for the exclusion rules changed (`IndexRulesPayload`). Emitted when the check of allowed volumes
   * finishes / when settings change. main's `FsAccess` rebuilds the rules with the same pure function,
   * so the rules themselves need not be sent (4.4.2 / 3.5).
   */
  | 'rules'
  /** The index process is ready / has finished stopping. */
  | 'ready'
  | 'stopped'

export interface IndexRpcRequest {
  readonly kind: 'req'
  readonly id: number
  readonly method: string
  readonly params: unknown
}

export type IndexRpcResponse =
  | { readonly kind: 'res'; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly kind: 'res'
      readonly id: number
      readonly ok: false
      readonly error: { readonly name: string; readonly message: string }
    }

export interface IndexRpcNotify {
  readonly kind: 'ntf'
  readonly event: IndexRpcNotifyEvent
  readonly payload: unknown
}

export type IndexRpcMessage = IndexRpcRequest | IndexRpcResponse | IndexRpcNotify

/**
 * The arguments of `open` (3.3). **The key is not put in argv / env; it is passed in this message after the fork**
 * (so it does not show in `ps`). If `file` is null it is degraded (memory-only): the index process
 * uses its own `:memory:` and rebuilds the index on every launch.
 */
export interface IndexOpenParams {
  readonly file: string | null
  readonly key: string | null
  /** The version main finished migrating to. If it differs, the index process does not open. */
  readonly userVersion: number
  readonly home: string
  /** Explicit scan roots (for tests). If null, the whole PC. */
  readonly roots: readonly string[] | null
  /** Helper for extracting PDF bodies (TODO 1009, `out/pdf-helper/pdf-helper`). If missing or not a Mac, PDFs have no body. */
  readonly pdfHelperPath?: string | null
  /** Helper for image classification labels (TODO 998, `out/vision-helper/vision-helper`). If missing or not a Mac, images have only the file name. */
  readonly visionHelperPath?: string | null
}

/**
 * The arguments of `power` (6.2.2 / TODO 434). main sends it from `powerMonitor` every 5 seconds.
 * The index process decides its speed level from this: idle for 300 seconds or more is full speed, active use is slow,
 * and if the thermal state is `serious` or worse or Low Power Mode is on, it waits. `onBattery` stopped affecting the level in 434.
 */
export interface IndexPowerReport {
  readonly idleSeconds: number
  readonly onBattery: boolean
  /** `powerMonitor.getCurrentThermalState()` (macOS only. `unknown` elsewhere). */
  readonly thermalState: ThermalState
  /** macOS Low Power Mode (`lowpowermode` of `pmset -g`). False if it cannot be obtained. */
  readonly lowPower: boolean
}

/** The value of `powerMonitor.getCurrentThermalState()`. */
export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

/** An unknown value (a version without it, another OS, a malformed RPC shape) is `unknown` (= do not stop). */
export function asThermalState(value: unknown): ThermalState {
  return value === 'nominal' || value === 'fair' || value === 'serious' || value === 'critical'
    ? value
    : 'unknown'
}

/** The contents of `ntf rules`. main builds the same exclusion rules from this and `home`. */
export interface IndexRulesPayload {
  readonly allowedVolumes: readonly string[]
  readonly volumesDir: string
}

/** The reason handed to unanswered requests when the index process dies. */
export const INDEX_PROCESS_CRASHED = 'IndexProcessCrashed'

/**
 * The index process is alive but did not respond within the time limit (item 87).
 * The message is in the form of the reason code `index-busy` (`shared/reason.ts`), and the renderer shows
 * "the index is busy" with `describeReason`.
 */
export const INDEX_PROCESS_BUSY = 'IndexProcessBusy'

/**
 * The reason `fs.scanSubtree` was refused (item 246, ARCHITECTURE.md 6.2.2 "subtree scan at thread creation").
 *
 * - `outside`: neither under home nor under an allowed volume (outside the index, or the job of the periodic scan only)
 * - `root`: the scan root itself (home and so on). Not a subtree; the periodic scan's job
 * - `excluded`: hits the exclusion rules (`classify`). Includes cases where any ancestor (such as `node_modules`) hits,
 *   and where the target of a symlink hits an exclusion
 * - `missing`: does not exist, or is not a directory
 * - `stopped`: the index process has started shutting down
 * - `failed`: threw in the middle of the scan (`fs.scan.subtree.failed` in the index process's log)
 */
export type SubtreeScanSkipReason = 'outside' | 'root' | 'excluded' | 'missing' | 'stopped' | 'failed'

/**
 * The result of `fs.scanSubtree` (item 246). `truncated` is a sign that it was cut off at the count or time limit, and
 * the rest is picked up by the next periodic scan (the directory rows of a cut-off tree get their mtime reset to 0, so they are not pruned).
 */
export type SubtreeScanResult =
  | {
      readonly state: 'done' | 'truncated'
      /** The number of entries recorded as rows (including rows of pruned directories). */
      readonly seen: number
      /** The number of rows written (new / changed). */
      readonly written: number
      /** The number of directories not opened because the mtime was the same as last time. */
      readonly pruned: number
      /** The number of rows removed by the range-limited cleanup (0 when cut off, since no cleanup is done then). */
      readonly removed: number
      readonly ms: number
    }
  | { readonly state: 'skipped'; readonly reason: SubtreeScanSkipReason }
