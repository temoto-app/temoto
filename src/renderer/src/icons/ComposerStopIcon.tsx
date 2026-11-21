/**
 * Stop (item 161, 4.5.4). A single rounded square (■). It sits in the primary button next to the send up arrow, and which one is shown is decided by
 * CSS (`.composer-send[data-kind]`); the button is not rebuilt. Color is `currentColor` only (7.4.1);
 * the red background (`--danger`) and the white of the shape (`--danger-on`) belong to the button's CSS.
 */
export function ComposerStopIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  )
}
