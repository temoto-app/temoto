/**
 * The version of the running build and of its base (TODO 316, wave 17 bundle A).
 *
 * `__AIOS_BUILD__` is filled in at build time by the `define` in `electron.vite.config.ts` (`src/common/build-stamp.ts`).
 * It is undefined when loaded without going through define (such as vitest), so check with `typeof` and fall back to `unknown`.
 */
import { type as osType, arch as osArch, release as osRelease } from 'node:os'
import { UNKNOWN_COMMIT, type BuildInfo, type RuntimeInfo } from '@shared/build-info.js'

declare const __AIOS_BUILD__: BuildInfo | undefined

/** The embedded value. If absent, `fallbackVersion` (`app.getVersion()`) and `unknown`. */
export function currentBuildInfo(fallbackVersion: string): BuildInfo {
  if (typeof __AIOS_BUILD__ !== 'undefined' && __AIOS_BUILD__ !== undefined) return __AIOS_BUILD__
  return { version: fallbackVersion, commit: UNKNOWN_COMMIT, dirty: false, date: '' }
}

/** Versions of Electron / Chromium / Node / V8 / OS (in the same order as VS Code's About). */
export function currentRuntimeInfo(versions: NodeJS.ProcessVersions = process.versions): RuntimeInfo {
  return {
    electron: versions.electron ?? '',
    chromium: versions.chrome ?? '',
    node: versions.node,
    v8: versions.v8,
    os: `${osType()} ${osArch()} ${osRelease()}`
  }
}
