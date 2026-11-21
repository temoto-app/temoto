/**
 * Reserve (item 154; a send during a response is sent after the current response ends, item 94). Item 374 (owner decision
 * 2026-10-03) dropped the clock shape: a reservation is not "run at a given time" but "waiting in turn", so a send arrow (up arrow) is added
 * to the right of three lines (≡) that represent a queue. It pairs with the adjacent interrupt (`ComposerInterruptIcon`, ■ + up arrow) because it is
 * built the same way: "left = what to do about the current response, right = send". The clock is also used by TODO 372 (scheduled runs) and
 * the thread list's sort "Recent" (`SortRecentIcon`), so it is not kept for reserve. Color is
 * `currentColor` only (7.4.1).
 */
export function ComposerQueueIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 8h7M4 12h7M4 16h7" />
      <path d="M18 20V11" />
      <path d="M14.5 14.5L18 11l3.5 3.5" />
    </svg>
  )
}
