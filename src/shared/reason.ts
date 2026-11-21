/**
 * Reason codes for main-originated wording (ARCHITECTURE.md 7.4.4, TODO 66 owner decision 2).
 *
 * **main does not know the language.** Instead of main building the sentence that reaches the renderer and gets
 * displayed, main returns only the code here (plus the numbers or names to embed in the sentence), and the
 * renderer's dictionary (`reason.<code>`) turns it into text. Same structure as item 43's "the model's identity
 * lives in main, its display name in the renderer".
 *
 * There are 2 ways to carry it:
 *
 *   1. **As a value**: put the code as-is into a string field such as `IndexStatus.message` or
 *      `CwdHistoryEntry.reason`. The renderer recognizes it with `isReasonCode`, and shows anything that is
 *      not a code (e.g. the raw text of an exception) unchanged.
 *   2. **As an exception**: a rejected `ipcMain.handle` reaches the renderer only as the `Error.message` string
 *      (in the form `Error invoking remote method '…': Error: <message>`). So `reasonError` puts
 *      `aios-reason:<code> {json}` into the message, and the renderer's `parseReason` picks it out of the string again.
 *
 * When you add a code, also add `reason.<code>` to the renderer's `i18n/{en,ja}.ts`
 * (`test/i18n.test.ts` checks that every code has wording).
 */

export const REASON_CODES = [
  // Index process (src/main/index/client.ts)
  'index-restarting',
  'index-restart-failed',
  // The index process does not respond within the time limit (item 87). params: { seconds }
  'index-busy',
  // Creating and sending to a thread (src/main/session/manager.ts)
  'backend-not-registered',
  'thread-backend-not-registered',
  'scratch-with-cwd',
  'model-not-selectable',
  // TODO 1018 (review): tried to switch the backend of a thread that has no messages, but its process is running or starting
  'backend-switch-busy',
  'agent-unavailable',
  'agent-not-logged-in',
  // Instance started with the environment variable AIOS_DISABLE_AGENT=1 (a proxy-verification copy, item 186). Refuses send, `!` and rewind
  'agent-disabled',
  'agent-version-too-old',
  // TODO 1019: the executable was not found. params: { backend, install } (install is the install command)
  'backend-not-installed',
  // TODO 1019: the Ollama line in the settings helper area. ready: { count, models } / no-model: { pull } / down: { pull }
  'ollama-ready',
  'ollama-no-model',
  'ollama-down',
  // TODO 1066: failure of this PC's recommended operations (pull, derived model with a context length). unknown: a name not in the recommendations / runtime-down: not responding /
  // busy: an operation on the same model is running / failed: { message } (the text the runtime returned)
  'local-model-unknown',
  'local-runtime-down',
  'local-model-busy',
  'local-model-failed',
  // TODO 1066: the model could not be loaded (possibly a broken download). params: { message, model } (the runtime's text / the model to pull again)
  'local-model-broken',
  // TODO 529 stage 2: provider guidance in the settings helper area. ready: { provider, count } / setup: { provider, command, url }
  'provider-ready',
  'provider-setup',
  // TODO 1101: the opening of the guidance (login is needed only when using the user's own plan) / subscription login or API key: { provider, command, url } /
  // not using the subscription login: { provider } / TODO 1102: guidance to the usage screen: { provider, url } / the limit failure line: { message, url }
  'provider-intro',
  'provider-setup-login',
  'provider-api-key-only',
  'provider-usage',
  'usage-limit',
  'concurrency-limit',
  // A value from the renderer / gateway is out of range (item 86). params.field is the field name
  'invalid-value',
  // Saving a conversation as PDF (TODO 818): rendering or writing failed
  'export-pdf-failed',
  // Saving a conversation as HTML (TODO 866): assembling or writing failed (not a failure if only an image could not be read)
  'export-html-failed',
  // Saving a conversation as Markdown (TODO 1014): writing failed
  'export-md-failed',
  // TODO 908: why "open in terminal" (`threads.openInTerminal`) on the auth-expired badge could not open
  'terminal-unsupported',
  'terminal-no-cwd',
  'terminal-no-command',
  'terminal-cwd-denied',
  'terminal-open-failed',
  // TODO 960: auth recovery (`agent.startLogin`) is not run for API-key users (constraint 3)
  'login-api-key',
  // TODO 1282: the CLI rejected the credential it was given (e.g. an invalid API key): signing in again does not fix it, so no login is started
  'login-credential-invalid',
  // TODO 1282: the wait for the login started in Terminal ended without the login state coming back. params: { minutes }
  'login-timeout',
  // TODO 1282: the login state could not be checked several times in a row while waiting (the check itself failed to run)
  'login-check-failed',
  // TODO 1282: after the login came back, the automatic resend stopped on the login again; it is not resent automatically a second time
  'login-still-failing',
  // Working-directory history (CwdHistoryEntry.reason)
  'cwd-not-directory',
  'cwd-not-found',
  // Mirror of `FsAccess.assertAllowed` (`PathDenied.reason` in `common/fs-policy.ts`) (item 141).
  // The cwd history, the list for continuing from a CLI conversation, a folder drop and "choose another folder..."
  // land here when they hit the exclusion list etc. `pathDenialCode` in `common/fs-policy.ts` converts them.
  'path-invalid-uri',
  'path-not-absolute',
  'path-excluded',
  'path-symlink-escape',
  'path-outside-grant',
  'path-not-found',
  'path-changed',
  // TODO 918: not a regular file (FIFO, device, socket). Opening it neither reads nor writes
  'path-not-regular',
  // Attachment (AttachmentResolution.reason)
  'attach-no-thread',
  'attach-directory',
  'attach-unreadable',
  // TODO 489: when attaching an image from an excluded temporary folder (the ⌘⇧4 thumbnail) by its contents.
  // It was gone before it could be read (screencaptureui cleaned it up right after the drop)
  'attach-gone',
  // The file in the temporary folder is not an image (PNG / JPEG / GIF / WebP) - and it cannot be attached by path reference either
  'attach-temp-not-image',
  // The image exceeds the limit (8 MB) - refused because a temporary folder cannot be referenced by path
  'attach-too-large',
  // TODO 1173: HEIC / HEIF attachments are converted to JPEG before sending. The conversion tool (sips on macOS) is missing in this environment
  'attach-heic-unsupported',
  // TODO 1173: HEIC / HEIF could not be converted to JPEG (broken file, unreadable, timeout)
  'attach-heic-failed',
  // TODO 600: "add to reference scope" on the attachment band, but the parent folder is excluded (`FsAccess.isReferenceable`). `/tmp` can be added (TODO 584)
  'allow-dir-excluded',
  // Creating a thread by dropping folders (item 98). params: { count } is the number of folders
  'drop-multiple-folders',
  'drop-not-found',
  'drop-empty',
  // Lighten and continue in a new conversation (TODO 961): the original thread has no messages to hand over
  'handoff-empty',
  // Rewind (item 113, 4.5.6)
  // A thread that is responding, starting or awaiting approval cannot be rewound (stop it first)
  'rewind-busy',
  // The message row was not found, or it is not a user message
  'rewind-not-user-message',
  // This backend version does not support rewind
  'rewind-unsupported',
  // The message has no identifier (a row from before support) - files cannot be rewound
  'rewind-no-checkpoint',
  // The response just before that message has no identifier (a row from before support) - the conversation branch point cannot be made
  'rewind-no-branch-point',
  // The backend could not rewind the files (no checkpoint, etc.)
  'rewind-failed',
  // `!` in the prompt box (item 116). The `shell` marker is set but there is no command
  'shell-invalid',
  // Continue from a CLI conversation (item 111, 4.5.9)
  // The transcript was not found (deleted, unreadable, or a subagent transcript)
  'transcript-not-found',
  // An aios thread already owns that session_id (including deleted threads)
  'transcript-owned',
  // The transcript's working folder hits the exclusion rules, or does not exist. params: { reason } is the original reason
  'transcript-cwd-unusable',
  // `transcript` and `cwdUri` / `scratch` cannot be given together
  'transcript-with-cwd',
  // Wave 14 bundle M: voice input (item 226, 4.5.10)
  // Not macOS (there is no on-device recognition helper)
  'voice-unsupported',
  // The helper binary is missing or cannot be started (`npm run build:speech` was not run)
  'voice-helper-missing',
  // The audio sent is not in the promised format (16 kHz / 16 bit / mono WAV)
  'voice-invalid-audio',
  // Exceeded the limit in seconds
  'voice-too-long',
  // The previous transcription has not finished yet
  'voice-busy',
  // The transcription did not finish in time
  'voice-timeout',
  // The OS has no recognition for the display language
  'voice-locale-unsupported',
  // Any other failure (the helper crashed, unreadable output)
  'voice-failed',
  // Wave 15 bundle E: a link in the body (item 254). Not found in the cwd or auto memory. params: { name } is the link target's name
  'link-not-found',
  // Wave 44 bundle B (TODO 808): the link target exists but is in an excluded place (not put into the index or the viewer). params: { name }.
  // The band adds "open in external editor / show in Finder"
  'link-excluded',
  // Likewise TODO 816: several candidates for a partial path (file-name search results). params: { name, count }. Pick from the band's list
  'link-ambiguous',
  // Wave 71 bundle D (TODO 1155): a `thread://` link. The conversation was deleted (the band offers "restore and open") / there is no conversation /
  // the conversation exists but has no messages (deleted by the retention period, or not saved by setting)
  'thread-link-deleted',
  'thread-link-not-found',
  'thread-link-event-not-found',
  // Wave 17 bundle F: an image on the clipboard (item 319). There is no image or it cannot be read
  'paste-empty',
  // Likewise, it exceeds the same limit (8 MB) as a dropped image attachment. There is no path, so it cannot fall back to a path reference
  'paste-too-large',
  // Wave 50 (TODO 957): capture part of the screen and attach it. Cancelled (Esc, the renderer silently does nothing) / no screen-recording permission /
  // capture failed / not macOS
  'capture-cancelled',
  'capture-permission',
  'capture-failed',
  'capture-unavailable',
  // Wave 18 bundle A: scheduled runs (TODO 323, src/main/schedule/). Input validation (`shared/schedule.ts`)
  'schedule-time-invalid',
  'schedule-cron-invalid',
  // Shorter than the minimum interval (5 minutes). params: { minutes }
  'schedule-too-frequent',
  'schedule-interval-invalid',
  'schedule-name-empty',
  'schedule-prompt-empty',
  // Wave 26 bundle F: no weekday is selected (TODO 527)
  'schedule-days-empty',
  // Wave 29 bundle A: the "run once" date and time cannot be read (TODO 629)
  'schedule-once-invalid',
  // Wave 29 code-review: a valid "run once" date and time is in the past (TODO 629)
  'schedule-once-past',
  // Proxy verification 34 (TODO 655): tried to run an already used-up "run once" a second time with run-now
  'schedule-once-used',
  // TODO 725 (wave 34 bundle A): the run-count limit is not an integer of at least 1
  'schedule-max-runs-invalid',
  // TODO 725 code-review: tried to run a row whose run-count limit was used up a second time with run-now
  'schedule-max-runs-used',
  // List operations
  'schedule-job-not-found',
  'schedule-job-running',
  // TODO 952 stage 1: tried to run a plugin's scheduled task now, but the plugin is disabled, missing, or has no task declaration
  'schedule-plugin-unavailable',
  // TODO 972: a role (Teammate) - the name is empty / the role no longer exists (deleted in another window)
  'role-name-empty',
  'role-not-found',
  // TODO 1288: moving a conversation under a Teammate was refused - it is running / it was started by a scheduled run or a trigger
  'role-move-busy',
  'role-move-unattended',
  // Wave 20 bundle C: "new file / folder" in the Files tree (TODO 370, `shared/new-entry.ts` / `main/fs/create.ts`)
  // The name is empty
  'create-name-empty',
  // Starts with `/` (an absolute path)
  'create-name-absolute',
  // A control character (including NUL). params: { char } is in the form `U+0000`
  'create-name-invalid-char',
  // An empty separator (`a//b`), `.` or `..`
  'create-name-segment',
  // A single name is too long. params: { max } is the number of bytes
  'create-name-too-long',
  // The same name already exists. params: { name }
  'create-exists',
  // The parent (or an intermediate part) is not a folder. params: { name }
  'create-not-directory',
  // Any other failure (permissions, etc.). params: { code } is the errno name
  'create-failed',
  // TODO 1145: renaming in the Files tree. The name contains `/` (only within the same folder. Moving is separate)
  'rename-name-slash',
  // The rename failed (permissions, etc.). params: { code } is the errno name
  'rename-failed',
  // Wave 26 bundle B: kinds of response interruption (TODO 521, `Thread.interrupted`). The "!" balloon in the list and {reason} in the resume boilerplate
  // Could not connect (the retry failed without a status code)
  'interrupt-network',
  // A failure on the API side (the retry failed with a status code such as 5xx)
  'interrupt-server',
  // Usage limit (rate_limit rejected, or a 429 retry)
  'interrupt-limit',
  // The backend process ended in the middle of a turn (not stopped by the user)
  'interrupt-exit',
  // Any other error exit (the result is a failure, a launch failure)
  'interrupt-error',
  // TODO 893: auth expired (the CLI login expired and the token could not be refreshed). The Adapter reports it with `result.authFailed`
  'interrupt-auth',
  // TODO 893: there is nothing to "send again" (nothing was sent in this launch yet - e.g. after a restart)
  'resend-unavailable',
  // Wave 27 bundle G: an unexpected failure in an IPC handler (TODO 572, `guarded` in `ipc/handlers.ts`). The raw text is not shown in the renderer, it goes to the log
  'internal-error',
  // Wave 27 bundle F: approval denied / cancelled (TODO 567, `ApprovalOutcome.message`). It used to be a fixed Japanese sentence in main
  // The user declined without writing anything (the timeline adds no sentence with `reply: 'stop'`, so this is mainly for the record)
  'approval-denied-user',
  // Withdrawn by aios (`by: 'system'`): the session ended / the thread was deleted / aios quit / interrupt / stop
  'approval-cancelled-session-exited',
  'approval-cancelled-thread-removed',
  'approval-cancelled-quit',
  'approval-cancelled-interrupt',
  'approval-cancelled-stop',
  // Wave 29 bundle G: the backend stopped waiting (timeout of an MCP tool call, TODO 632)
  'approval-cancelled-tool-timeout',
  // Wave 50 bundle B: an approval waiting in a scheduled job could not be answered before the next schedule (TODO 959)
  'approval-cancelled-expired',
  // Wave 84 bundle A: in a trigger's unattended read-only turn, writes, outbound operations and tools with side effects were refused without asking (TODO 1216)
  'approval-denied-unattended',
  // Wave 68 bundle A: in a conversation with the OS sandbox enabled, a request to run outside the sandbox was refused (TODO 1106)
  'approval-cancelled-os-sandbox',
  // TODO 1106: the OS sandbox (4.2.4). This version / this backend does not have it (the gray reason for the thread's ⋯ toggle)
  'os-sandbox-unsupported',
  // The sandbox did not start at launch (`AgentDegradation.code`). params: { detail } is the CLI's diagnostic text (not translated)
  'os-sandbox-failed',
  // A thread with the sandbox ON is not started on a backend that cannot use the sandbox (it is never run without the sandbox)
  'os-sandbox-blocked',
  // TODO 1109 item 4: the backend list (the feature table) has not been fetched yet, so the ⋯ toggle cannot be turned ON (the gray reason)
  'os-sandbox-pending',
  // Wave 28 bundle E: the timeline's `error` row (TODO 519, `ErrorPayload.message`). It used to be a fixed Japanese sentence in the adapter
  // The backend process ended without sending a completion event (`result`). When there is a stderr tail, show it instead (diagnostic text is not made into a code)
  'agent-exited-without-result',
  // The launch could not be confirmed by the probe (item 81) (`AgentDegradation.code`). params: { detail } is the CLI's diagnostic text (not translated)
  'agent-probe-failed',
  // Wave 28 bundle G: auto-update (TODO 103, `UpdateStatus.failure`, ARCHITECTURE 8.5)
  // The GitHub CLI (gh) was not found (the Release of the distributed build is fetched with gh)
  'update-gh-missing',
  // gh is not logged in to GitHub / the repo is not visible
  'update-gh-auth',
  // Could not query the latest version (anything that does not fit the subdivisions below)
  'update-check-failed',
  // TODO 1213: subdivision of check failures. Only a classification of gh's stderr; the body is not written to the log
  // `release not found`: there is no Release yet, or the repo is not visible from gh's login (gh's stderr cannot tell them apart)
  'update-no-release',
  // The check timed out
  'update-timeout',
  // GitHub API rate limit (HTTP 429 / 403 rate limit)
  'update-rate-limited',
  // No network connection (DNS, connect, TLS, proxy)
  'update-network',
  // Could not fetch the zip / SHA256SUMS from the Release
  'update-download-failed',
  // The zip's SHA-256 does not match SHA256SUMS
  'update-checksum-mismatch',
  // The extracted aios.app is not in the shape of the distributed build (signature, identifier or version does not match)
  'update-invalid-app',
  // The signer is not accepted (ad-hoc, another Team ID, or a Developer ID that cannot be verified through Apple's CA chain. TODO 951, review 58-4)
  'update-untrusted-signer',
  // Could not place it in the version directory / could not switch the ~/Applications/aios.app symlink
  'update-install-failed',
  // An update operation was called in a form where auto-update does not work (a development shell, npm run dev, a copy)
  'update-unsupported',
  // Wave 73 bundle C: per-extension update (TODO 1144 stage 2, `PluginUpdateInfo.failure`, ARCHITECTURE 8.5.1)
  // The latest version table has no asset for a newer version of that extension (no version table, a row without an asset, the installed version is newer, not bundled)
  'plugin-update-unavailable',
  // The extension zip fetched is not in the distributed shape (path escape, symlink, too large, broken, manifest id or version differs)
  'plugin-update-invalid',
  // TODO 1144 stage 4: the SHA256SUMS signature (SHA256SUMS.sig) is missing or does not verify with the embedded public key (only builds with a public key embedded)
  'plugin-update-unsigned',
  // TODO 1233: uninstalling an extension (ARCHITECTURE 7.2). A bundled (built-in) extension cannot be removed (it can only be disabled)
  'plugin-uninstall-bundled',
  // Could not be removed from its storage location (cannot move to the trash, outside the storage location, in the middle of shutdown, etc.). The extension stays disabled
  'plugin-uninstall-failed',
  // Wave 86 fix Y: a capability consent cannot be recorded - the identity (contents) of an external extension cannot be verified, or an uninstall is in progress (ARCHITECTURE 7.7)
  'plugin-consent-unbound',
  // TODO 1237: an extension's setting values cannot be saved - the identity (contents) of an external extension cannot be verified (before computation, unreadable, too large, ARCHITECTURE 7.2.1)
  'plugin-settings-unbound',
  // Wave 36 bundle D: update of the backend (agent CLI) itself (TODO 774, `AgentUpdateStatus.failure`, ARCHITECTURE 4.6.6)
  // The update subcommand failed (network, distribution source failure, etc.). params: { exitCode }
  'agent-update-failed',
  // Did not finish in time (stopped)
  'agent-update-timeout',
  // The executable was not found or cannot be started
  'agent-update-unavailable',
  // Cannot write to the install destination (npm global permissions, etc.)
  'agent-update-permission',
  // Managed by a package manager (Homebrew, etc.). Update it there
  'agent-update-managed',
  // Another process is updating (try again later)
  'agent-update-busy',
  // Updates are blocked by an administrator setting
  'agent-update-disabled',
  // It did not switch to the specified version (revert to the previous version). params: { version }
  'agent-update-not-switched',
  // An update operation was called in a form where updates do not work (a copy, dev, a fake backend)
  'agent-update-unsupported',
  // TODO 687 code-review: a launch where userData is not the default (`--user-data-dir`, proxy verification) called the Chrome import
  // without the override (`AIOS_CHROME_HOME_DIR`) (refused by default)
  'chrome-import-blocked',
  // TODO 1129: why the DB was degraded to `memory-only` (`AppInfo.storageReason`, ARCHITECTURE chapter 8). The explanation of the title bar mark.
  // The OS keychain (safeStorage) is unavailable
  'db-keychain-unavailable',
  // The key file exists but cannot be decrypted (the keychain item is gone, or the file belongs to another user)
  'db-key-undecryptable',
  // There is a DB with contents but no key file (no key is created. The DB is not deleted)
  'db-key-missing'
] as const

/**
 * Fixed main sentences saved before they became reason codes -> the current code (TODO 519).
 * Timeline rows remain in the DB, so that old rows do not show up in Japanese even when the UI is EN,
 * they are re-read only on an **exact match** of the string (only long fixed sentences that cannot match a user's or the CLI's text are listed).
 */
const LEGACY_REASON_TEXT: ReadonlyMap<string, ReasonCode> = new Map([
  ['完了イベントを受け取らずに終了しました', 'agent-exited-without-result']
])

export type ReasonCode = (typeof REASON_CODES)[number]

/** Values to embed in a sentence. Only numbers and short names (no body text or paths - the chapter 7 convention). */
export type ReasonParams = Readonly<Record<string, string | number>>

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value)
}

/** A marker embedded in an exception's message. */
export const REASON_PREFIX = 'aios-reason:'

/** `aios-reason:<code>` or `aios-reason:<code> {"n":3}`. */
export function formatReason(code: ReasonCode, params?: ReasonParams): string {
  return params === undefined ? `${REASON_PREFIX}${code}` : `${REASON_PREFIX}${code} ${JSON.stringify(params)}`
}

/** An exception thrown by main. The message takes the `formatReason` form. */
export function reasonError(code: ReasonCode, params?: ReasonParams): Error {
  const err = new Error(formatReason(code, params))
  err.name = 'ReasonError'
  return err
}

const REASON_PATTERN = /aios-reason:([a-z0-9-]+)(?: (\{.*\}))?/

/**
 * Picks the code out of a string (an exception's message, possibly with the IPC wrapper).
 * A bare code (`index-restarting`) is also accepted. Returns null if none can be picked.
 */
export function parseReason(
  message: string | null | undefined
): { code: ReasonCode; params: ReasonParams } | null {
  if (typeof message !== 'string') return null
  if (isReasonCode(message)) return { code: message, params: {} }
  const legacy = LEGACY_REASON_TEXT.get(message)
  if (legacy !== undefined) return { code: legacy, params: {} }
  const match = REASON_PATTERN.exec(message)
  if (match === null || !isReasonCode(match[1])) return null
  let params: ReasonParams = {}
  if (match[2] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(match[2])
      if (parsed !== null && typeof parsed === 'object') params = parsed as ReasonParams
    } catch {
      // Ignore a broken value and use only the code.
    }
  }
  return { code: match[1], params }
}
