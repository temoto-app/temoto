/**
 * Help (the bottom of the vertical icon bar, above the settings gear, TODO 1174). A ? inside a circle. Color is `currentColor` only (7.4.1).
 * The drawing size matches the gear (2 to 22), the same alignment as when "New" of TODO 954 looked small: the circle spans 3 to 21.
 */
export function HelpIcon(): React.JSX.Element {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.2a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.4-2.6 4" />
      <path d="M12 17.4h.01" />
    </svg>
  )
}
