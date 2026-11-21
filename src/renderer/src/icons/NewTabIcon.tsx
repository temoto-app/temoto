/** The "+" for a new tab (TODO 522, the Sidebar's "Open tabs" heading). Color is `currentColor` only (7.4.1). */
export function NewTabIcon({ size = 16 }: { readonly size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3 V13" />
      <path d="M3 8 H13" />
    </svg>
  )
}
