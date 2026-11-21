/**
 * Icons for sorting the thread list (item 152). Inline SVG like the vertical icon bar (5.3), and
 * color is `currentColor` only (7.4.1: as a `.svg` file the color would fall outside the check).
 * 14px, viewBox 16, stroke width 1.5, to fit inside the segment.
 */
function SortSvg({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Sort by update: a clock. */
export function SortRecentIcon(): React.JSX.Element {
  return (
    <SortSvg>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </SortSvg>
  )
}

/** Sort by unread: rows with a dot at the start (the higher the row, the stronger). */
export function SortUnreadIcon(): React.JSX.Element {
  return (
    <SortSvg>
      <circle cx="3.25" cy="4" r="1.25" fill="currentColor" stroke="none" />
      <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    </SortSvg>
  )
}

/** Sort by cwd: a folder. */
export function SortFolderIcon(): React.JSX.Element {
  return (
    <SortSvg>
      <path d="M2 4.25h4.25l1.5 1.5H14v6.5H2z" />
    </SortSvg>
  )
}
