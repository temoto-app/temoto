/**
 * Open with another viewer (TODO 907, VS Code's Reopen Editor With…). Two overlapping pages and a swap arrow.
 * Color is `currentColor` only (7.4.1).
 */
export function ReopenWithIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="1.75" width="8" height="10" rx="1" />
      <path d="M11.75 4.25 H13.25 A1 1 0 0 1 14.25 5.25 V13.25 A1 1 0 0 1 13.25 14.25 H7.25 A1 1 0 0 1 6.25 13.25 V13.75" />
      <path d="M4 6.75 H7.5" />
      <path d="M6.25 5.25 L7.75 6.75 L6.25 8.25" />
    </svg>
  )
}
