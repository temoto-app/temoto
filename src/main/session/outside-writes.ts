/**
 * Detects writes outside the worktree (into the main working copy) in a turn that was split with worktrees (TODO 700, ARCHITECTURE 4.4).
 *
 * spike 30: `/batch` is just a prompt under `-p`, and a weak model skipped the plan and the worktree children and rewrote the main copy directly.
 * We do not stop it and do not ask (TODO 167) - **we only show a marker** (owner decision 2026-10-11). The inputs are the target path of the write tool
 * (the Adapter's `writeToolTargetPath`) plus the conversation's working folder and the children's worktrees at that moment. The marker is shown only when the write succeeded
 * (the result is `ok`) - a write refused by the CLI's isolation check (the first Edit of a child in spike 30) did not change the main copy.
 *
 * Backend-neutral: the tail of the worktree location path is `WORKTREES_PATH_SUFFIX` in `common/exclusions.ts` (derived from compat).
 */
import { isAbsolute, resolve } from 'node:path'
import type { OutsideWriteScope } from '@shared/agent.js'
import { WORKTREES_PATH_SUFFIX } from '../../common/exclusions.js'
import { foldPath } from '../../common/uri.js'

function within(path: string, root: string): boolean {
  const p = foldPath(resolve(path))
  const r = foldPath(resolve(root))
  return p === r || p.startsWith(`${r}/`)
}

/** Whether the path is inside some worktree location (of any repository). */
function inAnyWorktree(path: string, suffix: string): boolean {
  return foldPath(resolve(path)).includes(`${foldPath(suffix)}/`)
}

export interface OutsideWriteContext {
  /** The write target (resolved against `base` if relative). */
  readonly target: string
  /** The conversation's original working folder (the main working copy). */
  readonly repoCwd: string
  /** The worktree the conversation has moved into. null if it has not moved. */
  readonly worktreeCwd: string | null
  /** If the writer is a child running in a worktree, that child's worktree. null for the parent, an ordinary child, or when not yet known. */
  readonly childRoot: string | null
  /**
   * The writer is a child running in a worktree, but the child's worktree path is not known yet (for a foreground child the result of the
   * call that started it arrives after the child ends - code-review fix). If true, a "write into the main working copy" becomes `subtask`.
   */
  readonly isolatedChild?: boolean
  /** Whether this is a turn that is split into bundles and run in worktree children (`/batch` etc.). */
  readonly parallelTurn: boolean
  readonly suffix?: string
}

/** A marker candidate (the resolved absolute path and the kind). */
export interface OutsideWriteCandidate {
  readonly path: string
  readonly scope: OutsideWriteScope
}

/**
 * Returns the resolved path and kind if the write is "a write into the main working copy in a turn split with worktrees", otherwise null
 * (pure function). Main working copy = inside the original working folder and outside every worktree location. Writes elsewhere
 * (`/tmp`, the plan file location, etc.) get no marker.
 */
export function outsideWriteScope(context: OutsideWriteContext): OutsideWriteCandidate | null {
  const suffix = context.suffix ?? WORKTREES_PATH_SUFFIX
  const base = context.childRoot ?? context.worktreeCwd ?? context.repoCwd
  const path = isAbsolute(context.target) ? resolve(context.target) : resolve(base, context.target)
  if (!within(path, context.repoCwd) || inAnyWorktree(path, suffix)) return null
  const scope = scopeOf(path, context)
  return scope === null ? null : { path, scope }
}

function scopeOf(path: string, context: OutsideWriteContext): OutsideWriteScope | null {
  if (context.childRoot !== null) return within(path, context.childRoot) ? null : 'subtask'
  // While the child's worktree path is unknown, decide by a write into the main working copy (= what reached this point).
  if (context.isolatedChild === true) return 'subtask'
  if (context.worktreeCwd !== null) return within(path, context.worktreeCwd) ? null : 'worktree'
  return context.parallelTurn ? 'parallel' : null
}

export interface OutsideWriteHit {
  readonly toolUseId: string
  readonly path: string
  readonly scope: OutsideWriteScope
}

interface ThreadState {
  parallelTurn: boolean
  /** Whether the conversation has moved into a worktree (SessionManager reports it on start and on enter/leave. A shortcut for `mayMark`). */
  worktreeActive: boolean
  /** The call that started a child running in a worktree -> that child's worktree. */
  readonly childRoots: Map<string, string>
  /** Among the calls that started a child running in a worktree, those whose worktree path is not known yet. */
  readonly isolatedStarts: Set<string>
  /** Writes waiting for a result (call id -> target and kind). */
  readonly pending: Map<string, OutsideWriteCandidate>
}

/** Per-thread bookkeeping (SessionManager holds one). Does not touch the DB. */
export class OutsideWriteTracker {
  private readonly threads = new Map<string, ThreadState>()

  private stateOf(threadId: string): ThreadState {
    let state = this.threads.get(threadId)
    if (state === undefined) {
      state = {
        parallelTurn: false,
        worktreeActive: false,
        childRoots: new Map(),
        isolatedStarts: new Set(),
        pending: new Map()
      }
      this.threads.set(threadId, state)
    }
    return state
  }

  /** A turn started with a user message. Remembers whether it is a turn split into bundles until the next message. */
  startTurn(threadId: string, parallel: boolean): void {
    this.stateOf(threadId).parallelTurn = parallel
  }

  /** Whether the conversation has moved into a worktree (the working folder at launch, enter/leave). */
  setWorktreeActive(threadId: string, active: boolean): void {
    if (!active && !this.threads.has(threadId)) return
    this.stateOf(threadId).worktreeActive = active
  }

  /**
   * Whether a write in this conversation can become a marker (code-review fix, TODO 700). If false, the caller can return without looking up the thread row -
   * unless it is a turn split into bundles, or has moved into a worktree, or has a child running in a worktree, `outsideWriteScope` is always null.
   */
  mayMark(threadId: string): boolean {
    const state = this.threads.get(threadId)
    if (state === undefined) return false
    return state.parallelTurn || state.worktreeActive || state.childRoots.size > 0 || state.isolatedStarts.size > 0
  }

  /** Saw a call that starts a child running in a worktree (`child_start` of `worktree_changed`; the path is not known yet). */
  noteChildStart(threadId: string, toolUseId: string): void {
    this.stateOf(threadId).isolatedStarts.add(toolUseId)
  }

  /** Started a child running in a worktree (`child` of `worktree_changed`). */
  noteChild(threadId: string, toolUseId: string, path: string): void {
    const state = this.stateOf(threadId)
    state.childRoots.set(toolUseId, path)
    state.isolatedStarts.delete(toolUseId)
  }

  /**
   * Saw a call of a write tool. If it is a marker candidate, wait for the result. `parentToolUseId` is, for a child's call,
   * the parent call that started the child.
   */
  noteWrite(
    threadId: string,
    write: {
      readonly toolUseId: string
      readonly target: string
      readonly parentToolUseId: string | null
      readonly repoCwd: string
      readonly worktreeCwd: string | null
    }
  ): void {
    const state = this.stateOf(threadId)
    const parent = write.parentToolUseId
    const childRoot = parent === null ? null : (state.childRoots.get(parent) ?? null)
    const candidate = outsideWriteScope({
      target: write.target,
      repoCwd: write.repoCwd,
      worktreeCwd: write.worktreeCwd,
      childRoot,
      isolatedChild: childRoot === null && parent !== null && state.isolatedStarts.has(parent),
      parallelTurn: state.parallelTurn
    })
    if (candidate !== null) state.pending.set(write.toolUseId, candidate)
  }

  /** A result arrived. Returns a marker if the candidate succeeded (only once). */
  noteResult(threadId: string, toolUseId: string, ok: boolean): OutsideWriteHit | null {
    const state = this.threads.get(threadId)
    if (state === undefined) return null
    // The result of the call that started a child (the child ended, or the start failed). Do not leave it with an unknown path.
    state.isolatedStarts.delete(toolUseId)
    const pending = state.pending.get(toolUseId)
    if (pending === undefined) return null
    state.pending.delete(toolUseId)
    return ok ? { toolUseId, path: pending.path, scope: pending.scope } : null
  }

  forget(threadId: string): void {
    this.threads.delete(threadId)
  }
}
