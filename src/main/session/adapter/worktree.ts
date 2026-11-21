/**
 * Reads worktree entries and exits, and children that run in a worktree, from the stream (TODO 633 stage 1, ARCHITECTURE 4.4).
 *
 * Measured in spike 30 (CLI 2.1.280): a move into a worktree in the middle of a conversation appears neither in `system/init` nor in `status`;
 * it appears only in the `tool_use_result` of the move tool. The path and branch of a child that runs in a worktree (`isolation: worktree`)
 * are not structured anywhere, and can only be built by convention from the child's id in the `tool_use_result` of the call that spawned it.
 * Re-observed with CLI 2.1.319 (TODO 1182): the result at the end of a foreground child carries `worktreePath` / `worktreeBranch` (the result of
 * launching a background child does not). It has the same shape as the move tool's "entered", so **only the result of a call to a move tool (`moveTools`) is read as an
 * entry or exit** (a fix from the wave 77 review: the id is noted at the tool_use). The result of a call that spawned a child is read as a child.
 * Neither is **decided by a single line** (a child takes two lines, "the input of the spawning call" and "its result"), so this is placed outside `parse.ts`
 * (pure functions) as a reader that holds per-session state. The key names and the convention are in `worktree` of `compat/` and
 * `worktreesPathSuffix` of `backend-paths.json` (constraint 6), and only the neutral `worktree_changed` goes out.
 */
import { basename, dirname, join, resolve } from 'node:path'
import type { AiosEvent, WorktreeChangedPayload } from '@shared/agent.js'
import type { CompatTable, WorktreeVocabulary } from './compat.js'
import type { ParseContext } from './parse.js'
import { isDirectWorktreeOf } from '../../git/worktree-path.js'
import { log } from '../../../common/logger.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Whether a message starts with a command in the table (`/<name>` followed by whitespace or the end) (TODO 700). Leading whitespace is allowed.
 * It is case-sensitive (the same as the CLI's command names).
 */
export function startsParallelCommand(commands: readonly string[], text: string): boolean {
  const trimmed = text.trimStart()
  return commands.some((name) => {
    const head = `/${name}`
    if (!trimmed.startsWith(head)) return false
    const next = trimmed.charAt(head.length)
    return next === '' || /\s/.test(next)
  })
}

/** The reader for one session. One `LiveSession` holds one. */
export class WorktreeWatch {
  /** The conversation's current working folder (launch cwd → first init → entries and exits). */
  private cwd: string
  private readonly spawnCwd: string
  private sawInit = false
  /** Calls that spawned a child specified to run in a worktree (until the result reveals the child's id). */
  private readonly isolated = new Set<string>()
  /**
   * All calls that spawned a child (whether or not isolation was given; until the result arrives). TODO 1182: their results are not read as an entry or exit
   * (CLI 2.1.319 puts pathKey in a child's result. It can appear for a resumed child or a background child too).
   */
  private readonly spawnCalls = new Set<string>()
  /** Calls to the move tools (`moveTools`) (until the result arrives). Only these results are read as entries and exits (a fix from the wave 77 review). */
  private readonly moveCalls = new Set<string>()

  constructor(
    cwd: string,
    private readonly table: Pick<CompatTable, 'worktree' | 'tasks'>,
    private readonly suffix: string | null
  ) {
    this.cwd = cwd
    this.spawnCwd = cwd
  }

  /** The conversation's current working folder (for tests and the judgment in 699). */
  get currentCwd(): string {
    return this.cwd
  }

  /**
   * Looks at one line (`raw`) and returns the events `parse.ts` made (`events`) with worktree happenings added.
   * Does nothing if there is no table (an old compat).
   */
  observe(raw: Record<string, unknown>, events: readonly AiosEvent[], ctx: ParseContext): readonly AiosEvent[] {
    const type = raw['type']
    // The notice of a git change (TODO 699) is looked at even without the worktree table (it only compares cwds).
    if (type === 'system' && raw['subtype'] === 'vcs_state_changed') return this.markElsewhere(raw, events)
    const vocab = this.table.worktree
    if (vocab === undefined || this.suffix === null) {
      if (type === 'system' && raw['subtype'] === 'init') this.noteInitCwd(raw)
      return events
    }
    const parent = raw['parent_tool_use_id']
    const isMain = parent === undefined || parent === null
    if (type === 'system' && raw['subtype'] === 'init') return [...events, ...this.onInit(raw, vocab, ctx)]
    if (type === 'assistant' && isMain) {
      // Notify at the moment the child is spawned (a fix from the TODO 700 code review: for a foreground child the result comes after the child's end).
      const started = this.noteCalls(raw, vocab)
      if (started.length > 0) {
        return [
          ...events,
          ...started.map((toolUseId) =>
            this.event(ctx, { change: 'child_start', path: this.cwd, branch: null, returnCwd: null, toolUseId })
          )
        ]
      }
    }
    if (type === 'user' && isMain && isRecord(raw['tool_use_result'])) {
      const extra = this.onToolResult(raw, raw['tool_use_result'], vocab, ctx)
      return extra === null ? events : [...events, extra]
    }
    return events
  }

  /** Even without the table, only the first init's cwd is remembered (what 699 compares against). */
  private noteInitCwd(raw: Record<string, unknown>): void {
    if (this.sawInit) return
    this.sawInit = true
    this.cwd = text(raw['cwd']) ?? this.cwd
  }

  private onInit(raw: Record<string, unknown>, vocab: WorktreeVocabulary, ctx: ParseContext): AiosEvent[] {
    // init arrives every turn (spike 15) but does not carry changes of cwd (spike 30). Read only the first one.
    if (this.sawInit) return []
    this.sawInit = true
    const reported = text(raw['cwd'])
    if (reported === null) return []
    this.cwd = reported
    // Already in a worktree from the start by the launch option (`--worktree <name>`). The one that spawned it is the original repository.
    if (this.suffix !== null && reported !== this.spawnCwd && isDirectWorktreeOf(reported, this.spawnCwd, this.suffix)) {
      return [
        this.event(ctx, {
          change: 'enter',
          path: reported,
          branch: `${vocab.branchPrefix}${basename(reported)}`,
          returnCwd: null,
          toolUseId: null,
          atLaunch: true
        })
      ]
    }
    return []
  }

  /**
   * The notice of a git change (TODO 699). If `cwd` differs from the conversation's current working folder (a commit by a child running in a worktree),
   * `elsewhere` is attached: the BottomBar's git summary belongs to the parent's working folder, so it is not refetched.
   */
  private markElsewhere(raw: Record<string, unknown>, events: readonly AiosEvent[]): readonly AiosEvent[] {
    const reported = text(raw['cwd'])
    if (reported === null || resolve(reported) === resolve(this.cwd)) return events
    return events.map((event) =>
      event.kind === 'vcs_state_changed' ? { ...event, payload: { ...event.payload, elsewhere: true as const } } : event
    )
  }

  /**
   * Notes the calls to move tools and to tools that spawn children, and returns the ids of calls for children specified to run in a worktree
   * (the ones that emit `child_start`).
   */
  private noteCalls(raw: Record<string, unknown>, vocab: WorktreeVocabulary): string[] {
    const spawnTools = this.table.tasks?.spawnTools ?? []
    const message = raw['message']
    const started: string[] = []
    if (!isRecord(message) || !Array.isArray(message['content'])) return started
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue
      const name = text(block['name'])
      const id = text(block['id'])
      const input = block['input']
      if (name === null || id === null) continue
      if (vocab.moveTools.includes(name)) {
        this.moveCalls.add(id)
        continue
      }
      if (!spawnTools.includes(name)) continue
      this.spawnCalls.add(id)
      if (!isRecord(input)) continue
      if (input[vocab.isolationKey] === vocab.isolationValue && !this.isolated.has(id)) {
        this.isolated.add(id)
        started.push(id)
      }
    }
    return started
  }

  private onToolResult(
    raw: Record<string, unknown>,
    result: Record<string, unknown>,
    vocab: WorktreeVocabulary,
    ctx: ParseContext
  ): AiosEvent | null {
    const toolUseId = toolUseIdOf(raw)
    if (toolUseId === null) return null
    // TODO 1182: the result of a child that runs in a worktree (isolation in the input) is a child. CLI 2.1.319 puts pathKey / branchKey in the result.
    if (this.isolated.has(toolUseId)) {
      this.isolated.delete(toolUseId)
      this.spawnCalls.delete(toolUseId)
      return this.childEvent(result, vocab, ctx, toolUseId)
    }
    // A child with no isolation in the input: not a parent's entry or exit. If the definition makes it run in a worktree, the result's path is one level
    // directly under the store, and only then is it remembered as a child (it is not built by convention: we cannot tell whether it ran in a worktree).
    if (this.spawnCalls.has(toolUseId)) {
      this.spawnCalls.delete(toolUseId)
      return this.reportedChild(result, vocab, ctx, toolUseId)
    }
    // Entries and exits are only the results of calls to the move tools (a fix from the wave 77 review). Entering / leaving is told apart by shape (whether originalCwd is present).
    if (this.moveCalls.has(toolUseId)) {
      this.moveCalls.delete(toolUseId)
      const path = text(result[vocab.pathKey])
      if (path === null) return null
      const branch = text(result[vocab.branchKey])
      const original = text(result[vocab.originalCwdKey])
      if (original !== null) {
        this.cwd = original
        return this.event(ctx, { change: 'exit', path, branch, returnCwd: original, toolUseId })
      }
      this.cwd = path
      return this.event(ctx, { change: 'enter', path, branch, returnCwd: null, toolUseId })
    }
    // pathKey appeared in an unknown tool's result: it does not become an entry or exit. Leave one line so a rename of the move tool can be noticed.
    if (text(result[vocab.pathKey]) !== null) log.warn('worktree.result.unrecognized', { toolUseId })
    return null
  }

  /** If the child result's pathKey is one level directly under the store, builds `child` from that path and branch (TODO 1182). */
  private reportedChild(
    result: Record<string, unknown>,
    vocab: WorktreeVocabulary,
    ctx: ParseContext,
    toolUseId: string
  ): AiosEvent | null {
    if (this.suffix === null) return null
    const reported = text(result[vocab.pathKey])
    if (reported === null || !isInWorktreeStore(reported, this.suffix)) return null
    const path = reported.replace(/\/+$/, '')
    return this.event(ctx, {
      change: 'child',
      path,
      branch: text(result[vocab.branchKey]) ?? `${vocab.branchPrefix}${basename(path)}`,
      returnCwd: null,
      toolUseId
    })
  }

  /**
   * The path and branch of a child that runs in a worktree. If the result has pathKey and it is one level directly under the store, use it (TODO 1182, CLI 2.1.319).
   * If absent or outside the store, build it from the child's id by the convention used so far (CLI 2.1.280, the result of launching a background child).
   */
  private childEvent(
    result: Record<string, unknown>,
    vocab: WorktreeVocabulary,
    ctx: ParseContext,
    toolUseId: string
  ): AiosEvent | null {
    if (this.suffix === null) return null
    const reported = this.reportedChild(result, vocab, ctx, toolUseId)
    if (reported !== null) return reported
    const agentId = text(result[vocab.agentIdKey])
    if (agentId === null || agentId.includes('/') || agentId.includes('..')) return null
    const name = `${vocab.childNamePrefix}${agentId}`
    return this.event(ctx, {
      change: 'child',
      path: join(this.cwd, this.suffix, name),
      branch: `${vocab.branchPrefix}${name}`,
      returnCwd: null,
      toolUseId
    })
  }

  private event(ctx: ParseContext, payload: WorktreeChangedPayload): AiosEvent {
    return {
      id: ctx.newId(),
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts: ctx.now(),
      actor: 'main',
      kind: 'worktree_changed',
      payload
    }
  }
}

/**
 * Whether `path` is one level directly under some repository's worktree store (`<root><suffix>/<name>`) (TODO 1182).
 * The root is not checked: the CLI creates a child's worktree under the repository root, which is not necessarily the parent's cwd (it can be a subfolder).
 */
function isInWorktreeStore(path: string, suffix: string): boolean {
  const parent = dirname(path.replace(/\/+$/, ''))
  if (!parent.endsWith(suffix)) return false
  const root = parent.slice(0, parent.length - suffix.length)
  return root !== '' && isDirectWorktreeOf(path, root, suffix)
}

/** The call id of the first `tool_result` block in a user row. */
function toolUseIdOf(raw: Record<string, unknown>): string | null {
  const message = raw['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return null
  for (const block of message['content']) {
    if (isRecord(block) && block['type'] === 'tool_result') return text(block['tool_use_id'])
  }
  return null
}
