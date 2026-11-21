/**
 * Detects this PC's execution environment (OS, CPU / GPU, memory) (TODO 1066, ARCHITECTURE 4.6.1.2).
 *
 * One of the OS layer (`src/main/os/`, TODO 986): this is the only place that calls `sysctl` / `nvidia-smi`. The recommendation of local models
 * (the backend's adapter) looks only at the `HardwareProfile` returned here.
 *
 * - macOS (Apple Silicon): unified memory. The upper limit that can go to the GPU is `iogpu.wired_limit_mb` (0 = default), and the default is taken to be
 *   about 2/3 of physical memory (36GB or less) / about 3/4 (larger) - **these fractions are from memory (the known values of Metal's
 *   `recommendedMaxWorkingSetSize`). On 2026-11-13, on this Mac (24GB), only the fact that `iogpu.wired_limit_mb` is 0 was
 *   confirmed. The fractions themselves have not been confirmed.**
 * - Windows / Linux: reads only NVIDIA's VRAM with `nvidia-smi` (owner decision 2026-10-31 "NVIDIA VRAM only, first").
 *   AMD / Intel are not examined (`unknown`). It has not been run on a real Windows machine.
 *
 * The child process is cut off at 3 seconds, and if it cannot be read, it falls to "unknown" (no exception).
 */
import { execFile } from 'node:child_process'
import { arch, cpus, totalmem } from 'node:os'
import type { HardwareProfile, HostOs } from '@shared/local-models.js'
import { log } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import { OS_TOOLS } from '../../common/os/tools.js'

const RUN_TIMEOUT_MS = 3000
const GB = 1024 ** 3
const MB = 1024 ** 2

/** The default fraction of the GPU limit (from memory; see the comment above). */
const MAC_GPU_FRACTION_SMALL = 2 / 3
const MAC_GPU_FRACTION_LARGE = 3 / 4
const MAC_GPU_LARGE_FROM_BYTES = 36 * GB

/** The first generation whose GPU has a Neural Accelerator (M5, Apple's announcement of 2025-10; from memory). */
const NEURAL_ACCELERATOR_FROM_GENERATION = 5

export interface HardwareDeps {
  readonly platform: string
  readonly arch: string
  readonly totalmem: number
  readonly cpu: string
  /** Runs a tool and returns stdout. null on failure or timeout. */
  run(command: string, args: readonly string[]): Promise<string | null>
}

function runTool(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: RUN_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err === null ? String(stdout) : null)
    })
  })
}

function defaultDeps(): HardwareDeps {
  return {
    platform: hostPlatform(),
    arch: arch(),
    totalmem: totalmem(),
    cpu: cpus()[0]?.model.trim() ?? '',
    run: runTool
  }
}

export function hostOsOf(platform: string): HostOs {
  if (isMac(platform)) return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'other'
}

/** `Apple M5` / `Apple M4 Pro` -> generation. null if not Apple Silicon (pure function). */
export function parseAppleChip(brand: string): HardwareProfile['appleChip'] {
  const match = /^Apple M(\d+)\b/.exec(brand.trim())
  if (match === null) return null
  const generation = Number(match[1])
  return { name: brand.trim(), generation, neuralAccelerators: generation >= NEURAL_ACCELERATOR_FROM_GENERATION }
}

/**
 * The output of `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` -> the GPU with the largest VRAM
 * (pure function). A line is `NVIDIA GeForce RTX 4090, 24564` (MiB). null if it cannot be read.
 */
export function parseNvidiaSmi(output: string): { readonly name: string; readonly vramBytes: number } | null {
  let best: { name: string; vramBytes: number } | null = null
  for (const line of output.split(/\r?\n/)) {
    const comma = line.lastIndexOf(',')
    if (comma < 0) continue
    const name = line.slice(0, comma).trim()
    const mib = Number(line.slice(comma + 1).trim())
    if (name === '' || !Number.isFinite(mib) || mib <= 0) continue
    if (best === null || mib * MB > best.vramBytes) best = { name, vramBytes: mib * MB }
  }
  return best
}

/** The upper limit that can go to the macOS GPU (pure function). `wiredLimitMb` is `iogpu.wired_limit_mb` (0 or unreadable means the default). */
export function macGpuBudget(
  memoryBytes: number,
  wiredLimitMb: number | null
): { readonly bytes: number; readonly source: 'wired-limit' | 'default-fraction' } {
  if (wiredLimitMb !== null && wiredLimitMb > 0) return { bytes: Math.min(wiredLimitMb * MB, memoryBytes), source: 'wired-limit' }
  const fraction = memoryBytes > MAC_GPU_LARGE_FROM_BYTES ? MAC_GPU_FRACTION_LARGE : MAC_GPU_FRACTION_SMALL
  return { bytes: Math.floor(memoryBytes * fraction), source: 'default-fraction' }
}

/** Detects the execution environment. Touches neither models nor runtimes. */
export async function detectHardware(deps: HardwareDeps = defaultDeps()): Promise<HardwareProfile> {
  const os = hostOsOf(deps.platform)
  const base = { os, arch: deps.arch, cpu: deps.cpu, memoryBytes: deps.totalmem }
  if (os === 'mac') {
    const chip = parseAppleChip(deps.cpu)
    if (chip === null) {
      // An Intel Mac: not unified memory. The GPU is not examined.
      return { ...base, appleChip: null, gpu: { kind: 'unknown', name: null, vramBytes: null }, gpuBudgetBytes: null, budgetSource: 'unknown' }
    }
    const raw = await deps.run(OS_TOOLS.sysctl, ['-n', 'iogpu.wired_limit_mb'])
    const parsed = raw === null ? null : Number(raw.trim())
    const budget = macGpuBudget(deps.totalmem, parsed !== null && Number.isFinite(parsed) ? parsed : null)
    return {
      ...base,
      appleChip: chip,
      gpu: { kind: 'apple', name: chip.name, vramBytes: null },
      gpuBudgetBytes: budget.bytes,
      budgetSource: budget.source
    }
  }
  if (os === 'windows' || os === 'linux') {
    const raw = await deps.run(OS_TOOLS.nvidiaSmi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
    const nvidia = raw === null ? null : parseNvidiaSmi(raw)
    if (nvidia !== null) {
      return {
        ...base,
        appleChip: null,
        gpu: { kind: 'nvidia', name: nvidia.name, vramBytes: nvidia.vramBytes },
        gpuBudgetBytes: nvidia.vramBytes,
        budgetSource: 'vram'
      }
    }
  }
  // AMD / Intel / CPU only: not examined yet (the rest of TODO 1066).
  return { ...base, appleChip: null, gpu: { kind: 'unknown', name: null, vramBytes: null }, gpuBudgetBytes: null, budgetSource: 'unknown' }
}

let cached: Promise<HardwareProfile> | null = null

/** It does not change while running, so it is examined only once (`force` re-examines). */
export function hardwareProfile(force = false): Promise<HardwareProfile> {
  if (cached === null || force) {
    cached = detectHardware().then((profile) => {
      log.info('hardware.detected', {
        os: profile.os,
        gpu: profile.gpu.kind,
        memoryGb: Math.round(profile.memoryBytes / GB),
        budgetGb: profile.gpuBudgetBytes === null ? null : Math.round(profile.gpuBudgetBytes / GB),
        budgetSource: profile.budgetSource
      })
      return profile
    })
  }
  return cached
}
