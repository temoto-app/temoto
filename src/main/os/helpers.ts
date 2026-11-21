/**
 * OS layer (TODO 986 stage 2): the binary paths of the Swift helpers (voice input, PDF, input source under `tools/`).
 * `npm run build:speech` and the like build them at `out/<name>/<name>` (macOS only. The Windows version uses different helpers, TODO 899).
 */
import { join } from 'node:path'

/** The helper's name (the same as the directory name under `tools/`). */
export type SwiftHelperName = 'speech-helper' | 'pdf-helper' | 'input-source-helper' | 'vision-helper'

/** The absolute path of the helper under `appPath` (`app.getAppPath()`). */
export function swiftHelperPath(appPath: string, name: SwiftHelperName): string {
  return join(appPath, 'out', name, name)
}
