/** Import (TODO 676, "Import from Chrome" in the Sidebar's Favorite heading). Color is `currentColor` only (7.4.1). */
export function ImportIcon({ size = 16 }: { readonly size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2 V9.5" />
      <path d="M5 7 L8 10 L11 7" />
      <path d="M3 11.5 V13 H13 V11.5" />
    </svg>
  )
}
