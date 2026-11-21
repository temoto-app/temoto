/**
 * "Show hidden files" (TODO 261). An eye icon. A slash is added while they are not shown.
 * Color is `currentColor` only (7.4.1).
 */
export function HiddenFilesIcon({ shown }: { readonly shown: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
      {shown ? null : <path d="M4 20L20 4" />}
    </svg>
  )
}
