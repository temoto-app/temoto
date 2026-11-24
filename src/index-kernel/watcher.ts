/**
 * File watching (@parcel/watcher) and batching of deltas.
 *
 * @parcel/watcher emits large numbers of events at once. Sending the main → renderer notification
 * as one message per event would flood the renderer, so **it batches every 16 ms**
 * (PHASE1_BRIEF 3.3. The same policy that ARCHITECTURE.md 5.1 set for ThreadPane).
 */
import watcher from '@parcel/watcher'
import type { AsyncSubscription, Event as WatchEvent } from '@parcel/watcher'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ExclusionRules } from '../common/exclusions.js'
import { classify, isProjectDirName } from '../common/exclusions.js'
import { dirHasProjectMarker } from '../common/project-marker.js'
import { foldPath } from '../common/uri.js'
import { Batcher, FLUSH_INTERVAL_MS } from '../common/batch.js'
import { log, errorFields } from '../common/logger.js'

export { FLUSH_INTERVAL_MS }

export type RawChange = { readonly type: 'create' | 'update' | 'delete'; readonly path: string }

/**
 * A buffer that coalesces consecutive events on the same path.
 *
 * It is the generic `Batcher` (src/main/batch.ts) under the hood, using the folded path as the key.
 * Only the last event for the same path is kept: create → update is just update, and
 * create → delete is cancelled out by the delete.
 */
export class ChangeBatcher extends Batcher<RawChange> {
  constructor(
    flush: (changes: readonly RawChange[]) => void,
    intervalMs: number = FLUSH_INTERVAL_MS
  ) {
    super(flush, { intervalMs, keyOf: (change) => foldPath(change.path) })
  }
}

export interface WatchHandle {
  stop(): Promise<void>
}

/** One root to watch, and the exclusion paths handed to the native side for it. */
export interface WatchPlanRoot {
  readonly root: string
  readonly ignore: readonly string[]
}

/**
 * The watch plan. **Do not pass the folded `rule.prefix` to native.**
 * `Watcher::isIgnored` is `path.compare(0, dir.size(), dir)`, that is, a **byte-wise
 * prefix match** that does not fold case. `/users/alice/library` never matches the actual event path
 * `/Users/alice/Library/...`, so the exclusion becomes entirely ineffective, and FSEvents under
 * `~/Library` (Biome / Containers / Group Containers) all rise up to JS. The index stays clean because JS-side `classify` drops them,
 * but macOS 26's "access data from other apps" (`kTCCServiceSystemPolicyAppData`)
 * confirmation dialog appears. What we pass is `rule.raw`, before folding.
 *
 * Another point: FSEvents exclusions have no "include after all", so excluding `~/Library`
 * wholesale hides even the includes under it (`~/Library/Mobile Documents/com~apple~CloudDocs`).
 * **An include under an exclusion is subscribed to as an independent root** —
 * the same shape as the scan does with `scanRoots()` (4.4.2).
 */
export function watchPlan(root: string, rules: ExclusionRules): WatchPlanRoot[] {
  const foldedRoot = foldPath(root)
  const under = (value: string): boolean =>
    value === foldedRoot || value.startsWith(`${foldedRoot === '/' ? '' : foldedRoot}/`)

  const globs = [...rules.dirNames].map((name) => `**/${name}`)
  const ignoreFor = (base: string): string[] => {
    const folded = foldPath(base)
    const paths = rules.prefixes
      .filter((rule) => rule.action === 'exclude' && rule.prefix !== folded)
      .filter((rule) => rule.prefix.startsWith(`${folded === '/' ? '' : folded}/`))
      .map((rule) => rule.raw)
    return [...paths, ...globs]
  }

  const extras = rules.prefixes
    .filter((rule) => rule.action === 'include' && under(rule.prefix))
    .filter((rule) =>
      rules.prefixes.some(
        (other) =>
          other.action === 'exclude' &&
          under(other.prefix) &&
          rule.prefix.startsWith(`${other.prefix}/`)
      )
    )
    .map((rule) => rule.raw)

  return [root, ...extras].map((base) => ({ root: base, ignore: ignoreFor(base) }))
}

/**
 * A short-lived cache of "does this directory hold a project marker" for the watch sieve (TODO 1324).
 *
 * `build` / `dist` / `target` / `venv` are no longer in the native ignore globs (a glob cannot say "only beside a marker"), so the events
 * of a real project's `build/` now reach JS, and a busy build can send thousands of them. Each event would need the parent's listing,
 * so the answer is kept per parent directory. Two things keep it right: a TTL (a backstop) and `noteEvent`, which drops the entry of a
 * directory as soon as an event names a marker in it (`package.json` created or deleted, `git init`).
 */
export class ProjectMarkerCache {
  private readonly entries = new Map<string, { readonly value: boolean; readonly at: number }>()
  constructor(
    private readonly rules: ExclusionRules,
    private readonly ttlMs: number = MARKER_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether `dir` holds a marker, from the cache when fresh. */
  has(dir: string): boolean {
    const key = foldPath(dir)
    const at = this.now()
    const hit = this.entries.get(key)
    if (hit !== undefined && at - hit.at < this.ttlMs) return hit.value
    const value = dirHasProjectMarker(dir, this.rules)
    if (this.entries.size >= MARKER_CACHE_MAX) this.entries.clear()
    this.entries.set(key, { value, at })
    return value
  }

  /** Call for every event: an event on a marker's name drops the answer for its directory. */
  noteEvent(path: string): void {
    if (this.rules.projectMarkers.has(foldPath(basename(path)))) this.entries.delete(foldPath(dirname(path)))
  }

  get size(): number {
    return this.entries.size
  }
}

const MARKER_CACHE_TTL_MS = 5000
const MARKER_CACHE_MAX = 4096

/**
 * Whether to drop one watch delta. A delete does not reveal the kind, so the last component is run through `classify` as a file.
 * In addition, **intermediate components** (always directories) are run through the name rules (`node_modules`, etc.) (a hole found in TODO 833).
 * The native ignore glob (`/node_modules` after `**`) matches only `node_modules` itself, and deltas for its contents
 * rise up to JS. `classify` applies name rules only to the last component, so `proj/node_modules/pkg/x.js` got through, and
 * the application (`ensureDirectory`) created the `node_modules` row in the index. The scan prunes at the ancestor, so it does not get in.
 *
 * TODO 1324: an intermediate `build` / `dist` / `target` / `venv` counts only when its own parent holds a project marker
 * (looked up through `markers`, uncached when omitted). The last component is not judged here: its kind is unknown, and the apply step
 * (`applyUpsert`) judges it with the real kind.
 */
export function isExcludedEvent(
  path: string,
  rules: ExclusionRules,
  base: string,
  markers: Pick<ProjectMarkerCache, 'has'> = { has: (dir) => dirHasProjectMarker(dir, rules) }
): boolean {
  if (classify(path, basename(path), false, rules).excluded) return true
  // Look only at intermediate components below the watch root (above the root — the home's parent, etc. — is not subject to name rules).
  const prefix = base.endsWith('/') ? base : `${base}/`
  if (!path.startsWith(prefix)) return false
  const segments = path.slice(prefix.length).split('/')
  let parent = base
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    if (segment !== undefined && segment !== '') {
      if (rules.dirNames.has(foldPath(segment))) return true
      if (isProjectDirName(segment, rules) && markers.has(parent)) return true
      parent = parent.endsWith('/') ? `${parent}${segment}` : `${parent}/${segment}`
    }
  }
  return false
}

/**
 * The sieve for one native round: drops excluded events **before they reach the Batcher**. Marker events invalidate the cache first
 * (a round that creates `package.json` and `build/x` together must see the marker), then the rest are judged.
 */
export function sieveEvents(
  events: readonly WatchEvent[],
  rules: ExclusionRules,
  base: string,
  markers: ProjectMarkerCache
): WatchEvent[] {
  for (const event of events) markers.noteEvent(event.path)
  return events.filter((event) => !isExcludedEvent(event.path, rules, base, markers))
}

// ---- Watch mark, and replaying changes made while stopped (TODO 833) ----

/**
 * Takes a watch mark (FSEvents' "now" event id and time). `@parcel/watcher`'s `writeSnapshot` **does not walk the tree** on
 * the FSEvents backend (it just writes two lines, `FSEventsGetCurrentEventId` and the clock, and only `stat`s `root`).
 * The contents can only be passed in the form of a file, so we have it write to a temporary file, read it, and delete it immediately. null if it cannot be obtained.
 */
export async function takeWatchMark(root: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'aios-watch-'))
  const file = join(dir, 'mark')
  try {
    await watcher.writeSnapshot(root, file)
    const mark = (await readFile(file, 'utf8')).trim()
    return /^\d+\n\d+$/.test(mark) ? mark : null
  } catch (err) {
    log.warn('fs.watch.mark.failed', { root, ...errorFields(err) })
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The mark's time (ms). null if unreadable. */
export function watchMarkTime(mark: string): number | null {
  const ns = Number(mark.split('\n')[1])
  return Number.isFinite(ns) && ns > 0 ? Math.floor(ns / 1_000_000) : null
}

/**
 * Changes that happened under `root` since the mark (TODO 833). Reads FSEvents' history with `getEventsSince` — things created or deleted while aios was stopped,
 * and between launch and the start of watching, do not arrive through the live subscription (`subscribe` starts from "now").
 * Exclusions are the same as `watchTree` (pass each root's `ignore` from `watchPlan` to native, and also drop with `classify` in JS).
 * If the history cannot be used (the FSEvents DB was removed, or a missed-events flag is set), it throws — the caller logs it and gives up.
 */
export async function changesSince(
  root: string,
  rules: ExclusionRules,
  mark: string,
  /** Checked between roots. If true, returns what has been read so far without reading the remaining roots (during shutdown, TODO 833 code-review). */
  shouldStop: () => boolean = () => false
): Promise<RawChange[]> {
  const dir = await mkdtemp(join(tmpdir(), 'aios-watch-'))
  const file = join(dir, 'mark')
  try {
    await writeFile(file, mark)
    const out: RawChange[] = []
    const markers = new ProjectMarkerCache(rules)
    for (const { root: base, ignore } of watchPlan(root, rules)) {
      if (shouldStop()) break
      let events: WatchEvent[]
      try {
        events = await watcher.getEventsSince(base, file, { ignore: [...ignore] })
      } catch (err) {
        // A missing root itself (iCloud Drive not in use) is skipped, as in `watchTree`.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || /No such file/i.test(String(err))) continue
        throw err
      }
      for (const event of sieveEvents(events, rules, base, markers)) {
        out.push({ type: event.type, path: event.path })
      }
    }
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Watches under `root`. Paths that match the exclusion list are not reported.
 * Excluded directories are also passed to @parcel/watcher's `ignore`, so that
 * events are not produced in the first place.
 */
export async function watchTree(
  root: string,
  rules: ExclusionRules,
  onChanges: (changes: readonly RawChange[]) => void
): Promise<WatchHandle> {
  const batcher = new ChangeBatcher(onChanges)
  const markers = new ProjectMarkerCache(rules)
  const plan = watchPlan(root, rules)
  const subscriptions: { root: string; subscription: AsyncSubscription }[] = []

  /**
   * Stops. **What remains in the batch (16 ms) is not discarded but flushed to `onChanges`** (TODO 889). The subscriptions are removed first
   * (what arrives during removal also goes into the batch and flows out normally on the timer), and after removal finishes the remainder is handed over once.
   * It used to discard with `dispose()` first, so changes just before shutdown did not get into the index. The receiver (`FsIndexer`) applies
   * what arrives during shutdown as the "final flush", and `stop()` waits for it. A later `push` is ignored (`drain`).
   */
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        for (const entry of subscriptions) {
          await entry.subscription.unsubscribe()
          log.info('fs.watch.stopped', { root: entry.root })
        }
      } finally {
        // Even if removal fails, always close the batch (so a leftover timer does not fire after the DB is closed).
        subscriptions.length = 0
        const rest = batcher.drain()
        if (rest.length > 0) onChanges(rest)
      }
    })()
    return stopping
  }

  for (const { root: base, ignore } of plan) {
    let subscription: AsyncSubscription
    try {
      subscription = await watcher.subscribe(
        base,
        (err, events: WatchEvent[]) => {
          // **Do not discard the same round's events even on error (TODO 262).** The native side puts FSEvents'
          // `MustScanSubDirs` ("we missed events, re-read") in the error and **also hands over
          // the events it could pick up in the same round** (`CallbackData(error, events)` in `Watcher.cc`).
          // It used to return here, so when changes arrived in a lump like a test's `rm -rf`,
          // that round's deletions were all dropped and the rows of deleted folders stayed in the index. What was missed is
          // picked up by reconciling the tree listing (`FsIndexer.listDirectory`) and the next scan's cleanup.
          if (err !== null) log.warn('fs.watch.error', errorFields(err))
          // The sieve runs here, before the Batcher (TODO 1324): a project's `build/` is no longer ignored natively.
          for (const event of sieveEvents(events ?? [], rules, base, markers)) {
            batcher.push({ type: event.type, path: event.path })
          }
        },
        { ignore: [...ignore] }
      )
    } catch (err) {
      // A missing root itself (iCloud Drive not in use) is normal.
      log.warn('fs.watch.unavailable', { root: base, ...errorFields(err) })
      continue
    }
    subscriptions.push({ root: base, subscription })
    log.info('fs.watch.started', { root: base, ignore: ignore.length })
  }

  if (subscriptions.length === 0) {
    batcher.dispose()
    return { stop: async () => {} }
  }

  return { stop }
}
