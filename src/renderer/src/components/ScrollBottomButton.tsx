/**
 * The round "down to the bottom" button (TODO 552, 5.1.4). As in other chat apps,
 * it floats at the center of the timeline column, just above the Composer, **only while away from the bottom**.
 *
 * - Its container is a **zero-height** sibling like `JumpNav` (`.scroll-bottom-host`). It is not mixed into `.thread-body`
 *   (so it does not break the child order of `ev-<id>`, the "load more" correction, or the assumptions of `pinned`).
 * - It is shown when ThreadPane's `pinned` is false (80px slack at the bottom, `STICK_BOTTOM_SLACK_PX` in `thread/jump.ts`).
 *   Right after 464's "to the start of the answer when it ends" moves the view to the start, `pinned` is off, so it shows (that is fine).
 * - Pressing calls `jumpLast` (the same entry point as JumpNav's "to the last answer": put the view at the bottom and set `pinned` again).
 *   While an answer is in progress it follows later increments again. If the in-thread search jump highlight (`highlightEventId`) is still on,
 *   auto-scroll stays stopped, so it is cleared first.
 * - The bottom of the timeline is always loaded (when opening, it reads from the newer side, and earlier pages are only prepended;
 *   `thread/load-until.ts`). So "read the bottom page first" is not needed.
 */
import { Tooltip } from './Tooltip.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'

/** A downward arrow. The same format as T14 / T17: inline SVG, color only `currentColor` (7.4.1). */
function ArrowDownIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  )
}

export function ScrollBottomButton({
  visible,
  onJump
}: {
  /** Whether the view is away from the bottom (ThreadPane's `!pinned`). */
  visible: boolean
  /** Puts the view at the bottom and resumes following (`useJumpNav().jumpLast`). */
  onJump: () => void
}): React.JSX.Element | null {
  const t = useT()
  if (!visible) return null
  const label = t('thread.scrollToBottom')
  return (
    <div className="scroll-bottom-host">
      <Tooltip content={label}>
        <button
          type="button"
          className="icon-button scroll-bottom-button"
          aria-label={label}
          onClick={() => {
            if (useThreads.getState().highlightEventId !== null) useThreads.setState({ highlightEventId: null })
            onJump()
          }}
        >
          <ArrowDownIcon />
        </button>
      </Tooltip>
    </div>
  )
}
