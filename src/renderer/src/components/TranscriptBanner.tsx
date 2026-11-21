/**
 * Band for a thread continued from a transcript (item 111, ARCHITECTURE.md 4.5.9).
 *
 * The band under the heading of a thread continuing a conversation started in the terminal / VS Code. The past is read from the transcript and shown at the
 * head of the timeline (reachable with "load more").
 *
 * The "continue in terminal" button (`ResumeInTerminalButton`) was removed in item 162 (2026-09-27)
 * (there was no use for it).
 *
 * A separate file from ThreadPane.tsx (because parallel bundles touch the same file; same decision as bundle G).
 */
import type { TranscriptOrigin } from '@shared/thread.js'
import { useT } from '../i18n/index.js'

export function TranscriptBanner({ origin }: { origin: TranscriptOrigin }): React.JSX.Element {
  const t = useT()
  return (
    <div className="thread-banner fork transcript">
      {origin.fork ? t('transcript.bannerFork') : t('transcript.banner')}
      {origin.modelFallback === true ? <> {t('transcript.modelFallback')}</> : null}
    </div>
  )
}
