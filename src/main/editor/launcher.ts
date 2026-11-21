/**
 * The only entry point in main for opening in an external editor (item 115, difference #10 from VS Code).
 *
 * - **The assembly of the binary name and the line-number arguments belongs to aios's own settings side (here).
 *   It is not under `compat/`** - it is aios's own setting, unrelated to the CLI, so it is outside constraint 6.
 * - Called with `execFile`. No shell. Even for a GUI launch, `PATH` is assumed to have been widened by
 *   `src/main/path-env.ts` (the measurement on this machine was a check before TODO 115 started).
 * - A URI from the renderer must go through the caller's gate (`FsAccess.assertAllowed`)
 *   (the same shape as `GitStatusReader`).
 * - If it is not found (`ENOENT`), fall back to macOS `open -a "<app name>" <path>` -
 *   the line number is lost. Other than macOS there is no such fallback, so it just returns "could not open".
 * - **Does not throw.** It returns only whether it opened (whether the process could be started). Whether the editor
 *   actually opened the file cannot be confirmed (the same judgment as `GitStatusReader`).
 */
import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { EDITOR_LABELS, type EditorId } from '@shared/editor.js'
import { log, errorFields } from '../../common/logger.js'
import type { PathAccess } from '../../common/fs-policy.js'
import { withHandoffFallback } from './reveal.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import { OS_TOOLS } from '../../common/os/tools.js'

/** Time allowed for one launch. The editor's CLI client normally returns right away (confirmed with a real VS Code). */
export const EDITOR_OPEN_TIMEOUT_MS = 5000

interface EditorCommand {
  readonly bin: string
  argsFor(path: string, line: number | null): string[]
}

/**
 * The binary name and how to assemble the arguments for opening with a line number (item 115).
 * VS Code / Cursor use `-g <file>:<line>` (goto), and Zed takes `<file>:<line>` as is.
 */
const EDITOR_COMMANDS: Readonly<Record<EditorId, EditorCommand>> = {
  vscode: {
    bin: 'code',
    argsFor: (path, line) => (line === null ? [path] : ['-g', `${path}:${line}`])
  },
  cursor: {
    bin: 'cursor',
    argsFor: (path, line) => (line === null ? [path] : ['-g', `${path}:${line}`])
  },
  zed: {
    bin: 'zed',
    argsFor: (path, line) => [line === null ? path : `${path}:${line}`]
  }
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void
) => unknown

export interface EditorLauncherDeps {
  /** The gate for URIs from the renderer. Pass `FsAccess.assertAllowed(uri, asDirectory)`. If it throws, nothing is opened. */
  readonly assertAllowed: (uri: string, asDirectory: boolean) => string
  /** The editor currently selected (`app_settings`, owner main). */
  readonly getEditorId: () => EditorId
  /** Replacement for tests. The default is `execFile` of `node:child_process`. */
  readonly run?: ExecFileLike
  /** Replacement for tests. The default is `platform` of `node:process` (for the fallback decision). */
  readonly platform?: NodeJS.Platform
}

export class EditorLauncher {
  constructor(private readonly deps: EditorLauncherDeps) {}

  /**
   * Opens a file (or, with `asDirectory: true`, a directory such as a thread's cwd) in the
   * external editor. **Does not throw**.
   */
  async open(
    uri: unknown,
    options: { readonly line?: number | null; readonly asDirectory?: boolean } = {}
  ): Promise<boolean> {
    if (typeof uri !== 'string' || uri === '') return false
    const asDirectory = options.asDirectory === true
    let path: string
    try {
      path = this.deps.assertAllowed(uri, asDirectory)
    } catch {
      log.debug('editor.open.denied')
      return false
    }
    const id = this.deps.getEditorId()
    const command = EDITOR_COMMANDS[id]
    const line = asDirectory ? null : (options.line ?? null)
    const ok = await this.spawn(command.bin, command.argsFor(path, line))
    if (ok) {
      log.info('editor.opened', { editor: id })
      return true
    }
    if (!isMac(this.deps.platform ?? hostPlatform())) {
      log.warn('editor.open.failed', { editor: id })
      return false
    }
    // Fallback: `open -a "<app name>" <path>` (the line number is lost. macOS only).
    const fallbackOk = await this.spawn(OS_TOOLS.open, ['-a', EDITOR_LABELS[id], path])
    if (!fallbackOk) log.warn('editor.open.failed', { editor: id, fallback: true })
    return fallbackOk
  }

  private spawn(bin: string, args: readonly string[]): Promise<boolean> {
    const run = this.deps.run ?? (execFile as unknown as ExecFileLike)
    return new Promise((resolve) => {
      run(bin, args, { timeout: EDITOR_OPEN_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error !== null) {
          log.debug('editor.spawn.failed', errorFields(error))
          resolve(false)
          return
        }
        resolve(true)
      })
    })
  }
}

export interface EditorLaunchersDeps extends Omit<EditorLauncherDeps, 'assertAllowed'> {
  /** `FsAccess.assertAllowed` (with the purpose of use). */
  readonly assertAllowed: (uri: string, asDirectory: boolean, access: PathAccess) => string
}

/**
 * The two entry points for the external editor (TODO 808, a fix from wave 44's code-review):
 *
 * - `editor` - `editor.open` (the Files tree, viewer headings, cwd ...). The gate stays `'write'` with no exceptions.
 * - `handoff` - only "open in external editor" in the band of a link that could not be opened (`editor.openHandoff`). If `'write'` refuses, it
 *   is checked again with the gate `'handoff'`, which only hands the path out (the same shape as `revealInFolder`'s "`'read'` -> `'handoff'`").
 *
 * If one launcher were switched to `'handoff'`, a location under an exclusion could be handed to the external editor from any entry point that calls `editor.open`.
 */
export function createEditorLaunchers(deps: EditorLaunchersDeps): {
  readonly editor: EditorLauncher
  readonly handoff: EditorLauncher
} {
  const { assertAllowed, ...rest } = deps
  return {
    editor: new EditorLauncher({ ...rest, assertAllowed: (uri, asDirectory) => assertAllowed(uri, asDirectory, 'write') }),
    handoff: new EditorLauncher({ ...rest, assertAllowed: withHandoffFallback(assertAllowed, 'write') })
  }
}
