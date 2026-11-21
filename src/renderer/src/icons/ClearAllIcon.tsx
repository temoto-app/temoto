/** "Clear all" (TODO 522, the Sidebar history heading. As in VS Code's Clear All, a set of lines). `currentColor` only (7.4.1). */
export function ClearAllIcon({ size = 16 }: { readonly size?: number } = {}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5 H10" />
      <path d="M2.5 8 H8" />
      <path d="M2.5 11.5 H6.5" />
      <path d="M9.5 9.5 L13.5 13.5" />
      <path d="M13.5 9.5 L9.5 13.5" />
    </svg>
  )
}
