/**
 * A plugin's icon (TODO 524). Shown in the extension view row (28) and the detail heading (56).
 *
 * - The URL is `aios-plugin://<id>/<icon>`, which main checked at load time (`PluginSummary.iconUrl`).
 * - **Drawn with `<img>`** (SVG is not inlined). An SVG in an `<img>` runs no script and loads nothing external.
 * - When missing or unreadable (404 / broken image), the default `ExtensionsIcon` is used.
 */
import { useEffect, useState } from 'react'
import { ExtensionsIcon } from '../icons/ExtensionsIcon.js'

export function PluginIcon({
  url,
  size
}: {
  readonly url: string | null
  readonly size: number
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (url === null || failed) return <ExtensionsIcon size={size} />
  return (
    <img
      className="plugin-icon"
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
