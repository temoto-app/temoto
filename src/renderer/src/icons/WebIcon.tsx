/**
 * Web (vertical icon bar, 5.3, TODO 522). A circle for a browser (Chromium): a small center circle and a ring around it
 * divided by 3 chords. **Do not imitate any specific product's trademark shape** (no color either, only `currentColor`, 7.4.1).
 * Also used small as the default mark in tab rows when there is no favicon.
 */
export function WebIcon({ size = 24 }: { readonly size?: number } = {}): React.JSX.Element {
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
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8 H19.6" />
      <path d="M9.2 13.6 L5.4 7" />
      <path d="M14.8 13.6 L11 20.4" />
    </svg>
  )
}
