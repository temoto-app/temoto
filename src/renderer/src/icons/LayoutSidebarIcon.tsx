/**
 * The title bar's sidebar toggle (TODO 1327). VS Code's `layout-sidebar-left`: a window outline with the left column;
 * **the column is filled while the sidebar is shown** and only outlined while it is hidden (the same cue as VS Code).
 * Inline SVG, color only via `currentColor` (7.4.1).
 */
export function LayoutSidebarIcon({ shown }: { readonly shown: boolean }): React.JSX.Element {
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
      {shown ? <path d="M5 4.5h4v15H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z" fill="currentColor" stroke="none" /> : null}
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </svg>
  )
}
