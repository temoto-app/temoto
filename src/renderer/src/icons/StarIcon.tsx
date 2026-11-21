/**
 * The Favorite star (TODO 522, the web heading of ViewerPane). Filled if `filled` (registered). Color is `currentColor` only (7.4.1).
 */
export function StarIcon({ filled = false, size = 16 }: { readonly filled?: boolean; readonly size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.8 L9.85 5.6 L14 6.2 L11 9.1 L11.7 13.2 L8 11.25 L4.3 13.2 L5 9.1 L2 6.2 L6.15 5.6 Z" />
    </svg>
  )
}
