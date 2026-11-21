/**
 * Bundle conversations (TODO 633 stage 3, ARCHITECTURE 7.6.6): the AI splits work into independent bundles and calls
 * the gateway's `startBundles`; aios creates a **new conversation** with a worktree for each bundle and sends each
 * its instructions. When they finish, **a short report is sent to the parent conversation as a queued message**
 * (there is no tool the parent can query with). There is no merge: it stops at the branch. Cleanup stays as in stage 1 (`git/worktree-cleanup.ts`).
 *
 * The first half of this file is pure functions (input validation, limits, the question shown to the user, the report
 * text). The second half, `BundleService`, borrows the `SessionManager` entry point (`BundleHost`) to create conversations.
 * **It does not touch electron or the DB directly.** State (which conversation belongs to which parent's bundle) is
 * **in memory only** (like queued messages: a restart breaks the reports; the conversations and worktrees remain). The one exception is
 * the mark of a bundle started from an unattended turn (TODO 1289), which the host keeps in the DB (`markStartedUnattended`).
 *
 * Backend flags such as `--worktree` live only inside the adapter (constraint 6): this file only has an entry point
 * (`launchWorktreeName`) that puts the name in `SpawnOptions.worktreeName`, and does not know the flag string.
 */
import { randomUUID } from 'node:crypto'
import type { JsonValue } from '@shared/agent.js'
import type { Thread } from '@shared/thread.js'
import { log } from '../../common/logger.js'
import { uriToPath } from '../../common/uri.js'

/** The default and range of how many can be created in one call (`BUNDLE_MAX`; the settings key is in settings-keys.ts). */
export const DEFAULT_MAX_BUNDLES = 5
export const MAX_BUNDLES_CAP = 8

const MAX_PROMPT_CHARS = 20_000
const MAX_TITLE_CHARS = 120
/** Length of the result copied into the report to the parent. Keeps long bodies out of the parent's context. */
const MAX_REPORT_CHARS = 1_500
const REPORT_ATTEMPTS = 3
const REPORT_RETRY_MS = 2_000
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export interface BundleSpec {
  /** The base of the worktree name (alphanumerics, `-`, `_`). A short mark is added to the actual name. */
  readonly name: string
  readonly title: string
  readonly prompt: string
}

export type ParsedBundles = { readonly ok: true; readonly bundles: readonly BundleSpec[] } | { readonly ok: false; readonly error: string }

/**
 * Validates the list of bundles that came from the gateway (main does not trust the gateway). At least 1 and at most
 * `max`, names without duplicates, instructions not empty. The title is optional (the name is used).
 */
export function parseBundles(raw: unknown, max: number): ParsedBundles {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'bundles must be a non-empty array' }
  if (raw.length > max) {
    return { ok: false, error: `too many bundles: ${raw.length} (at most ${max} at a time, merge or defer some)` }
  }
  const bundles: BundleSpec[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'each bundle must be an object with name and prompt' }
    }
    const record = entry as Record<string, unknown>
    const name = record['name']
    const prompt = record['prompt']
    const title = record['title']
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return { ok: false, error: 'bundle name must be 1-32 letters, digits, "-" or "_"' }
    }
    if (seen.has(name)) return { ok: false, error: `duplicate bundle name: ${name}` }
    seen.add(name)
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { ok: false, error: `bundle ${name}: prompt must not be empty` }
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `bundle ${name}: prompt is too long (at most ${MAX_PROMPT_CHARS} characters)` }
    }
    const cleanTitle = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS) : ''
    bundles.push({ name, title: cleanTitle === '' ? name : cleanTitle, prompt })
  }
  return { ok: true, bundles }
}

/**
 * TODO 1122: the refusal text when called from a conversation on a backend that cannot start in a worktree (returned
 * to the model as is). The child is created on the same backend as the parent, so it is not silently routed to the default backend here.
 */
export const BUNDLE_BACKEND_UNSUPPORTED =
  'parallel bundles are not available in this conversation: its backend cannot start a new conversation inside a worktree. Do the work yourself in this conversation instead.'

/** A choice question shown once for the list of bundles (the 4.2.2 shape). The options are "start" and "cancel". */
export const BUNDLE_START_LABEL = 'Start'
export const BUNDLE_CANCEL_LABEL = 'Cancel'

export function bundleQuestionText(bundles: readonly BundleSpec[]): string {
  const lines = bundles.map((b) => `- ${b.title} (${b.name}, ${b.prompt.length} chars): ${firstLine(b.prompt)}`)
  return `Start ${bundles.length} parallel conversation${bundles.length === 1 ? '' : 's'}, each in its own worktree? The full instructions are under "${BUNDLE_START_LABEL}" below.\n${lines.join('\n')}`
}

/** Description of "start": the full text of the instructions actually sent (the question shows only the first line, so everything goes here to cover what the approval runs). */
export function bundleFullInstructions(bundles: readonly BundleSpec[]): string {
  const body = bundles.map((b) => `=== ${b.title} (${b.name}) ===\n${b.prompt}`).join('\n\n')
  return `Create the conversations and send each exactly these instructions:\n\n${body}`
}

/** The shape of the question arguments (same as `AskUserQuestion`). A shape `questionsOf` in `questions.ts` can read. */
export function bundleQuestionInput(bundles: readonly BundleSpec[]): {
  readonly question: string
  readonly input: JsonValue
} {
  const question = bundleQuestionText(bundles)
  return {
    question,
    input: {
      questions: [
        {
          question,
          header: 'Parallel work',
          multiSelect: false,
          options: [
            { label: BUNDLE_START_LABEL, description: bundleFullInstructions(bundles) },
            { label: BUNDLE_CANCEL_LABEL, description: 'Do not create them' }
          ]
        }
      ]
    }
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 140)
}

/** The report text sent to the parent (it enters as a user message; recognized by the mark at its start). */
export function bundleReport(input: {
  readonly title: string
  readonly name: string
  readonly branch: string | null
  readonly outcome: 'finished' | 'stopped' | 'failed' | 'exited'
  readonly text: string | null
}): string {
  const verb =
    input.outcome === 'finished'
      ? 'finished'
      : input.outcome === 'stopped'
        ? 'was stopped before finishing'
        : input.outcome === 'failed'
          ? 'ended with an error'
          : 'exited before finishing'
  const head = `[aios] Bundle "${input.title}" (${input.name}) ${verb}.${input.branch === null ? '' : ` Branch: ${input.branch}.`}`
  const body = (input.text ?? '').trim()
  if (body === '') return head
  const cut = body.length > MAX_REPORT_CHARS ? `${body.slice(0, MAX_REPORT_CHARS)}…` : body
  return `${head}\nResult:\n${cut}`
}

/** What is borrowed from `SessionManager`. */
export interface BundleHost {
  isStopped(): boolean
  isAgentDisabled(): boolean
  getThread(threadId: string): Thread | null
  /** Whether the usage limit (317) has been reached. False if it cannot be determined. */
  isUsageLimited(): boolean
  /** Whether that working folder is inside a git working copy (`--worktree` cannot be used outside git). */
  isGitWorkTree(cwdPath: string): Promise<boolean>
  /**
   * Whether that conversation's backend can start a new conversation inside a worktree (TODO 1122). If false the
   * bundles are refused: the child is created on the same backend as the parent (owner decision 2026-11-05), so it must
   * not be allowed to touch the main working copy without a worktree.
   */
  supportsWorktreeLaunch(thread: Thread): boolean
  /**
   * `osSandbox` is the parent's OS sandbox (TODO 1106). It is created OFF if the backend has none.
   * TODO 1122: `backend` / `modelId` / `thinking` are the parent conversation's values (the child is created on the same backend and model as the parent).
   */
  createThread(input: {
    cwdUri: string
    title: string
    approvalStrict: boolean
    osSandbox?: boolean
    backend: string
    modelId: string | null
    thinking: Thread['thinking']
    /** TODO 972 (code-review, wave 96 fix Y): the parent's Teammate, if any (the child stays under it). */
    roleId?: string
  }): Promise<Thread>
  send(threadId: string, text: string): Promise<unknown>
  remove(threadId: string): Promise<void>
  /** The branch name remembered when that conversation entered a worktree. null if there is none yet. */
  branchOf(threadId: string): string | null
  /** The "how many can be created at once" setting. */
  maxBundles(): number
  /** Whether one more conversation process can be started now (the concurrency limit; evictable ones are counted too). */
  hasSessionRoom(): boolean
  /**
   * Code-review (wave 96 fix Y), TODO 1289: whether that (parent) conversation is in an unattended turn now (`SessionManager.isUnattendedTurnNow`).
   * A bundle started from such a turn is marked for its lifetime (`markStartedUnattended`). Omitted means false.
   */
  isUnattended?(threadId: string): boolean
  /**
   * TODO 1289 (code-review, wave 97 fix Y): marks a bundle conversation as started from an unattended turn. **Persistent** (the
   * `threads.started_unattended` column): the mark survives a restart and a removal followed by a restore, like a scheduled job's
   * or a trigger's origin. `SessionManager.isUnattendedTurnNow` reads it. Called before the bundle's first send.
   */
  markStartedUnattended?(threadId: string): void
}

interface Tracked {
  readonly parentId: string
  readonly name: string
  readonly title: string
  /** The body of the last response (a substitute when `result` has no body). */
  lastText: string | null
}

export type StartBundlesResult =
  | {
      readonly status: 'started'
      readonly threads: readonly { readonly name: string; readonly title: string; readonly threadId: string }[]
      readonly failed: readonly { readonly name: string; readonly error: string }[]
      readonly note: string
    }
  | { readonly status: 'error'; readonly error: string }

export class BundleService {
  /** Bundle conversation id -> record (until the first turn ends). */
  private readonly tracked = new Map<string, Tracked>()
  /** Bundle conversation id -> the name to enter a worktree with on the first launch. Removed once entered (or given up, reported, or the conversation is gone). */
  private readonly launchNames = new Map<string, string>()
  /** The slots `start` reserved at the same time as the check (so concurrent calls from other parents do not exceed the limit). */
  private reserved = 0

  constructor(
    private readonly host: BundleHost,
    private readonly retryDelayMs = REPORT_RETRY_MS
  ) {}

  /** The worktree name passed on the first launch (`LiveLifecycleHost.launchWorktreeName`). */
  launchWorktreeName(threadId: string): string | null {
    return this.launchNames.get(threadId) ?? null
  }

  /** It entered the worktree (the entry at launch, `worktree_changed`). Later launches are resumes and need no flag. */
  enteredWorktree(threadId: string): void {
    this.launchNames.delete(threadId)
  }

  /** The number of unfinished bundles. Used for the limit calculation. */
  activeCount(): number {
    return this.tracked.size
  }

  /**
   * The check before the call (before asking the user). Returns null if it passes, or the reason for refusal (returned
   * to the model as is). The limit counts "bundles running now + this time", so calling again cannot raise it.
   */
  precheck(count: number, parent?: Thread): string | null {
    if (this.host.isStopped()) return 'aios is shutting down'
    if (this.host.isAgentDisabled()) return 'the agent is disabled in this aios'
    // TODO 1122: the child is created on the same backend as the parent. If the backend cannot start in a worktree, refuse before asking the user.
    if (parent !== undefined && !this.host.supportsWorktreeLaunch(parent)) return BUNDLE_BACKEND_UNSUPPORTED
    if (this.host.isUsageLimited()) {
      return 'the usage limit of the plan has been reached; no new conversations are started now'
    }
    const max = this.host.maxBundles()
    const running = this.tracked.size + this.reserved
    if (running + count > max) {
      return `too many parallel bundles: ${running} still running + ${count} requested > ${max} allowed`
    }
    return null
  }

  /** Called after approval (the question that showed the list of bundles). Creates a conversation per bundle and sends the instructions. */
  async start(parentId: string, bundles: readonly BundleSpec[]): Promise<StartBundlesResult> {
    const parent = this.host.getThread(parentId)
    if (parent === null) return { status: 'error', error: 'unknown parent conversation' }
    const refused = this.precheck(bundles.length, parent)
    if (refused !== null) return { status: 'error', error: refused }
    // Decided once, at the start: the parent's unattended turn may end before a bundle's first turn does.
    const unattended = this.host.isUnattended?.(parentId) === true
    // Reserve the slots at the same time as the check (no await in between). Each is either moved to tracking per bundle, or returned on failure.
    let held = bundles.length
    this.reserved += held
    const release = (): void => {
      if (held > 0) {
        held -= 1
        this.reserved -= 1
      }
    }
    try {
      // `--worktree` can only be used inside a git working copy. Outside, refuse before starting (do not create an empty conversation).
      const cwdPath = uriToPath(parent.cwdUri)
      if (!(await this.host.isGitWorkTree(cwdPath))) {
        return { status: 'error', error: 'the working folder of this conversation is not inside a git repository' }
      }

      const threads: { name: string; title: string; threadId: string }[] = []
      const failed: { name: string; error: string }[] = []
      // Start them one at a time: starting them side by side would run `makeRoom` for all of them before any spawn, so the
      // real process count could exceed the concurrency limit. The parent counts as 1 too, so if there is not enough
      // room, return the reason without creating (it becomes `failed` even if approved).
      for (const spec of bundles) {
        let thread: Thread | null = null
        try {
          if (!this.host.hasSessionRoom()) {
            throw new Error('not started: no room for another running conversation (the concurrency limit counts the parent too)')
          }
          thread = await this.host.createThread({
            cwdUri: parent.cwdUri,
            title: spec.title,
            approvalStrict: parent.approvalStrict,
            osSandbox: parent.osSandbox === true,
            // TODO 1122: use the same backend and model as the parent, not the default backend (do not spend usage where the user did not choose).
            backend: parent.backend,
            modelId: parent.modelId,
            thinking: parent.thinking,
            ...(parent.roleId === undefined ? {} : { roleId: parent.roleId })
          })
          // Add a short mark to the name: even if a worktree with the same name was left from before, another conversation does not use the same place.
          this.launchNames.set(thread.id, `${spec.name}-${randomUUID().slice(0, 4)}`)
          this.tracked.set(thread.id, { parentId, name: spec.name, title: spec.title, lastText: null })
          // TODO 1289: kept after the first turn ends (a later turn aios starts on its own is just as unwatched), in the DB.
          if (unattended) this.host.markStartedUnattended?.(thread.id)
          release()
          await this.host.send(thread.id, spec.prompt)
          threads.push({ name: spec.name, title: spec.title, threadId: thread.id })
        } catch (err) {
          release()
          failed.push({ name: spec.name, error: errorText(err) })
          if (thread !== null) {
            const id = thread.id
            this.forget(id)
            // Do not leave an empty conversation that could not be sent (same as scheduled runs).
            await this.host.remove(id).catch((removeErr: unknown) => {
              log.warn('bundle.thread.remove.failed', { threadId: id, message: errorText(removeErr) })
            })
          }
        }
      }
    log.info('bundle.started', { parentId, started: threads.length, failed: failed.length })
    return {
      status: 'started',
      threads,
      failed,
      note:
        'Each bundle runs in its own conversation and worktree. aios will send you a short report here when each finishes; do not poll. Merging is left to the user.' +
        (failed.length > 0 ? ' Bundles listed under "failed" were approved but not started; start them later if still wanted.' : '')
    }
    } finally {
      while (held > 0) release()
    }
  }

  /** The conversation is gone or the send failed: drop the tracking and the worktree-name record (no report). */
  forget(threadId: string): void {
    this.tracked.delete(threadId)
    this.launchNames.delete(threadId)
  }

  /** Remembers the body of the bundle conversation's last response. */
  noteText(threadId: string, text: string): void {
    const entry = this.tracked.get(threadId)
    if (entry !== undefined) entry.lastText = text
  }

  /** The bundle conversation's first turn ended (`result`). Sends the report to the parent as a queued message. */
  async onTurnEnded(
    threadId: string,
    result: { readonly ok: boolean; readonly interrupted: boolean; readonly text: string | null }
  ): Promise<void> {
    const outcome = result.interrupted ? 'stopped' : result.ok ? 'finished' : 'failed'
    await this.report(threadId, outcome, result.text)
  }

  /** The process ended. If the report is not yet sent (it died midway or was stopped), sends a note to that effect. */
  async onExit(threadId: string): Promise<void> {
    await this.report(threadId, 'exited', null)
  }

  private async report(threadId: string, outcome: 'finished' | 'stopped' | 'failed' | 'exited', text: string | null): Promise<void> {
    const entry = this.tracked.get(threadId)
    if (entry === undefined || this.host.isStopped()) return
    this.tracked.delete(threadId)
    this.launchNames.delete(threadId)
    if (this.host.getThread(entry.parentId) === null) return
    const message = bundleReport({
      title: entry.title,
      name: entry.name,
      branch: this.host.branchOf(threadId),
      outcome,
      text: text ?? entry.lastText
    })
    // If the parent is responding it becomes a queued message (item 94). If not, a new turn starts.
    // A refusal (returned in the result) and a throw are treated the same, and it is resent a few times with a pause (kept simple).
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
      try {
        const sent = await this.host.send(entry.parentId, message)
        if (isRefusal(sent)) {
          log.warn('bundle.reportFailed', { threadId, parentId: entry.parentId, attempt, reason: refusalReason(sent) })
        } else {
          log.info('bundle.reported', { threadId, parentId: entry.parentId, outcome })
          return
        }
      } catch (err) {
        log.warn('bundle.reportFailed', { threadId, parentId: entry.parentId, attempt, message: errorText(err) })
      }
      if (this.host.isStopped() || this.host.getThread(entry.parentId) === null) return
      if (attempt < REPORT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
    }
  }
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 300)
}

/** Whether the send result is a refusal (`SendOutcome` is `sent` / `queued`; any other mark or `accepted: false` counts as a refusal). */
function isRefusal(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const record = result as Record<string, unknown>
  if (record['accepted'] === false) return true
  const kind = record['kind']
  return typeof kind === 'string' && kind !== 'sent' && kind !== 'queued'
}

function refusalReason(result: unknown): string {
  const reason = (result as Record<string, unknown>)['reason']
  return typeof reason === 'string' ? reason : 'rejected'
}
