/**
 * The record of "real worktrees" for children running in worktrees (TODO 633 stage 2, ARCHITECTURE 4.4).
 *
 * Owner decision (2026-10-13): **show by inference, do not make a PR.** A child's worktree path and branch are not carried
 * structured in the stream (spike 30), so, using the `worktree_changed` (`child`) the adapter builds from convention as the material,
 * **only when git actually knows that worktree** is "branch" shown on the child's row. Whether there is a commit is seen both by
 * `vcs_state_changed` (which may not appear) and by `git rev-list` run at the end of the child.
 *
 * - Existence is confirmed by looking up `git worktree list --porcelain` by branch name (children are created directly under git's top level, and if the conversation's cwd is
 *   a subdirectory the adapter's guessed path is off - spike 31). If git cannot be called, nothing is shown.
 * - The CLI removes the worktree and branch of a child that did not commit itself at the end (spike 32, TODO 734). It is
 *   looked up again at the child's end, and the marker is dropped if it is gone.
 * - **Memory only** (not written to the DB - the same treatment as the child's model display name `subagentModels`. Not shown after a restart).
 * - This component touches neither electron nor the DB. git is injected (`SubtaskWorktreeDeps`). It does not know the branch naming convention
 *   (it uses only the values the adapter puts in `worktree_changed` - constraint 6).
 */
import type { AiosEvent } from '@shared/agent.js'
import type { SubtaskWorktree } from '@shared/thread.js'
import { pathToUri } from '../../common/uri.js'
import type { WorktreeEntry } from '../git/worktree-cleanup.js'

/** Upper bound on the number of children's worktrees remembered per thread. Oldest are discarded first. */
export const MAX_SUBTASK_WORKTREES = 60
/** The number of re-checks until found. A worktree may be made after the child starts. */
const MAX_ATTEMPTS = 4
/** The minimum interval between re-checks (ms). git is not called on every progress notification. */
const RETRY_GAP_MS = 1500
/**
 * The time (ms) from the check at a child's end to checking once more. The CLI may delete a worktree that did not commit a little
 * after the end, and with only the first check the marker of a removed worktree would remain (wave 37 code-review 7).
 */
export const FINISH_RECHECK_MS = 3000
/** Upper bound (per thread) on the record of an "end" or "commit" that arrived before the entry. */
const MAX_EARLY = 120

export interface SubtaskWorktreeDeps {
  /** Reads `git worktree list --porcelain`. null if git cannot be called. */
  readonly listWorktrees: (repoCwd: string) => Promise<readonly WorktreeEntry[] | null>
  /** Whether the path has a directory. */
  readonly exists: (path: string) => Promise<boolean>
  /** Whether that branch has a commit that is not in the main HEAD. false if unknown. */
  readonly hasCommits: (repoCwd: string, branch: string) => Promise<boolean>
  readonly now: () => number
  /** The record changed. The caller redistributes to the renderer. */
  readonly onChange: (threadId: string) => void
}

interface Entry {
  readonly toolUseId: string
  readonly branch: string
  readonly repoCwd: string
  /** The path of a worktree that git knows and whose existence was confirmed. null if not yet / no longer. */
  path: string | null
  committed: boolean
  attempts: number
  lastProbeAt: number
  probing: boolean
  /** A request for a "check after the end" arrived while one was running. Look up once more when it finishes (code-review 2). */
  again: boolean
  finished: boolean
  /** Whether the re-check after the end (`FINISH_RECHECK_MS`) has been scheduled. Only once. */
  recheckScheduled: boolean
}

/**
 * The record of events that came before the entry existed. For a foreground child (not `run_in_background`), `worktree_changed` (`child`) is
 * built from the Agent's `tool_use_result` and arrives **after** the child's end (`subtask_finished`) (adapter/worktree.ts).
 */
interface Early {
  readonly finished: Set<string>
  readonly commits: Set<string>
}

export class SubtaskWorktrees {
  private readonly byThread = new Map<string, Map<string, Entry>>()
  private readonly early = new Map<string, Early>()
  /** The cache of `runtimeOf`. Rebuilt only on a change (redistribution) (code-review 8). A null value means "no marker". */
  private readonly runtimeCache = new Map<string, Readonly<Record<string, SubtaskWorktree>> | null>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(private readonly deps: SubtaskWorktreeDeps) {}

  /** Shutdown. Nothing is distributed afterwards. */
  stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  forget(threadId: string): void {
    this.byThread.delete(threadId)
    this.early.delete(threadId)
    this.runtimeCache.delete(threadId)
  }

  /** The form carried to the renderer (only those whose existence was confirmed). null if none. */
  runtimeOf(threadId: string): Readonly<Record<string, SubtaskWorktree>> | null {
    const entries = this.byThread.get(threadId)
    if (entries === undefined) return null
    const cached = this.runtimeCache.get(threadId)
    if (cached !== undefined) return cached
    const out: Record<string, SubtaskWorktree> = {}
    let any = false
    for (const entry of entries.values()) {
      if (entry.path === null) continue
      out[entry.toolUseId] = { branch: entry.branch, uri: pathToUri(entry.path), committed: entry.committed }
      any = true
    }
    const value = any ? out : null
    this.runtimeCache.set(threadId, value)
    return value
  }

  private earlyOf(threadId: string): Early {
    let early = this.early.get(threadId)
    if (early === undefined) {
      early = { finished: new Set(), commits: new Set() }
      this.early.set(threadId, early)
    }
    return early
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value)
    while (set.size > MAX_EARLY) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  /**
   * Looks at one event. `repoCwd` is called only when a child was started (`child` of `worktree_changed`) -
   * it looks up the thread's row, so it is not called otherwise.
   */
  note(threadId: string, event: AiosEvent, repoCwd: () => string | null): void {
    if (this.stopped) return
    if (event.kind === 'worktree_changed') {
      const p = event.payload
      if (p.change !== 'child' || p.toolUseId === null || p.branch === null) return
      const cwd = repoCwd()
      if (cwd === null) return
      const entries = this.entriesOf(threadId)
      if (entries.has(p.toolUseId)) return
      const entry: Entry = {
        toolUseId: p.toolUseId,
        branch: p.branch,
        repoCwd: cwd,
        path: null,
        committed: false,
        attempts: 0,
        lastProbeAt: 0,
        probing: false,
        again: false,
        finished: false,
        recheckScheduled: false
      }
      // Foreground child: both the end and the commit notice came before the entry (code-review 1).
      const early = this.early.get(threadId)
      if (early !== undefined) {
        if (early.finished.delete(p.toolUseId)) entry.finished = true
        if (early.commits.has(p.branch)) entry.committed = true
      }
      entries.set(p.toolUseId, entry)
      this.runtimeCache.delete(threadId)
      while (entries.size > MAX_SUBTASK_WORKTREES) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      void this.probe(threadId, entry)
      return
    }
    if (event.kind === 'vcs_state_changed' && event.payload.change === 'commit' && event.payload.branch !== undefined) {
      this.remember(this.earlyOf(threadId).commits, event.payload.branch)
    }
    if (event.kind === 'subtask_finished' && event.payload.toolUseId !== null) {
      const known = this.byThread.get(threadId)?.has(event.payload.toolUseId) === true
      if (!known) this.remember(this.earlyOf(threadId).finished, event.payload.toolUseId)
    }
    const entries = this.byThread.get(threadId)
    if (entries === undefined) return
    if (event.kind === 'vcs_state_changed') {
      if (event.payload.change !== 'commit' || event.payload.branch === undefined) return
      let changed = false
      for (const entry of entries.values()) {
        if (entry.branch === event.payload.branch && !entry.committed) {
          entry.committed = true
          changed = entry.path !== null || changed
        }
      }
      if (changed) {
        this.runtimeCache.delete(threadId)
        this.deps.onChange(threadId)
      }
      return
    }
    if (event.kind === 'subtask_finished') {
      const id = event.payload.toolUseId
      const entry = id === null ? undefined : entries.get(id)
      if (entry !== undefined) {
        entry.finished = true
        void this.probe(threadId, entry, true)
      }
      return
    }
    if (event.kind === 'subtask_progress') {
      // Re-check of a child not found yet (a worktree may appear a little after the child starts).
      const now = this.deps.now()
      for (const entry of entries.values()) {
        if (entry.path === null && !entry.finished && entry.attempts < MAX_ATTEMPTS && now - entry.lastProbeAt >= RETRY_GAP_MS) {
          void this.probe(threadId, entry)
        }
      }
    }
  }

  private entriesOf(threadId: string): Map<string, Entry> {
    let entries = this.byThread.get(threadId)
    if (entries === undefined) {
      entries = new Map()
      this.byThread.set(threadId, entries)
    }
    return entries
  }

  private async probe(threadId: string, entry: Entry, force = false): Promise<void> {
    if (this.stopped) return
    if (entry.probing) {
      // A check in progress may have started before the end. Once it finishes, check once more (code-review 2).
      if (force) entry.again = true
      return
    }
    entry.probing = true
    entry.attempts += 1
    entry.lastProbeAt = this.deps.now()
    let path = entry.path
    // The commit notice (`vcs_state_changed`) can arrive during a check too, so the value at the start is not carried over.
    let sawCommit = false
    let cleared = false
    try {
      const list = await this.deps.listWorktrees(entry.repoCwd)
      if (this.stopped) return
      // A git failure or timeout (null) means "unknown". The current value is kept (code-review 3).
      if (list !== null) {
        const found = list.find((e) => !e.main && e.branch === entry.branch)
        path = found !== undefined && (await this.deps.exists(found.path)) ? found.path : null
        // For a finished child, re-check the commit with git (`vcs_state_changed` may not appear, spike 30).
        if (path !== null && entry.finished && !entry.committed && (await this.deps.hasCommits(entry.repoCwd, entry.branch))) {
          sawCommit = true
        }
        if (path === null && entry.finished) cleared = true
      }
    } catch {
      // A git failure means "unknown". The value is not changed.
    } finally {
      entry.probing = false
    }
    if (this.stopped) return
    // The values are put in all together at the end (the in-between state is not shown to `runtimeOf`).
    const committed = cleared ? false : entry.committed || sawCommit
    const changed = path !== entry.path || committed !== entry.committed
    entry.path = path
    entry.committed = committed
    if (changed) {
      this.runtimeCache.delete(threadId)
      this.deps.onChange(threadId)
    }
    if (entry.again) {
      entry.again = false
      void this.probe(threadId, entry, true)
    } else if (entry.finished && !entry.recheckScheduled) {
      this.scheduleRecheck(threadId, entry)
    }
  }

  /** Once more a little after the end check (so a stale marker is not left even if the CLI's deletion is late, code-review 7). */
  private scheduleRecheck(threadId: string, entry: Entry): void {
    entry.recheckScheduled = true
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped) void this.probe(threadId, entry, true)
    }, FINISH_RECHECK_MS)
    timer.unref?.()
    this.timers.add(timer)
  }
}
