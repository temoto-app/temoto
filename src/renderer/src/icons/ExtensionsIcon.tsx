/**
 * Extensions (vertical icon bar, 5.3, TODO 367). As in VS Code's Extensions: three squares and one set apart at the top right.
 * Also used as the "default icon" in list rows and detail headings (for plugins whose manifest `icon` is missing or unreadable, `PluginIcon` of TODO 368 / 524).
 * Color is `currentColor` only (7.4.1).
 */
export function ExtensionsIcon({ size = 24 }: { readonly size?: number } = {}): React.JSX.Element {
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
      <rect x="4" y="9" width="5.5" height="5.5" />
      <rect x="4" y="14.5" width="5.5" height="5.5" />
      <rect x="9.5" y="14.5" width="5.5" height="5.5" />
      <rect x="13" y="4" width="5.5" height="5.5" transform="rotate(12 15.75 6.75)" />
    </svg>
  )
}
