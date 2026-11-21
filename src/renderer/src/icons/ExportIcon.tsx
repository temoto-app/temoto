/**
 * Export a conversation (TODO 818 / 864 / 865 / 866). A document with a folded corner and a downward arrow inside it (= save to a file).
 * Shared by the heading's export button and the hover button on one's own message. Color is `currentColor` only (7.4.1).
 */
export function ExportIcon({ size = 14 }: { readonly size?: number } = {}): React.JSX.Element {
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
      <path d="M9.5 1.75 H4 a1 1 0 0 0 -1 1 V13.25 a1 1 0 0 0 1 1 H12 a1 1 0 0 0 1 -1 V5.25 Z" />
      <path d="M9.5 1.75 V5.25 H13" />
      <path d="M8 7 V11.75" />
      <path d="M5.9 9.75 L8 11.85 L10.1 9.75" />
    </svg>
  )
}
