/** Search (vertical icon bar, 5.3). A magnifying glass. Color is `currentColor` only (7.4.1). */
export function SearchIcon({ size = 24 }: { size?: number } = {}): React.JSX.Element {
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
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  )
}
