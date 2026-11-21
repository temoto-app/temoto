/**
 * Collects the power values sent to the index process (`power`, 6.2.2 / TODO 434).
 *
 * - The idle seconds, battery and thermal state come from `powerMonitor` (passed in by the caller).
 *   `getCurrentThermalState()` is a macOS-only API, and on versions without it and on other OSes it is `unknown`.
 * - **Electron (44) has no API for Low Power Mode**, so it reads the `lowpowermode` line of `pmset -g`
 *   (macOS 12 and later; the same value as `NSProcessInfo.isLowPowerModeEnabled`). It starts a child process, so it reads
 *   every `LOW_POWER_POLL_MS` rather than every 5 seconds, and uses the remembered value in between. false if it cannot be read.
 *
 * Does not import electron (values are injected) - tests call `parseLowPowerMode` directly.
 * One of the OS layer (`src/main/os/`, TODO 986): this is the only place that calls `pmset`.
 */
import { execFile } from 'node:child_process'
import { asThermalState, type IndexPowerReport } from '@shared/index-rpc.js'
import { log, errorFields } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import { OS_TOOLS } from '../../common/os/tools.js'

/** Interval for re-reading `pmset -g`. Low Power Mode is switched rarely, so a wide interval is used. */
export const LOW_POWER_POLL_MS = 60_000

/** Reads Low Power Mode from the output of `pmset -g` (pure function). false if the line is absent. */
export function parseLowPowerMode(output: string): boolean {
  const match = /^\s*lowpowermode\s+(\d+)/m.exec(output)
  return match !== null && match[1] !== '0'
}

export interface PowerSource {
  idleSeconds(): number
  onBattery(): boolean
  /** Returns null on versions without it and on other OSes. */
  thermalState(): unknown
}

/** Reads `pmset -g` at intervals and holds the last value of Low Power Mode. */
export class LowPowerModeReader {
  private value = false
  /** Always read on the first `current()`. */
  private readAt = Number.NEGATIVE_INFINITY
  private reading = false

  constructor(
    private readonly platform: NodeJS.Platform = hostPlatform(),
    private readonly now: () => number = Date.now,
    private readonly run: (cb: (output: string | null) => void) => void = runPmset
  ) {}

  /** The last value that could be read. If old, it is re-read in the background (not waited for). */
  current(): boolean {
    if (!isMac(this.platform)) return false
    if (!this.reading && this.now() - this.readAt >= LOW_POWER_POLL_MS) {
      this.reading = true
      this.readAt = this.now()
      this.run((output) => {
        this.reading = false
        if (output === null) return
        const next = parseLowPowerMode(output)
        if (next !== this.value) log.info('power.lowPower.changed', { lowPower: next })
        this.value = next
      })
    }
    return this.value
  }
}

function runPmset(cb: (output: string | null) => void): void {
  execFile(OS_TOOLS.pmset, ['-g'], { timeout: 5000 }, (err, stdout) => {
    if (err !== null) {
      log.warn('power.pmset.failed', errorFields(err))
      cb(null)
      return
    }
    cb(String(stdout))
  })
}

/** One round of the `power` value. */
export function collectPower(source: PowerSource, lowPower: LowPowerModeReader): IndexPowerReport {
  return {
    idleSeconds: source.idleSeconds(),
    onBattery: source.onBattery(),
    thermalState: asThermalState(source.thermalState()),
    lowPower: lowPower.current()
  }
}
