/**
 * The signal that copying succeeded (5.1.2, T17). Swapped with `CopyIcon` for only 1.5 seconds after pressing.
 * No toast is shown. Color is `currentColor` only (7.4.1).
 */
export function CheckIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}
