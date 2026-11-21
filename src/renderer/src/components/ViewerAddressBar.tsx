/**
 * The address bar in the file viewer's heading (TODO 970). It used to be a read-only path display (`<span className="viewer-path">`);
 * it is now a field that can always be typed into.
 *
 * - Normally shows the path of the displayed file (`~/…`). Click selects it all; type and press Enter to open. Esc discards what was typed and restores.
 * - Dispatch is by `viewerAddressTarget` (`@shared/viewer-address.ts`). A URL **adds a Web tab** and opens there (same as a plain click on a link in
 *   an answer, `openExternalLink`. The file stays in the history, back returns to it, and the draft stays in the table); a path goes through the same
 *   `openLinkHref` as links in the body (relative paths are based on the folder of the displayed file). **Main re-validates both** (a URL by `isWebViewerUrl`, a path by
 *   the choke point of `fs.resolveLink` = `FsAccess.assertAllowed` and existence). If it cannot be opened, the reason goes to the band at the top of the window (the existing band for paths;
 *   schemes other than http(s) are refused here).
 * - Right-click is the path menu as before (TODO 299). The symlink target (TODO 558) is attached next to it by the caller.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { viewerAddressTarget } from '@shared/viewer-address.js'
import { displayPath } from '@shared/uri.js'
import { notify, openExternalLink, openLinkHref } from '../markdown-link.js'
import { useT } from '../i18n/index.js'

export function ViewerAddressBar({
  uri,
  homeUri,
  onContextMenu
}: {
  readonly uri: string
  readonly homeUri: string
  readonly onContextMenu: (event: React.MouseEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const t = useT()
  const input = useRef<HTMLInputElement | null>(null)
  /** What is being typed (null = not typing; show the displayed path). */
  const [address, setAddress] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const shown = displayPath(uri, homeUri)

  // When we move to another file, discard what was being typed. Keep it while typing (the field has focus) (same as the Web URL field, TODO 554).
  useEffect(() => {
    if (input.current !== null && document.activeElement === input.current) return
    setAddress(null)
    setInvalid(false)
  }, [uri])

  const reset = useCallback(() => {
    setAddress(null)
    setInvalid(false)
  }, [])

  const submit = useCallback(() => {
    if (address === null) return
    const target = viewerAddressTarget(address)
    if (target.kind === 'none') {
      reset()
      return
    }
    if (target.kind === 'unsupported') {
      setInvalid(true)
      notify(t('viewer.address.unsupported'))
      return
    }
    reset()
    input.current?.blur()
    if (target.kind === 'web') openExternalLink(target.url)
    else if (target.kind === 'hostOrPath') {
      // Try it as a path first (line and anchor are also the same as links in the body); if it does not exist, open it on the Web as a host name.
      openLinkHref(target.href, uri, {}, () => openExternalLink(target.url))
    } else if (target.href !== shown) openLinkHref(target.href, uri)
  }, [address, reset, shown, t, uri])

  return (
    <input
      ref={input}
      type="text"
      className={`viewer-path viewer-address${invalid ? ' invalid' : ''}`}
      value={address ?? shown}
      title={shown}
      placeholder={t('viewer.address.placeholder')}
      aria-label={t('viewer.address.label')}
      aria-invalid={invalid}
      spellCheck={false}
      autoComplete="off"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        setAddress(event.target.value)
        setInvalid(false)
      }}
      onBlur={reset}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          reset()
          event.currentTarget.blur()
        }
      }}
      onContextMenu={onContextMenu}
    />
  )
}
