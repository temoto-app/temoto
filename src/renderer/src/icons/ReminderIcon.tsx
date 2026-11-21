/**
 * Reminder (TODO 1265, 6.2.4): a bell. Marks reminder rows (notification only, no AI) in the scheduled-run list and the editor's kind field.
 * Like the other icons: viewBox 24, stroke width 1.5, round caps, color only via `currentColor` (7.4.1). `size` is for the small mark in list rows.
 */
export function ReminderIcon({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  )
}
