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
 * - TODO 1298: while typing, a drop-down offers file names inside the conversation's working folder (the ⌘P search scoped
 *   to the cwd) and one "Search Google for …" row. Rules in `viewer-address-suggest.ts`. ↑ / ↓ pick, Enter opens the
 *   picked row (nothing picked = what was typed, as before), Esc first closes the drop-down and keeps the input.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { viewerAddressTarget } from '@shared/viewer-address.js'
import { displayPath } from '@shared/uri.js'
import type { FileSearchResult } from '@shared/types.js'
import { notify, openExternalLink, openLinkHref } from '../markdown-link.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { selectActiveCwd } from '../active-cwd.js'
import { useSearch } from '../searchStore.js'
import {
  addressFileRows,
  addressSuggestQuery,
  addressSuggestions,
  moveAddressCursor,
  type AddressSuggestion
} from '../viewer-address-suggest.js'

/** Delay from the last keystroke to the lookup (same as the `@` completion). */
const SUGGEST_DEBOUNCE_MS = 120
/** Asked from the index: more than shown, since folders are dropped. */
const SUGGEST_FETCH_LIMIT = 24

/**
 * File rows for `query` inside `cwdUri` (TODO 1298). Empty when either is missing. Overtaken and cancelled answers are
 * dropped; while a lookup is in flight the previous rows stay (no flicker).
 */
function useAddressFileRows(query: string | null, cwdUri: string | null): readonly AddressSuggestion[] {
  const [rows, setRows] = useState<readonly AddressSuggestion[]>([])
  const request = useRef(0)
  useEffect(() => {
    request.current += 1
    const mine = request.current
    const search = typeof window === 'undefined' ? undefined : window.aios?.fs?.searchFiles
    if (query === null || cwdUri === null || search === undefined) {
      setRows([])
      return
    }
    const timer = setTimeout(() => {
      // The cwd is the scope: only that subtree is searched (main and the index process validate it; 0 hits if it does not pass).
      void search(query, SUGGEST_FETCH_LIMIT, null, cwdUri)
        .then((result: FileSearchResult) => {
          useSearch.getState().noteIndexAnswered()
          if (mine !== request.current) return
          setRows(result.cancelled ? [] : addressFileRows(result.entries, cwdUri))
        })
        .catch((err: unknown) => {
          if (mine === request.current) setRows([])
          useSearch.getState().noteIndexError(err)
        })
    }, SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, cwdUri])
  return query === null || cwdUri === null ? [] : rows
}

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
  // TODO 1298: the completion drop-down. `menuClosed` is Esc's first press (the input stays); typing opens it again.
  const cwdUri = useThreads(selectActiveCwd)
  const [menuClosed, setMenuClosed] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const query = menuClosed ? null : addressSuggestQuery(address)
  const fileRows = useAddressFileRows(query, cwdUri)
  const suggestions = query === null ? [] : addressSuggestions(query, fileRows)
  const picked = cursor >= 0 && cursor < suggestions.length ? suggestions[cursor] : undefined
  const listId = useId()

  // When we move to another file, discard what was being typed. Keep it while typing (the field has focus) (same as the Web URL field, TODO 554).
  useEffect(() => {
    if (input.current !== null && document.activeElement === input.current) return
    setAddress(null)
    setInvalid(false)
  }, [uri])

  const reset = useCallback(() => {
    setAddress(null)
    setInvalid(false)
    setMenuClosed(false)
    setCursor(-1)
  }, [])

  /** A drop-down row was chosen (TODO 1298). A file opens like a path typed in (the band shows why if it cannot); Google opens a Web tab. */
  const choose = useCallback(
    (suggestion: AddressSuggestion) => {
      reset()
      input.current?.blur()
      if (suggestion.kind === 'google') openExternalLink(suggestion.url)
      else if (suggestion.uri !== uri) openLinkHref(suggestion.uri, uri)
    },
    [reset, uri]
  )

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

  const menuOpen = suggestions.length > 0

  return (
    <span className="viewer-address-wrap">
      <input
        ref={input}
        type="text"
        className={`viewer-path viewer-address${invalid ? ' invalid' : ''}`}
        value={address ?? shown}
        title={shown}
        placeholder={t('viewer.address.placeholder')}
        aria-label={t('viewer.address.label')}
        aria-invalid={invalid}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listId : undefined}
        aria-activedescendant={picked === undefined ? undefined : `${listId}-${cursor}`}
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setAddress(event.target.value)
          setInvalid(false)
          setMenuClosed(false)
          setCursor(-1)
        }}
        onBlur={reset}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menuOpen) {
            event.preventDefault()
            setCursor((now) => moveAddressCursor(now, suggestions.length, event.key === 'ArrowDown' ? 1 : -1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (picked !== undefined) choose(picked)
            else submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            // The first Esc closes the drop-down and keeps what was typed; the next one discards it (as before).
            if (menuOpen) {
              setMenuClosed(true)
              setCursor(-1)
              return
            }
            reset()
            event.currentTarget.blur()
          }
        }}
        onContextMenu={onContextMenu}
      />
      {menuOpen ? (
        <ul id={listId} className="viewer-address-menu" role="listbox" aria-label={t('viewer.address.suggestions')}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.kind === 'file' ? suggestion.uri : 'google'}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === cursor}
              className={`${suggestion.kind === 'google' ? 'address-google' : 'address-file'}${index === cursor ? ' active' : ''}`}
              // Keep the focus in the field (its blur would discard the input before the click lands).
              onMouseDown={(event) => {
                event.preventDefault()
                choose(suggestion)
              }}
              onMouseEnter={() => setCursor(index)}
            >
              {suggestion.kind === 'file' ? (
                <>
                  <span className="address-name">{suggestion.name}</span>
                  {suggestion.path === '' ? null : <span className="address-path">{suggestion.path}</span>}
                </>
              ) : (
                t('viewer.address.google', { query: suggestion.query })
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  )
}
