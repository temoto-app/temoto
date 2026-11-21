/**
 * Elapsed seconds of a running tool row (item 259, ARCHITECTURE.md 4.6 "Tool elapsed").
 *
 * The seconds originate from main's record (`ThreadRuntime.toolProgress`, the last report of `tool_progress`), and
 * the time since receiving the report is added every second to advance it. For a call with no report (a short tool, before the first
 * report, a past turn that was reopened), only "running" is shown as before. Main removes the record on a result or at the end of the turn, so
 * the seconds of a stopped call never keep advancing.
 */
import { useEffect, useState } from 'react'
import type { ToolProgress } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import { formatToolElapsed, toolProgressSeconds } from '../thread/timeline.js'

const TICK_MS = 1000

/** The last elapsed time of this call in the displayed thread. Undefined if none. */
export function useToolProgress(toolUseId: string | null): ToolProgress | undefined {
  // Select the array itself (do not build a value inside the selector - the Zustand infinite-loop trap).
  const list = useThreads((state) =>
    state.activeThreadId === null ? undefined : state.threadsById[state.activeThreadId]?.runtime.toolProgress
  )
  return toolUseId === null ? undefined : list?.find((p) => p.toolUseId === toolUseId)
}

/** "Running 1m 5s". */
export function ToolElapsed({ progress }: { progress: ToolProgress }): React.JSX.Element {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [progress])
  return <>{t('tool.runningFor', { elapsed: formatToolElapsed(toolProgressSeconds(progress, now)) })}</>
}
