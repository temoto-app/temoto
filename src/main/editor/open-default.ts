/**
 * The only entry point in main for opening with the OS's default app (TODO 405, for `aios.video`'s `.avi`).
 *
 * `EditorLauncher` in `src/main/editor/launcher.ts` launches the **specific** editor chosen in settings
 * (VS Code / Cursor / Zed). This is a separate path: it launches the default app that the OS
 * has associated with the extension (`.avi` cannot be played in Chromium, so the
 * plugin (`aios.video`) calls this via viewer -> bridge -> host (ViewerPane)).
 *
 * - A URI from the renderer must go through the caller's gate (`FsAccess.assertAllowed`)
 *   (the same shape as `EditorLauncher.open` / `revealInFolder`).
 * - The launch itself injects electron's `shell.openPath` as `open` (tests use a fake).
 *   It is handled per electron's contract: an empty string on success, a reason string on failure.
 * - **Does not throw.** It returns only whether it opened.
 *
 * TODO 1214: it is also called from the host (aios's own UI: one "Open" button and the right-click "Open with default app")
 * (`openInDefaultAppForHost`). The gate is only `'write'` (no exceptions), the same as `editor.open`, and **a path that gets through only with `'handoff'` (the gate that only hands
 * out locations under an exclusion) is not routed to the default app** (code-review: opening with an app that interprets the contents widens what the gate is for.
 * The band of a link that could not be opened still just opens in the chosen editor, as before). The table is `HOST_OPEN_DEFAULT_EXTENSIONS`, separate from the plugin's
 * (`OPEN_DEFAULT_EXTENSIONS_BY_PLUGIN`), so what a plugin can ask for is not widened. The validation (the URI's extension -> the gate -> the path the gate
 * returned -> the real file with symlinks resolved, each against the table) is the same `resolveOpenTarget` for both. Audit is for plugin calls only
 * (host calls only go to the log, the same as `editor.open`).
 */
import { lstatSync, realpathSync } from 'node:fs'
import type { AuditEntry } from '@shared/plugin.js'
import {
  isOpenDefaultAllowed,
  isOpenDefaultAllowedPath,
  opensInDefaultApp,
  opensInDefaultAppPath
} from '@shared/open-default.js'
import { log } from '../../common/logger.js'
import type { PathAccess } from '../../common/fs-policy.js'

export interface OpenDefaultAppDeps {
  readonly assertAllowed: (uri: string, asDirectory: boolean) => string
  /** The default is electron's `shell.openPath`. Returns `''` on success, or the reason string on failure. */
  readonly open: (path: string) => Promise<string>
  /** TODO 850: whether `pluginId` is a bundled plugin (asks PluginHost again). */
  readonly isBundledPlugin: (pluginId: string) => boolean
  /**
   * Wave 42 code-review: the real file's path (symlinks resolved). Throws if it is not a regular file.
   * If omitted, `realpathSync.native` + `lstat` (tests can inject a fake).
   */
  readonly resolveRegularFile?: (path: string) => string
  /** TODO 850: the audit log (the same shape as the Broker's `audit`). */
  readonly audit: (entry: AuditEntry) => void
}

/** The default resolution of the real file: returns the real path with symlinks resolved, and throws if it is not a regular file. */
export function resolveRegularFile(path: string): string {
  const real = realpathSync.native(path)
  if (!lstatSync(real).isFile()) throw new Error('not a regular file')
  return real
}

type OpenTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'not-allowed' | 'path' }

/**
 * Validation before opening (shared by TODO 850 / wave 42 code-review / TODO 1214). Checks against the table in this order: the URI's extension -> the gate (`assertAllowed`) ->
 * the extension of the path the gate returned -> the extension of the real file (regular files only) with symlinks resolved. Returns the **real file's path**.
 * The real path's extension is taken with `extensionOfPath` (`#` / `?` are not treated as fragments).
 *
 * The real path is **not passed through the gate again** because the gate (`FsAccess.assertAllowed` -> `resolvePath`) has already checked the symlink-resolved canonical path
 * against the same-purpose exclusions (`common/fs-policy.ts`, "the only place that stops escape via symlinks"). The realpath here
 * is for the table (extension) check. The window between the gate and realpath, and between realpath and `openPath`, where something could be swapped,
 * remains even if re-checked, as long as `openPath` opens by path (TOCTOU is the limit of an entry point that cannot be handed an O_NOFOLLOW fd).
 */
function resolveOpenTarget(
  deps: Pick<OpenDefaultAppDeps, 'assertAllowed' | 'resolveRegularFile'>,
  uri: string,
  uriAllowed: (uri: string) => boolean,
  pathAllowed: (path: string) => boolean
): OpenTarget {
  if (!uriAllowed(uri)) return { ok: false, reason: 'not-allowed' }
  let path: string
  try {
    path = deps.assertAllowed(uri, false)
  } catch {
    return { ok: false, reason: 'path' }
  }
  // The extension of the real path the gate returned is also checked against the table (so a different way of writing the URI cannot slip past the table).
  if (!pathAllowed(path)) return { ok: false, reason: 'not-allowed' }
  // Wave 42 code-review: if `a.avi` is a symlink to a `.command`, it could slip past the table's extension and be executed.
  // Take the real file, check its extension against the table too, and **open the real file's path**.
  try {
    path = (deps.resolveRegularFile ?? resolveRegularFile)(path)
  } catch {
    return { ok: false, reason: 'path' }
  }
  if (!pathAllowed(path)) return { ok: false, reason: 'not-allowed' }
  return { ok: true, path }
}

/** Calls `shell.openPath`. True on success (empty string). Does not throw. */
async function openPath(open: (path: string) => Promise<string>, path: string): Promise<boolean> {
  try {
    return (await open(path)) === ''
  } catch {
    return false
  }
}

export async function openWithDefaultApp(deps: OpenDefaultAppDeps, uri: unknown, pluginId: unknown): Promise<boolean> {
  if (typeof uri !== 'string' || uri === '') return false
  const started = Date.now()
  const record = (decision: 'allow' | 'deny', reason: string | null): void => {
    deps.audit({
      at: started,
      pluginId: typeof pluginId === 'string' ? pluginId.slice(0, 100) : '',
      capability: 'shell',
      op: 'open-default',
      target: uri.slice(0, 1000),
      decision,
      reason,
      ms: Date.now() - started
    })
  }
  // TODO 850: only when a bundled plugin asks for an extension in the table.
  if (typeof pluginId !== 'string' || !isOpenDefaultAllowed(pluginId, uri) || !deps.isBundledPlugin(pluginId)) {
    log.warn('editor.open-default.refused')
    record('deny', 'not-allowed')
    return false
  }
  const target = resolveOpenTarget(
    deps,
    uri,
    (value) => isOpenDefaultAllowed(pluginId, value),
    (path) => isOpenDefaultAllowedPath(pluginId, path)
  )
  if (!target.ok) {
    if (target.reason === 'path') log.debug('editor.open-default.denied')
    else log.warn('editor.open-default.refused')
    record('deny', target.reason)
    return false
  }
  if (!(await openPath(deps.open, target.path))) {
    log.warn('editor.open-default.failed')
    record('deny', 'open-failed')
    return false
  }
  log.info('editor.open-default.opened')
  record('allow', null)
  return true
}

export interface HostOpenDefaultAppDeps {
  /** `FsAccess.assertAllowed` pinned to `'write'` (the same as `editor.open`, no exceptions). Not wrapped with `'handoff'`. */
  readonly assertAllowed: (uri: string, asDirectory: boolean) => string
  /** The default is electron's `shell.openPath`. Returns `''` on success, or the reason string on failure. */
  readonly open: (path: string) => Promise<string>
  /** If omitted, `resolveRegularFile` (resolves symlinks, regular files only). Tests can inject a fake. */
  readonly resolveRegularFile?: (path: string) => string
}

/** Result of opening from the host with the default app (TODO 1214). `refused` was refused by the table, gate or real-file check; `failed` means the OS could not open it. */
export type HostOpenDefaultResult = 'opened' | 'refused' | 'failed'

/**
 * Opens with the OS's default app from the host (aios's own UI) (TODO 1214). **Does not trust the renderer's claim**; it
 * re-checks, with `HOST_OPEN_DEFAULT_EXTENSIONS`, the extension of the URI, of the path the gate returned, and of the real file with symlinks resolved.
 * If not in the table (`.command` / `.app` / no extension / a symlink to those), `shell.openPath` is not called. Does not throw.
 */
export async function openWithDefaultAppForHost(
  deps: HostOpenDefaultAppDeps,
  uri: unknown
): Promise<HostOpenDefaultResult> {
  if (typeof uri !== 'string' || uri === '') return 'refused'
  const target = resolveOpenTarget(deps, uri, opensInDefaultApp, opensInDefaultAppPath)
  if (!target.ok) {
    if (target.reason === 'path') log.debug('editor.open-default.host.denied')
    else log.warn('editor.open-default.host.refused')
    return 'refused'
  }
  if (!(await openPath(deps.open, target.path))) {
    log.warn('editor.open-default.host.failed')
    return 'failed'
  }
  log.info('editor.open-default.host.opened')
  return 'opened'
}

/**
 * The whole of the host's "Open with default app" (TODO 1214). If opening with the default app fails (refused by the table or gate, no association, etc.),
 * **fall back to the chosen editor** - avoid silently doing nothing. The editor only opens it as text; it does not execute it.
 */
export async function openInDefaultAppOrEditor(
  deps: {
    readonly openDefault: (uri: string) => Promise<HostOpenDefaultResult>
    readonly openEditor: (uri: string) => Promise<boolean>
  },
  uri: unknown
): Promise<boolean> {
  if (typeof uri !== 'string' || uri === '') return false
  const result = await deps.openDefault(uri)
  if (result === 'opened') return true
  log.info('editor.open-default.host.fallback', { result })
  return deps.openEditor(uri)
}

/**
 * The body of `IpcChannel.editorOpenInDefaultApp` (TODO 1214, gathered into one place in code-review). The gate is pinned to `'write'` **here**
 * (the caller cannot pass a `'handoff'` gate). If refused by the table, gate or real-file check (including a location under an exclusion), it falls back to `openEditor`
 * (`EditorLauncher.open`, also with a `'write'` gate), so a location under an exclusion is not opened by either.
 * The band of a link that could not be opened (`editorOpenHandoff`) does not go through this and just opens in the chosen editor.
 */
export function openInDefaultAppForHost(
  deps: {
    readonly assertAllowed: (uri: string, asDirectory: boolean, access: PathAccess) => string
    readonly open: (path: string) => Promise<string>
    readonly openEditor: (uri: string) => Promise<boolean>
    readonly resolveRegularFile?: (path: string) => string
  },
  uri: unknown
): Promise<boolean> {
  const { assertAllowed, openEditor, ...rest } = deps
  return openInDefaultAppOrEditor(
    {
      openDefault: (value) =>
        openWithDefaultAppForHost(
          { ...rest, assertAllowed: (target, asDirectory) => assertAllowed(target, asDirectory, 'write') },
          value
        ),
      openEditor
    },
    uri
  )
}
