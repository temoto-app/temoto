/**
 * The fake watcher injected into `FsIndexer` (code-review of TODO 805 / 833). Without using the real FSEvents, it records the order of subscription, marks, and history replay, and can hold them back or return diffs.
 */
import type { ExclusionRules } from '../../src/common/exclusions.js'
import type { WatchBackend } from '../../src/index-kernel/indexer.js'
import type { RawChange } from '../../src/index-kernel/watcher.js'

export interface FakeSubscription {
  readonly id: number
  readonly rules: ExclusionRules
  readonly emit: (changes: readonly RawChange[]) => void
  /** What remains in the batch (16 ms). `stop()` emits it to `onChanges` (the same as the real `watchTree`, TODO 889). */
  readonly pending: RawChange[]
  stopped: boolean
}

export interface FakeWatcher {
  readonly backend: WatchBackend
  /** The order of calls: `subscribe#N` / `stop#N` / `mark:N` / `since:N`. */
  readonly log: string[]
  readonly subscriptions: FakeSubscription[]
  /** Holds back the subscription (`watchTree` does not return until it is released). */
  subscribeGate: Promise<void> | null
  /** The diff returned by history replay (it receives the number of the mark that was called). */
  since: (markNumber: number) => RawChange[] | Promise<RawChange[]>
  /** The termination flag that the replay saw "between roots". */
  sinceStopped: boolean
}

export function makeFakeWatcher(): FakeWatcher {
  let markCount = 0
  const fake: FakeWatcher = {
    log: [],
    subscriptions: [],
    subscribeGate: null,
    since: () => [],
    sinceStopped: false,
    backend: {
      watchTree: async (_root, rules, onChanges) => {
        if (fake.subscribeGate !== null) await fake.subscribeGate
        const sub: FakeSubscription = {
          id: fake.subscriptions.length + 1,
          rules,
          emit: (changes) => onChanges(changes),
          pending: [],
          stopped: false
        }
        fake.subscriptions.push(sub)
        fake.log.push(`subscribe#${sub.id}`)
        return {
          stop: async () => {
            if (sub.stopped) return
            sub.stopped = true
            fake.log.push(`stop#${sub.id}`)
            const rest = sub.pending.splice(0)
            if (rest.length > 0) onChanges(rest)
          }
        }
      },
      takeWatchMark: async () => {
        markCount += 1
        fake.log.push(`mark:${markCount}`)
        return `${markCount}\n${Date.now() * 1_000_000}`
      },
      changesSince: async (_root, _rules, mark, shouldStop) => {
        const n = Number(mark.split('\n')[0])
        fake.log.push(`since:${n}`)
        const out = await fake.since(n)
        fake.sinceStopped = shouldStop?.() ?? false
        return out
      }
    }
  }
  return fake
}

/** The mark number (the n in `"<n>\n<ns>"`). */
export function markNumber(mark: string | null): number | null {
  if (mark === null) return null
  const n = Number(mark.split('\n')[0])
  return Number.isFinite(n) ? n : null
}
