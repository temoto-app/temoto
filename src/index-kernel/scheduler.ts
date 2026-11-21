/**
 * The periodic run of scans (ARCHITECTURE.md 6.2.2 "periodic run while resident", TODO 11 / T9).
 *
 * T3 decides whether a scan is needed **only at launch**, so if the app stays up for days, the area outside the home directory,
 * which has no watch, stays stale. This holds only "when to call the decision" and "whether it may run",
 * and leaves the need itself to `shouldFullScan` / `planScan` (pure functions).
 *
 * **It does not depend on electron.** The idle seconds and the thermal state / Low Power Mode are injected as functions, and
 * on a real machine `src/main/index.ts` sends the `powerMonitor` values via `power`. Tests pass a fake clock and
 * a fake idle value and call `tick()` directly (`test/scan-schedule.test.ts`).
 *
 * What must be kept:
 * - **Revised in TODO 434 (2026-10-04).** Before (up to P4) it was "start only when idle, interrupt when the user's operation resumes, and
 *   never run on battery" (because the cleanup after a scan once held the main thread for 100 seconds).
 *   With P1 the scan moved to the index process, so now it **starts even while in use or on battery, and walks
 *   at the pacing stage (`pace.ts`)**: full speed when idle, slow while in use (N% of one core).
 * - **When the thermal state is `serious` or above / Low Power Mode, it does not start, and a running one is interrupted.** The interruption is
 *   recorded as `aborted` and does not count as complete, so it runs again once the heat subsides.
 */
import type { ScanDecision } from './schedule.js'
import {
  SlowPacer,
  decidePace,
  holdReason,
  type HoldReason,
  type Pace,
  type ThermalState
} from './pace.js'

/** Interval at which the decision is called. Not the interval of the scan itself. */
export const DEFAULT_TICK_MS = 60_000
/** With no operation for this long, it is "idle". */
export const DEFAULT_IDLE_SECONDS = 300

export type AutoScanVerdict =
  /** Run (speed is full when idle, slow while in use: TODO 434). */
  | 'run'
  /** Not due yet. */
  | 'not-due'
  /** Already scanning (or shutting down). */
  | 'busy'
  /** The thermal state is `serious` or above (TODO 434). */
  | 'thermal'
  /** Low Power Mode (TODO 434). */
  | 'low-power'

export interface AutoScanInput {
  /** Does `shouldFullScan` say "run"? */
  readonly due: boolean
  readonly scanning: boolean
  readonly thermalState: ThermalState
  readonly lowPower: boolean
}

/**
 * Whether the periodic run may go (a pure function). The reason is returned so it can appear in the log and the state.
 * **It does not look at whether the user is operating or at the kind of power** (TODO 434): that is a matter of the walking speed (`decidePace`).
 */
export function decideAutoScan(input: AutoScanInput): AutoScanVerdict {
  if (input.scanning) return 'busy'
  if (!input.due) return 'not-due'
  return holdReason(input.thermalState, input.lowPower) ?? 'run'
}

/** Whether to interrupt a running automatic scan (heat / Low Power Mode, TODO 434). */
export function shouldAbortAutoScan(thermalState: ThermalState, lowPower: boolean): boolean {
  return holdReason(thermalState, lowPower) !== null
}

export interface AutoScanHost {
  /** The current need. FsService gathers the inputs and passes them to the pure function. */
  decide(now: number): ScanDecision
  /** Is a scan running (automatic or manual)? */
  isScanning(): boolean
  /** Starts an automatic scan (does not wait). */
  startAutoScan(): void
  /** Interrupts a running automatic scan. A manual scan is not interrupted. */
  abortAutoScan(reason: string): void
}

export interface ScanSchedulerOptions {
  readonly enabled?: boolean
  readonly now?: () => number
  /** Seconds since the last operation (`powerMonitor.getSystemIdleTime()`). */
  readonly idleSeconds?: () => number
  /** The thermal state (`powerMonitor.getCurrentThermalState()`, TODO 434). */
  readonly thermalState?: () => ThermalState
  /** Is Low Power Mode on? (TODO 434) */
  readonly lowPower?: () => boolean
  readonly tickMs?: number
  /** The idle threshold for walking at full speed (TODO 434. Below this it is slow). */
  readonly idleThresholdSeconds?: number
  /** How to walk at the slow stage (TODO 434). The kernel shares one with the build. Used by `FsIndexer`. */
  readonly pacer?: SlowPacer
  /** For tests: one's own timer. Calling the return value stops it. */
  readonly schedule?: (fn: () => void, ms: number) => () => void
  readonly onVerdict?: (verdict: AutoScanVerdict) => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  // Make sure the scan's wait does not keep the app from quitting.
  timer.unref?.()
  return () => clearInterval(timer)
}

export class ScanScheduler {
  private readonly enabled: boolean
  private readonly now: () => number
  /** null if not injected: the pacing stage is always full speed (only heat / Low Power are looked at). */
  private readonly idleSeconds: (() => number) | null
  private readonly thermalState: () => ThermalState
  private readonly lowPower: () => boolean
  private readonly tickMs: number
  private readonly idleThresholdSeconds: number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly onVerdict: ((verdict: AutoScanVerdict) => void) | null
  /** The clock and rest used when the automatic scan walks at the slow stage (TODO 434). */
  readonly pacer: SlowPacer
  private cancel: (() => void) | null = null
  private stopped = false
  /** Whether a scan this scheduler started is running. A manual rescan is not interrupted. */
  private running = false

  constructor(
    private readonly host: AutoScanHost,
    options: ScanSchedulerOptions = {}
  ) {
    this.enabled = options.enabled ?? false
    this.now = options.now ?? Date.now
    this.idleSeconds = options.idleSeconds ?? null
    this.thermalState = options.thermalState ?? ((): ThermalState => 'unknown')
    this.lowPower = options.lowPower ?? ((): boolean => false)
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.idleThresholdSeconds = options.idleThresholdSeconds ?? DEFAULT_IDLE_SECONDS
    this.schedule = options.schedule ?? defaultSchedule
    this.onVerdict = options.onVerdict ?? null
    this.pacer = options.pacer ?? new SlowPacer()
  }

  /** Starts the periodic decision. Does nothing when disabled (the default). */
  start(): void {
    if (!this.enabled || this.stopped || this.cancel !== null) return
    this.cancel = this.schedule(() => this.tick(), this.tickMs)
  }

  /** Shutdown. It never starts again. */
  stop(): void {
    this.stopped = true
    this.running = false
    this.cancel?.()
    this.cancel = null
  }

  /**
   * The current pacing stage (TODO 434). The scan looks at this on every step: if `slow` it rests, if `hold` it stops.
   */
  pace(): Pace {
    return decidePace({
      // A configuration without injected idle seconds (tests, the default) is full speed. The kernel always injects it.
      idleSeconds: this.idleSeconds?.() ?? Number.POSITIVE_INFINITY,
      idleThresholdSeconds: this.idleThresholdSeconds,
      thermalState: this.thermalState(),
      lowPower: this.lowPower()
    })
  }

  /** The reason to stop (heat / Low Power Mode). null if not stopping (TODO 434). */
  holdReason(): HoldReason | null {
    return holdReason(this.thermalState(), this.lowPower())
  }

  /** The automatic scan ended (either completed or interrupted). */
  finished(): void {
    this.running = false
  }

  /**
   * One round of the decision. Called from the timer, but tests call it directly.
   * While one is running, it only looks at "did heat / Low Power Mode start" (TODO 434).
   */
  tick(): AutoScanVerdict | 'aborting' | 'watching' {
    if (this.stopped) return 'busy'
    if (this.running) {
      if (!this.host.isScanning()) {
        this.running = false
        return 'watching'
      }
      const thermal = this.thermalState()
      const lowPower = this.lowPower()
      if (shouldAbortAutoScan(thermal, lowPower)) {
        this.running = false
        this.host.abortAutoScan(holdReason(thermal, lowPower) ?? 'thermal')
        return 'aborting'
      }
      return 'busy'
    }
    const verdict = decideAutoScan({
      due: this.host.decide(this.now()).full,
      scanning: this.host.isScanning(),
      thermalState: this.thermalState(),
      lowPower: this.lowPower()
    })
    this.onVerdict?.(verdict)
    if (verdict !== 'run') return verdict
    this.running = true
    this.host.startAutoScan()
    return 'run'
  }
}
