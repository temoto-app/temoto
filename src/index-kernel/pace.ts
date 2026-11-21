/**
 * Pacing stages of indexing and scanning (TODO 434, ARCHITECTURE.md 6.2.2 / 6.2.3).
 *
 * P4 (2026-09-22) was "run only at idle (300 seconds), and never on battery".
 * With P1 the index moved to a separate process (`aios-index`) and there was no longer a reason for main to freeze, so
 * 434 (2026-10-04) revised it into the following 3 stages. **It does not change with the kind of power**:
 *
 * | Stage | When | How it runs |
 * |---|---|---|
 * | `full` | idle (no operation for 300 seconds or more) | full speed as before |
 * | `slow` | while in use | measures the CPU time of each step and rests (100/N - 1) times that (= N% of one core) |
 * | `hold` | thermal state `serious` or above, or Low Power Mode | stop and wait |
 *
 * The decision (`decidePace`) and the length of the rest (`restMsFor`) are pure functions. The clock, CPU time and sleep can be
 * injected into `SlowPacer`, so tests do not wait in real time (the same shape as the 7 tests of P4).
 *
 * **It does not import electron** (constraint 8.1). Heat and Low Power Mode are taken from the values main sends
 * via `power`.
 */
import { asThermalState, type ThermalState } from '@shared/index-rpc.js'
import { log } from '../common/logger.js'

/**
 * The upper bound of the slow stage: **N% of one core** (counted the same way as the % in Activity Monitor).
 * The value the owner decides by measurement (TODO 434, 10 or 20). No settings key or UI is made for it.
 */
export const SLOW_DUTY_PERCENT = 10

/** One step of the slow stage: the number of items in a build batch (full speed is 40). */
export const SLOW_BATCH_SIZE = 10
/** One step of the slow stage: the budget of the synchronous stretch of a build batch (full speed is 50 ms). */
export const SLOW_SYNC_BUDGET_MS = 20
/** One step of the slow stage: the time budget of the merge (P3) (full speed is 50 ms). */
export const SLOW_MERGE_BUDGET_MS = 20
/**
 * One step of the slow stage: the number of items in one scan batch (full speed is 2,000). A scan mostly waits on `opendir` / `lstat`,
 * and the CPU use is thin (tens of µs per item), so it is cut by count. With 250 items one step's CPU is
 * a few ms to a dozen or so ms, and one write transaction is correspondingly short.
 */
export const SLOW_SCAN_BATCH = 250
/** The width at which a rest is sliced. At this interval it checks "did the stage change / was it stopped" and wakes early. */
export const REST_SLICE_MS = 500
/** Interval at which the slow stage's measurement is logged, one line each (the material for the owner to decide N). */
export const PACE_LOG_MS = 60_000

export type Pace = 'full' | 'slow' | 'hold'

export { asThermalState, type ThermalState }

export interface PaceInput {
  readonly idleSeconds: number
  readonly idleThresholdSeconds: number
  readonly thermalState: ThermalState
  readonly lowPower: boolean
}

/** The reason for stopping (when `hold`). It becomes the `message` of `waiting` in the status bar. */
export type HoldReason = 'thermal' | 'low-power'

/** Whether to stop for heat / Low Power Mode. If stopping, the reason. */
export function holdReason(thermalState: ThermalState, lowPower: boolean): HoldReason | null {
  if (thermalState === 'serious' || thermalState === 'critical') return 'thermal'
  if (lowPower) return 'low-power'
  return null
}

/** The pacing stage (a pure function). It does not look at the kind of power (battery / AC) (owner decision 2026-10-04). */
export function decidePace(input: PaceInput): Pace {
  if (holdReason(input.thermalState, input.lowPower) !== null) return 'hold'
  return input.idleSeconds >= input.idleThresholdSeconds ? 'full' : 'slow'
}

/**
 * From the CPU time (µs) used in one step, works out the length (ms) of the rest after it (a pure function).
 * So that `cpu / (cpu + rest) = N%`, the rest is (100/N - 1) times the CPU time.
 * If one indivisible item (extracting a large PDF) used the CPU for long, the rest is correspondingly long.
 */
export function restMsFor(cpuMicros: number, dutyPercent: number = SLOW_DUTY_PERCENT): number {
  if (!(cpuMicros > 0) || !(dutyPercent > 0) || dutyPercent >= 100) return 0
  return (cpuMicros / 1000) * (100 / dutyPercent - 1)
}

export interface SlowPacerOptions {
  /** The process's CPU time (µs, user + system). Defaults to `process.cpuUsage()`. */
  readonly cpuMicros?: () => number
  readonly now?: () => number
  /** Sleep. Tests pass a fake that returns immediately. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly dutyPercent?: number
  readonly logEveryMs?: number
}

/** A clock that measures the CPU time of one step. It measures anew each time `restMs()` is called. */
export interface StepClock {
  /** The length (ms) of the rest matching the CPU time since last time (or since it was made). */
  restMs(): number
}

type Worker = 'build' | 'scan'

/**
 * Cumulative CPU time (µs, TODO 998) used by the index process's child helpers. `process.cpuUsage()` does not include the children's share, so
 * the image classification helper returns its own CPU time with each response, and it is added here. The slow stage's rest (`clock`) counts this too:
 * even if heavy work is thrown at a child, "N% of one core" is kept.
 */
let helperCpuMicros = 0

/** Adds the CPU time (µs) used by a child helper. Negative and non-finite values are ignored. */
export function addHelperCpuMicros(micros: number): void {
  if (Number.isFinite(micros) && micros > 0) helperCpuMicros += micros
}

function processCpuMicros(): number {
  const usage = process.cpuUsage()
  return usage.user + usage.system + helperCpuMicros
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Make sure the rest does not keep the process from exiting.
    timer.unref?.()
  })
}

/**
 * Holds the way of walking in the slow stage in one place (one per index process, shared by the build and the scan).
 *
 * - `clock()` - a clock that measures the CPU time of one step. What it measures is the CPU time of the **whole process**, so
 *   when the build and the scan walk at the same time each counts the other's share, and both rest longer (the safe side).
 * - `rest()` - rests. Every `REST_SLICE_MS` it looks at `wake()` and wakes if the stage changed or it was stopped.
 * - `note()` - records the stage and the number of items advanced, and logs one line on a stage change and every `PACE_LOG_MS`
 *   (`index.pace.change` / `index.pace`). The CPU% in the log is the measured value for the whole process, independent of the rest calculation.
 */
export class SlowPacer {
  readonly dutyPercent: number
  private readonly cpuMicros: () => number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly logEveryMs: number
  private readonly paces: Record<Worker, Pace | null> = { build: null, scan: null }
  /** The tally of the current window (since the last log). */
  private window = { at: 0, cpu: 0, built: 0, scanned: 0, restMs: 0, steps: 0 }

  constructor(options: SlowPacerOptions = {}) {
    this.cpuMicros = options.cpuMicros ?? processCpuMicros
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? realSleep
    this.dutyPercent = options.dutyPercent ?? SLOW_DUTY_PERCENT
    this.logEveryMs = options.logEveryMs ?? PACE_LOG_MS
    this.resetWindow()
  }

  clock(): StepClock {
    let mark = this.cpuMicros()
    return {
      restMs: () => {
        const cpu = this.cpuMicros()
        const used = cpu - mark
        mark = cpu
        return restMsFor(used, this.dutyPercent)
      }
    }
  }

  /**
   * Rests for `ms`. If `wake()` returns true, it wakes midway. Returns the length (ms) actually rested.
   * It does not sleep for 0 or less.
   */
  async rest(ms: number, wake: () => boolean): Promise<number> {
    if (!(ms > 0)) return 0
    const startedAt = this.now()
    let left = ms
    while (left > 0) {
      if (wake()) break
      const slice = Math.min(left, REST_SLICE_MS)
      await this.sleep(slice)
      left -= slice
    }
    const slept = Math.max(0, Math.min(ms, this.now() - startedAt))
    this.window.restMs += ms - Math.max(0, left)
    return slept
  }

  /** The record of one step (the stage and the number of items advanced). If the stage changed, one line is logged there. */
  note(worker: Worker, pace: Pace, items: number): void {
    const before = this.paces[worker]
    if (before !== pace) {
      this.flush('change')
      this.paces[worker] = pace
      log.info('index.pace.change', { worker, from: before, to: pace, dutyPercent: this.dutyPercent })
    }
    if (worker === 'build') this.window.built += items
    else this.window.scanned += items
    this.window.steps += 1
    if (this.now() - this.window.at >= this.logEveryMs) this.flush('interval')
  }

  /** Stopped walking (completed, interrupted, waiting). It is logged as a stage change the next time it starts walking. */
  idle(worker: Worker): void {
    if (this.paces[worker] === null) return
    this.flush('change')
    this.paces[worker] = null
  }

  /** The current stage (for tests and for checking state). */
  paceOf(worker: Worker): Pace | null {
    return this.paces[worker]
  }

  private resetWindow(): void {
    this.window = { at: this.now(), cpu: this.cpuMicros(), built: 0, scanned: 0, restMs: 0, steps: 0 }
  }

  /**
   * Logs one line of the window's tally and makes a new window. **Only a window that included the slow stage** is logged
   * (full-speed windows are already reported by the existing `index.build.progress`). Counts and time only; no path or body is logged.
   */
  private flush(reason: 'change' | 'interval'): void {
    const slow = this.paces.build === 'slow' || this.paces.scan === 'slow'
    if (slow && this.window.steps > 0) {
      const elapsedMs = Math.max(1, this.now() - this.window.at)
      const cpuMs = (this.cpuMicros() - this.window.cpu) / 1000
      log.info('index.pace', {
        reason,
        build: this.paces.build,
        scan: this.paces.scan,
        dutyPercent: this.dutyPercent,
        cpuMs: Math.round(cpuMs),
        elapsedMs,
        cpuPercent: Math.round((cpuMs / elapsedMs) * 1000) / 10,
        restMs: Math.round(this.window.restMs),
        steps: this.window.steps,
        built: this.window.built,
        scanned: this.window.scanned
      })
    }
    this.resetWindow()
  }
}
