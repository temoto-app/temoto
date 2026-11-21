/**
 * Exports one question and answer (TODO 818 / 864 / 866, ARCHITECTURE.md 5.1.8). A small icon visible on hover on one's own message row
 * (left of "rewind to here"). Pressing it opens a small menu (`ExportMenu`) to save as PDF or as HTML, and choosing one makes
 * main show the save dialog. It can be pressed during a response too (the answer up to that point).
 *
 * It is in a separate file from ThreadPane.tsx (same reason as RewindMenu: parallel bundles touch the same file).
 * TODO 864: the text "PDF" did not make it clear that this is an export button, so the icon is a document + a down arrow.
 */
import { ExportMenu } from './ExportMenu.js'

export function ExportTurnButton({ threadId, eventId }: { threadId: string; eventId: string }): React.JSX.Element {
  return (
    <ExportMenu
      threadId={threadId}
      target={{ kind: 'turn', eventId }}
      className="export-turn-menu"
      buttonClassName="export-turn-button"
      iconSize={12}
    />
  )
}
