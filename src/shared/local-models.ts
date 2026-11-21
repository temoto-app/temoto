/**
 * "Recommended for this PC" for local models (TODO 1066, ARCHITECTURE 4.6.1.2). Types that cross the main / renderer boundary.
 *
 * Detecting the runtime environment (OS, GPU, memory) belongs to the OS layer (`src/main/os/hardware.ts`); the recommendation
 * table and how to read the runner belong to the backend adapter and `compat/`. Neither a backend name nor a runner name is
 * written here (constraint 6). Model names are only carried as opaque strings.
 */

/** The kind of GPU. `unknown` means "not checked / cannot be checked" (anything other than NVIDIA on Windows is not checked yet). */
export type GpuKind = 'apple' | 'nvidia' | 'amd' | 'intel' | 'none' | 'unknown'

/** The broad class of OS (for display and for branching the recommendation). */
export type HostOs = 'mac' | 'windows' | 'linux' | 'other'

export interface HardwareProfile {
  readonly os: HostOs
  /** `arm64` / `x64`, etc. */
  readonly arch: string
  /** The CPU name (`Apple M5`, etc.). Empty if it cannot be obtained. */
  readonly cpu: string
  /** For Apple Silicon, the generation (M5 -> 5) and whether the GPU has a Neural Accelerator (M5 and later). */
  readonly appleChip: { readonly name: string; readonly generation: number; readonly neuralAccelerators: boolean } | null
  readonly gpu: { readonly kind: GpuKind; readonly name: string | null; readonly vramBytes: number | null }
  /** Physical memory (the whole of it for unified memory). */
  readonly memoryBytes: number
  /**
   * A guide to how much can be given to a model. For unified memory, the upper limit that can be given to the GPU (the macOS default or `iogpu.wired_limit_mb`);
   * for a discrete GPU, the VRAM. null if unknown (the caller decides from the amount of memory).
   */
  readonly gpuBudgetBytes: number | null
  readonly budgetSource: 'wired-limit' | 'default-fraction' | 'vram' | 'unknown'
}

/** The state of the local runtime (the runner's container). */
export interface LocalRuntimeInfo {
  /** Whether it responded. If false, `version` is null and the recommendation is shown without knowing whether the model is installed. */
  readonly reachable: boolean
  readonly version: string | null
  /** Whether it can run models in a GPU-specific format (MLX on Apple Silicon, etc.). */
  readonly nativeFormat: boolean
}

/** Operations the user can press. Each runs only when pressed (never automatically, owner decision 2026-10-31). */
export type LocalModelAction = 'pull' | 'tune'

export function isLocalModelAction(value: unknown): value is LocalModelAction {
  return value === 'pull' || value === 'tune'
}

/** Progress of a download (`pull`) (TODO 1066). The bytes are the total over all layers. If `total` is 0 the size is not known yet (for example while reading the listing). */
export interface LocalModelProgress {
  readonly completed: number
  readonly total: number
}

/** One row of a running operation (TODO 1066 fix). A light entry point value for getting only the progress without recomputing the recommendation. */
export interface LocalModelActivityRow {
  readonly model: string
  readonly running: LocalModelAction
  readonly progress: LocalModelProgress | null
}

export interface LocalModelPick {
  /** The name of the model to download (opaque). */
  readonly model: string
  /** The name of the derived model with a fixed context length (opaque). */
  readonly tunedModel: string
  /** The recommended context length on this PC (tokens). */
  readonly context: number
  /** An estimate of the size when loaded with that context length (bytes). */
  readonly estimatedBytes: number
  /** The display name of the quantization format (`MXFP4 (GGUF)`, etc., as in the table). */
  readonly format: string
  /** Whether it is a GPU-specific format (MLX, etc.). */
  readonly nativeFormat: boolean
  /** Whether it is an MoE with few parameters active per token. */
  readonly moe: boolean
  /** Whether it is already downloaded (false when the runtime does not respond). */
  readonly installed: boolean
  /** The context length of the derived model if one already exists. null if none. */
  readonly tunedContext: number | null
  /**
   * It could not be loaded (possibly a broken download, TODO 1066). Even if downloaded, `action` becomes `pull` (download again).
   * aios remembers this only while running. It is cleared when the re-download succeeds.
   */
  readonly broken: boolean
  /** The operation running now (no matter which window started it). null if none. */
  readonly running: LocalModelAction | null
  /** Progress when `running` is `pull`. null if nothing has arrived yet. */
  readonly progress: LocalModelProgress | null
  /** The next operation that can be pressed. null means "done" (the derived model has the recommended context length) or the runtime does not respond. */
  readonly action: LocalModelAction | null
}

export interface LocalModelAdvice {
  readonly hardware: HardwareProfile
  readonly runtime: LocalRuntimeInfo
  /** The upper limit used for the recommendation (bytes). */
  readonly budgetBytes: number
  /** There is no prospect of fitting on the GPU (it runs on the CPU, extremely slowly). */
  readonly cpuOnly: boolean
  /** The models that fit, in order (table order = recommendation order). The first is "recommended for this PC". Empty if nothing fits. */
  readonly picks: readonly LocalModelPick[]
  /** The runtime's default context length (the value that applies unless a derived model is created). */
  readonly defaultContext: number
}

export type LocalModelActionResult =
  | { readonly ok: true }
  /** `code` is a reason code (the shape of `shared/reason.ts`). */
  | { readonly ok: false; readonly code: string }
