/**
 * Open the audit log (whole) (the extension view's heading, TODO 367). Paper, lines, and a clock hand. Color is `currentColor` only (7.4.1).
 */
export function AuditLogIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 2.5h7l2.5 2.5v4" />
      <path d="M3 2.5v11h5" />
      <path d="M5 6h5M5 8.5h3" />
      <circle cx="11.5" cy="12" r="2.5" />
      <path d="M11.5 10.8V12l.8.6" />
    </svg>
  )
}
