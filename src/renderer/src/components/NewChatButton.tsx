/**
 * An icon button for "start a new chat right here (cwd)" (items 255 / 263, the entry point of 194).
 * It shows no dialog; it calls `createThreadInFolder(uri)` with the default from settings, selects the created thread and
 * moves focus to the prompt box. While creating and right after (`NEW_CHAT_COOLDOWN_MS`) it does not accept another creation for the same cwd
 * (so rapid clicks do not make two, item 280-3. The table is in `new-chat-guard.ts`, one shared across buttons).
 *
 * The press event is not bubbled to the parent (so it does not reach the tree row's open / close, the heading, or the list's Drop receiver).
 * The look variations (such as showing only on hover) are decided by the CSS of the caller's `className`.
 * Used by the right of the heading's cwd (ThreadPane) and the file tree rows (Sidebar).
 *
 * **Item 408 (wave 21 bundle D) matched it to `ComposeIcon` (a square with a pencil).** The same picture as the side that creates through the dialog
 * (the top of the Activity Bar); the only difference is the popover wording (the old `ChatBubbleIcon` was removed).
 */
import { useState } from 'react'
import { useThreads } from '../threadStore.js'
import { ComposeIcon } from '../icons/ComposeIcon.js'
import { beginNewChat, endNewChat, newChatKey, sharedNewChatLedger as ledger } from '../new-chat-guard.js'
import { Tooltip } from './Tooltip.js'

export function NewChatButton({
  uri,
  label,
  className
}: {
  /** The URI of the folder to use as cwd. null means no affiliation (a new scratch area; for the "no affiliation" heading in cwd order). */
  uri: string | null
  /** title / aria-label ("New thread in <folder name>"). */
  label: string
  className?: string
}): React.JSX.Element {
  const createThreadInFolder = useThreads((state) => state.createThreadInFolder)
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`icon-button${className === undefined ? '' : ` ${className}`}`}
        aria-label={label}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation()
          const key = newChatKey(uri)
          if (!beginNewChat(ledger, key, Date.now())) return
          setBusy(true)
          void createThreadInFolder(uri).then(
            (ok) => {
              endNewChat(ledger, key, Date.now(), ok)
              setBusy(false)
            },
            () => {
              endNewChat(ledger, key, Date.now(), false)
              setBusy(false)
            }
          )
        }}
        // Do not let it start a row drag / double-click.
        onDoubleClick={(event) => event.stopPropagation()}
        draggable={false}
      >
        <ComposeIcon />
      </button>
    </Tooltip>
  )
}
