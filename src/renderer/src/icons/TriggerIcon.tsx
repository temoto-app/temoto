/**
 * Trigger (TODO 1216, 6.2.6): a lightning bolt. Marks rows in the thread list (the same family as the scheduled-run ⏰) and
 * heads the "Trigger" section of the scheduled-run view. Like the other icons: viewBox 24, stroke width 1.5, round caps,
 * color only via `currentColor` (7.4.1). `size` exists for the small mark in list rows (default 24).
 */
export function TriggerIcon({ size = 24 }: { size?: number }): React.JSX.Element {
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
      <path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z" />
    </svg>
  )
}
