/**
 * Interrupt (items 154 / 94). The look of the small side button shown only during a response: a small send arrow (up arrow)
 * overlaid next to the stop mark (■). Color is `currentColor` only (7.4.1).
 */
export function ComposerInterruptIcon(): React.JSX.Element {
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
      <rect x="4" y="8" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
      <path d="M18 20V11" />
      <path d="M14.5 14.5L18 11l3.5 3.5" />
    </svg>
  )
}
