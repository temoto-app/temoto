/**
 * The title bar's viewer toggle (TODO 1327). VS Code's `layout-sidebar-right` (the Secondary Side Bar; in aios that is ViewerPane):
 * a window outline with the right column; **the column is filled while the viewer is shown** and only outlined while it is hidden.
 * Inline SVG, color only via `currentColor` (7.4.1).
 */
export function LayoutViewerIcon({ shown }: { readonly shown: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shown ? <path d="M15 4.5h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4z" fill="currentColor" stroke="none" /> : null}
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M15 4.5v15" />
    </svg>
  )
}
