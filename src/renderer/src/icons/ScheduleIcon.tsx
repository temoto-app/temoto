/**
 * Scheduled runs (vertical icon bar, TODO 372). **An alarm clock**: two bells on top and two legs below.
 * The thread list's sort "Recent" (`SortRecentIcon`) is a plain clock, so this was given a shape that can be told apart from it
 * (the same meaning as the ⏰ mark on scheduled-run threads). As with the other icons, viewBox 24, stroke width 1.5, round ends,
 * and color is `currentColor` only (7.4.1).
 */
export function ScheduleIcon(): React.JSX.Element {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="13.5" r="7" />
      <path d="M12 10v3.5l2.5 1.5" />
      {/* The bells (left and right). A hat shape closed by an arc and a chord. */}
      <path d="M2.9 7.4a4.2 4.2 0 0 1 4.5-4.5z" />
      <path d="M21.1 7.4a4.2 4.2 0 0 0-4.5-4.5z" />
      {/* The legs. */}
      <path d="M7 19.5 5.5 21.5M17 19.5l1.5 2" />
    </svg>
  )
}
