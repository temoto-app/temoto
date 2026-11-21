/**
 * Open the viewer (TODO 771 / 865). A window frame with a pane opening on the right (modeled on VS Code's "Split Editor Right").
 * Color only via `currentColor` (7.4.1).
 */
export function ViewerOpenIcon({ size = 16 }: { readonly size?: number } = {}): React.JSX.Element {
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
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="M8.5 2.75 V13.25" />
      <path d="M10.4 8 H12.4" />
      <path d="M11.4 7 V9" />
    </svg>
  )
}
