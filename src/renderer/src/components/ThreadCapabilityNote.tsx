/**
 * TODO 1331 item 4 (ARCHITECTURE 4.6.1.2): one extra row of "what is in effect in this conversation", under the heading.
 * Shown only while the running session reported (from the answer it got at its own start) that the working folder's settings define the
 * model provider, so the app's own provider settings and the context length it would send are not in effect. It asks nobody: the flag is
 * `ThreadRuntime.folderProvider`, which main sets from that answer. After a restart there is no running session, so nothing is shown
 * until the conversation starts again.
 */
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'

/** Whether the row is shown for a runtime. Pure, for tests. */
export function showsFolderProvider(runtime: { readonly folderProvider?: true } | undefined): boolean {
  return runtime?.folderProvider === true
}

export function ThreadCapabilityNote({ threadId }: { readonly threadId: string | null }): React.JSX.Element | null {
  const t = useT()
  const shown = useThreads((state) => (threadId === null ? false : showsFolderProvider(state.threadsById[threadId]?.runtime)))
  if (!shown) return null
  return (
    <ul className="backend-caps thread-caps" aria-label={t('backendCaps.title')}>
      <li className="on">✓ {t('backendCaps.folderProvider')}</li>
    </ul>
  )
}
