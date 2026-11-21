/**
 * TODO 434: the `power` value that main sends to the index process (`src/main/os/power.ts`).
 *
 * - Electron has no API for Low Power Mode, so this reads the `lowpowermode` line of `pmset -g`.
 * - The thermal state is `powerMonitor.getCurrentThermalState()` (macOS only). Where it is missing, or for an unknown value, it is `unknown`.
 *
 * Does not start a child process (the reader is injected).
 */
import { describe, expect, it } from 'vitest'
import {
  LOW_POWER_POLL_MS,
  LowPowerModeReader,
  collectPower,
  parseLowPowerMode
} from '../src/main/os/power.js'
import { asThermalState } from '../src/shared/index-rpc.js'

const PMSET = `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 lowpowermode         1
 sleep                1 (sleep prevented by coreaudiod)
`

describe('power の値 (TODO 434)', () => {
  it('`pmset -g` の lowpowermode を読む', () => {
    expect(parseLowPowerMode(PMSET)).toBe(true)
    expect(parseLowPowerMode(PMSET.replace('lowpowermode         1', 'lowpowermode         0'))).toBe(false)
    // No such line (an old macOS or another OS) gives false.
    expect(parseLowPowerMode('System-wide power settings:\n sleep 1\n')).toBe(false)
  })

  it('熱の状態は知っている値だけ通し、他は unknown', () => {
    expect(asThermalState('serious')).toBe('serious')
    expect(asThermalState('critical')).toBe('critical')
    expect(asThermalState(null)).toBe('unknown')
    expect(asThermalState('hot')).toBe('unknown')
  })

  it('pmset は間を空けて読み、間は覚えた値を使う。macOS 以外は読まずに false', () => {
    let now = 0
    let runs = 0
    let reply: ((output: string | null) => void) | null = null
    const reader = new LowPowerModeReader('darwin', () => now, (cb) => {
      runs += 1
      reply = cb
    })
    expect(reader.current()).toBe(false)
    expect(runs).toBe(1)
    reply!(PMSET)
    expect(reader.current()).toBe(true)
    expect(runs).toBe(1)
    now += LOW_POWER_POLL_MS
    expect(reader.current()).toBe(true)
    expect(runs).toBe(2)
    // If it could not be read (null), the previous value stays.
    reply!(null)
    expect(reader.current()).toBe(true)

    const other = new LowPowerModeReader('linux', () => 0, () => {
      throw new Error('must not run')
    })
    expect(other.current()).toBe(false)
  })

  it('collectPower は 4 つの値を 1 通にまとめる', () => {
    const reader = new LowPowerModeReader('linux')
    expect(
      collectPower(
        { idleSeconds: () => 12, onBattery: () => true, thermalState: () => 'fair' },
        reader
      )
    ).toEqual({ idleSeconds: 12, onBattery: true, thermalState: 'fair', lowPower: false })
  })
})
