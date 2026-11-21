/**
 * The first-time folder notice (item 123, ARCHITECTURE.md 4.3.2). Shown right under the working folder section of the create dialog.
 * TODO 1118: the same notice is also shown above the Composer of a conversation with no messages (`placement="thread"`, a conversation opened with `aios://new`:
 * if there is a notice, main delays the working folder history until the first send and puts a marker `cwdHistoryDeferred` on the conversation. Whether to show it is
 * `threadFolderNoticeVisible`).
 *
 * Each time a folder is chosen it asks main (`threads.folderNotice`), and if there is anything that runs without confirmation (hooks / MCP servers)
 * it tells the user in a band. **It only informs and does not stop creation** (owner decision 2026-09-27). The "first time" decision, the
 * choke point and the reading of files are all in main. This only draws.
 */
import { useEffect, useState } from 'react'
import type { FolderNotice as Notice, FolderNoticeFile, Thread } from '@shared/thread.js'
import { useT } from '../i18n/index.js'

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The display path from a `file://` URI (item 55 made it fine for the renderer to see paths too). */
function uriPath(uri: string): string {
  return decode(uri.replace(/^file:\/\//, ''))
}

/** For display: relative to the cwd if under it, the full path if outside (such as an MCP definition in a parent folder). */
export function folderNoticeLabel(cwdUri: string, fileUri: string): string {
  const base = cwdUri.replace(/\/+$/, '') + '/'
  if (fileUri.startsWith(base)) return decode(fileUri.slice(base.length))
  return uriPath(fileUri)
}

function FileLine({ cwdUri, file }: { cwdUri: string; file: FolderNoticeFile }): React.JSX.Element {
  return (
    <li title={uriPath(file.uri)}>
      <code>{folderNoticeLabel(cwdUri, file.uri)}</code>
      {file.names.length > 0 ? <span className="folder-notice-names"> ({file.names.join(', ')})</span> : null}
    </li>
  )
}

/**
 * Whether to show the band above a conversation's Composer (TODO 1118). Only for a conversation main marked (opened from a link in a first-time folder),
 * with no messages yet and no provisional row being sent. A conversation with no marker (from the create dialog, Drop or a transcript) is not shown it
 * even after the user removed that folder from the recent list (a fix from the review).
 */
export function threadFolderNoticeVisible(
  thread: Pick<Thread, 'cwdHistoryDeferred' | 'lastEventAt'>,
  sending: boolean
): boolean {
  return thread.cwdHistoryDeferred === true && thread.lastEventAt === null && !sending
}

/** If `cwdUri` is null (no affiliation), nothing is shown. `placement` is the location (only the final sentence and the look differ). */
export function FolderNotice({
  cwdUri,
  placement = 'dialog'
}: {
  cwdUri: string | null
  placement?: 'dialog' | 'thread'
}): React.JSX.Element | null {
  const t = useT()
  const [notice, setNotice] = useState<{ uri: string; value: Notice } | null>(null)

  useEffect(() => {
    if (cwdUri === null) return
    let current = true
    void window.aios.threads.folderNotice(cwdUri).then(
      (value) => {
        if (current) setNotice(value === null ? null : { uri: cwdUri, value })
      },
      () => {
        if (current) setNotice(null)
      }
    )
    return () => {
      current = false
    }
  }, [cwdUri])

  // Right after switching to a different folder, do not show the previous folder's answer.
  if (cwdUri === null || notice === null || notice.uri !== cwdUri) return null
  const { hooks, mcp } = notice.value
  return (
    <div className={placement === 'thread' ? 'folder-notice in-thread' : 'folder-notice'} role="note">
      <p className="folder-notice-title">{t('newThread.folderNotice.title')}</p>
      <p>{t('newThread.folderNotice.lead')}</p>
      {hooks.length > 0 ? (
        <>
          <p className="folder-notice-kind">{t('newThread.folderNotice.hooks')}</p>
          <ul>
            {hooks.map((file) => (
              <FileLine key={file.uri} cwdUri={cwdUri} file={file} />
            ))}
          </ul>
        </>
      ) : null}
      {mcp.length > 0 ? (
        <>
          <p className="folder-notice-kind">{t('newThread.folderNotice.mcp')}</p>
          <ul>
            {mcp.map((file) => (
              <FileLine key={file.uri} cwdUri={cwdUri} file={file} />
            ))}
          </ul>
        </>
      ) : null}
      <p className="folder-notice-footer">
        {t(placement === 'thread' ? 'thread.folderNotice.footer' : 'newThread.folderNotice.footer')}
      </p>
    </div>
  )
}
