/**
 * Builds the version values embedded into main at build time (TODO 316, wave 17 bundle A).
 *
 * **Only `electron.vite.config.ts` calls this** (once per build, once at dev-server start). The result goes into
 * `out/main/*.js` as a string through the `define` entry `__AIOS_BUILD__`, and main does not call git at run time.
 * App code does not import this file (types and format are in `src/shared/build-info.ts`).
 *
 * It does not fail without git or outside a repository (e.g. built from a tarball): commit is `unknown`, dirty is false.
 * The dirty check uses the same `--untracked-files=no` (tracked changes only) as "is it built" in `scripts/install.sh`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNKNOWN_COMMIT, type BuildInfo } from '../shared/build-info.js'

/** Runs git once and returns its stdout. Throws on failure. Replaced in tests. */
export type GitRunner = (args: readonly string[], cwd: string) => string

const runGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })

/** Parses the output of `git show -s --format=%cI`. Empty if unreadable (the display then shows no date). */
function commitDate(output: string): string {
  const iso = output.trim()
  return iso !== '' && !Number.isNaN(new Date(iso).getTime()) ? iso : ''
}

export interface BuildStampOptions {
  readonly git?: GitRunner
  /** If omitted, the `version` in `<root>/package.json`. */
  readonly version?: string
  /**
   * A distributed build (TODO 1190). Does not embed the dev repo's commit or dirty state (`unknown` / false), and the date is
   * the build time, not the commit date. If omitted, the environment variable `AIOS_RELEASE=1`. `npm run release` passes it to the build.
   */
  readonly release?: boolean
  /** "Now" for the release case. For tests. */
  readonly now?: Date
}

/** Whether this is a distributed build: when `AIOS_RELEASE=1`. */
export function isReleaseBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIOS_RELEASE === '1'
}

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function readBuildStamp(root: string, options: BuildStampOptions = {}): BuildInfo {
  if (options.release ?? isReleaseBuild()) {
    return {
      version: options.version ?? packageVersion(root),
      commit: UNKNOWN_COMMIT,
      dirty: false,
      date: (options.now ?? new Date()).toISOString()
    }
  }
  const git = options.git ?? runGit
  let commit = UNKNOWN_COMMIT
  let date = ''
  let dirty = false
  try {
    const head = git(['rev-parse', 'HEAD'], root).trim()
    if (/^[0-9a-f]{40,64}$/i.test(head)) {
      commit = head.toLowerCase()
      try {
        date = commitDate(git(['show', '-s', '--format=%cI', 'HEAD'], root))
      } catch {
        date = ''
      }
      try {
        dirty = git(['status', '--porcelain', '--untracked-files=no'], root).trim() !== ''
      } catch {
        dirty = false
      }
    }
  } catch {
    commit = UNKNOWN_COMMIT
  }
  return {
    version: options.version ?? packageVersion(root),
    commit,
    dirty,
    date
  }
}
