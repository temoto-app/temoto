/**
 * Teammate (TODO 972: a role): a person - a head and shoulders. Heads the "Teammates" section and the role headings of the thread
 * list. Like the other icons: viewBox 24, stroke width 1.5, round caps, color only via `currentColor` (7.4.1). `size` defaults to 24.
 */
export function TeammateIcon({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6" />
    </svg>
  )
}
