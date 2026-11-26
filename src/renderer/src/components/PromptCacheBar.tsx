/**
 * A strip shown above the Composer in a thread whose prompt cache has expired (TODO 963 (3)). The decision is in `thread/prompt-cache.ts` (a pure function).
 *
 * - Text: "the next send re-reads the whole conversation (about N tokens)". Sending without pressing anything works as before (no dialog, 167).
 * - If it was open before expiry, it is redrawn once at the expiry time (no per-second timer).
 * - It is not shown while responding or awaiting approval. There is no automatic keep-alive.
 * - When the conversation is under `HANDOFF_MIN_CONVERSATION_TOKENS` (`offersHandoff` is false), the strip is light gray (`.cache-bar.subdued`) with no button (TODO 996).
 * - When the conversation is at or above `HANDOFF_MIN_CONVERSATION_TOKENS`, "lighten and continue in a new conversation" (TODO 961) is added to the same strip.
 *   It lists the estimated token counts for C (the current conversation) and B+S (the fixed cost of a new conversation + the handoff text), with no money amount. The estimate is
 *   requested from main only once, when the strip appears (`threads.handoffEstimate`). Pressing creates and opens a new thread,
 *   which starts on a copy of this conversation's viewer / Files state (TODO 1334, `thread-workspace.ts`).
 */
import { useEffect, useMemo, useState } from 'react'
import { offersHandoff as offersHandoffAt, type HandoffEstimate } from '@shared/handoff.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { workspaceCopier } from '../thread-workspace.js'
import { formatTokens } from '../context-usage.js'
import { cacheBarState, cacheExpiresAt } from '../thread/prompt-cache.js'
import { formatCacheTtl, type LastTurnCache } from '../thread/turn-end.js'
import type { TimelineItem } from '../thread/timeline.js'

const ACTIVE: ReadonlySet<string> = new Set(['starting', 'running', 'awaiting-approval'])

export function PromptCacheBar({
  threadId,
  cache,
  items
}: {
  readonly threadId: string
  /** The end row of the last turn and its lifetime (`lastTurnCache`). null while responding. */
  readonly cache: LastTurnCache | null
  readonly items: readonly TimelineItem[]
}): React.JSX.Element | null {
  const t = useT()
  const usage = useThreads((state) => state.threadsById[threadId]?.runtime.contextUsage ?? null)
  const runtimeState = useThreads((state) => state.threadsById[threadId]?.runtime.state)
  const endedAt = useMemo(
    () => (cache === null ? null : (items.find((item) => item.id === cache.resultId)?.ts ?? null)),
    [cache, items]
  )
  const ttlMs = cache?.ttlMs ?? null
  const [now, setNow] = useState(() => Date.now())

  // Redraw at the expiry time. If it has already expired, no timer is needed.
  useEffect(() => {
    const expiresAt = cacheExpiresAt(endedAt, ttlMs)
    const current = Date.now()
    setNow(current)
    if (expiresAt === null || expiresAt <= current) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expiresAt - current + 1000, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [endedAt, ttlMs])

  const state = cacheBarState({
    endedAt,
    ttlMs,
    usage,
    active: runtimeState !== undefined && ACTIVE.has(runtimeState),
    now
  })
  const offersHandoff = state !== null && offersHandoffAt(state.tokens)
  if (state === null || ttlMs === null) return null
  return (
    // TODO 996: below the threshold no handoff is offered and the user has nothing to do, so instead of hiding it we show a subdued light-gray display.
    <div className={offersHandoff ? 'cache-bar' : 'cache-bar subdued'} role="status">
      <span className="cache-bar-text" title={t('cacheBar.expiredTitle', { ttl: formatCacheTtl(ttlMs, t) })}>
        {t('cacheBar.expired', { tokens: formatTokens(state.tokens) })}
      </span>
      {offersHandoff ? <HandoffOffer threadId={threadId} conversation={state.tokens} endedAt={endedAt} /> : null}
    </div>
  )
}

/** The button and estimate for "lighten and continue in a new conversation" (TODO 961). */
function HandoffOffer({
  threadId,
  conversation,
  endedAt
}: {
  readonly threadId: string
  readonly conversation: number
  /** Key for re-requesting the estimate (the handoff text changes as turns advance). */
  readonly endedAt: number | null
}): React.JSX.Element | null {
  const t = useT()
  const handoff = useThreads((state) => state.handoff)
  const [estimate, setEstimate] = useState<HandoffEstimate | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let alive = true
    setEstimate(null)
    window.aios.threads
      .handoffEstimate(threadId)
      .then((value) => {
        if (alive) setEstimate(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [threadId, endedAt])

  const run = async (): Promise<void> => {
    if (working) return
    setWorking(true)
    try {
      // TODO 1334: the new conversation opens on a copy of this one's viewer, ← → history and Files selection.
      await handoff(threadId, workspaceCopier(threadId))
    } finally {
      setWorking(false)
    }
  }

  // Until the estimate arrives, or when no handoff message can be built (a non-saving retention, or no messages: handoffTokens is 0),
  // do not show the button. Pressing it would always end in `handoff-empty` (review).
  if (estimate === null || estimate.handoffTokens === 0) return null
  return (
    <>
      <span className="cache-bar-estimate">
        {estimate.baseTokens === null
          ? t('cacheBar.handoffEstimateNoBase', { handoff: formatTokens(estimate.handoffTokens) })
          : t('cacheBar.handoffEstimate', {
              conversation: formatTokens(conversation),
              next: formatTokens(estimate.baseTokens + estimate.handoffTokens)
            })}
      </span>
      <button
        type="button"
        className="cache-bar-button"
        title={t('cacheBar.handoffTitle')}
        disabled={working}
        onClick={() => void run()}
      >
        {working ? t('cacheBar.handoffWorking') : t('cacheBar.handoff')}
      </button>
    </>
  )
}
