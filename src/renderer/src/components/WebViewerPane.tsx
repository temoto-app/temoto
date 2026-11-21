/**
 * The web page of ViewerPane (TODO 400, ARCHITECTURE 5.2.1).
 *
 * **The page is not drawn in this DOM.** A `WebContentsView` held by main (sandbox, no preload, a dedicated
 * `persist:aios-web` session) is overlaid on this component's body rectangle (`.web-viewer-body`). What this holds is only
 * the heading (back / forward, host name and URL, reload, open in browser, x), the in-page search field, and the rectangle sync.
 * It does not go through a plugin (the review note of TODO 400: the component that shows the page is our own code, and there is nothing a Broker in between
 * could protect. Isolation is done by the view's settings).
 *
 * - **The URL is `selectedUri`.** History (TODO 369) and memory (item 63) ride in the same column as files. Navigation inside the page
 *   receives main's `navigated` and does `select(url, { replace })` (replacing does not add a step).
 * - **It also loads on memory restore** (TODO 812; the default of TODO 411, "do not load on restore", was removed). `viewerDeferred` (shows only the heading and "Load") is used only when `select` is passed `deferLoad`.
 * - **For stacking order, hide** (`web-cover.ts`): while overlay UI overlaps the page the view is hidden and a snapshot taken before hiding is placed.
 * - When the page has focus keys do not reach the renderer, so for Cmd+F and so on main sends them back with `before-input-event`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebCloseReason, WebViewEvent } from '@shared/web-view.js'
import { webHostOf } from '@shared/web-view.js'
import { useStore } from '../store.js'
import { useT } from '../i18n/index.js'
import { useViewerAccentStyle } from '../viewer-accent.js'
import { Tooltip } from './Tooltip.js'
import { OpenExternalIcon } from '../icons/OpenExternalIcon.js'
import { WebReloadIcon } from '../icons/WebReloadIcon.js'
import { ComposerStopIcon } from '../icons/ComposerStopIcon.js'
import { JumpPrevIcon } from '../icons/JumpPrevIcon.js'
import { JumpNextIcon } from '../icons/JumpNextIcon.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { runViewerShortcut } from '../shortcut-actions.js'
import { openLinkHref } from '../markdown-link.js'
import { onKeybindingsChanged, webViewKeyLabel, webViewShortcuts } from '../shortcuts.js'
import { keyPlatformOf } from '../composer-keys.js'
import { collectCovers, coverTarget, shouldHideWebView, watchCovers } from '../web-cover.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { WEB_BLANK_URL, isLocalPathInput, normalizeAddress } from '@shared/web-tabs.js'
import { activeTabTitle, isFavoriteUrl, toggleFavorite, useWeb } from '../webStore.js'
import { StarIcon } from '../icons/StarIcon.js'
import { UNTRUSTABLE_CERTIFICATE, isCertificateError, type WebCertificateStatus } from '@shared/web-certs.js'

const PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

/**
 * TODO 580: the marker that the pane is closed with x. If set, on detaching `web.close('close')` (main closes all the views); if
 * not set, `hide` (e.g. switched to a file; main hides the view and keeps it alive, and closes it if there is no return in 10 minutes).
 * The reason a component detaches cannot be known from effect cleanup, so the closing side sets it right before `select(null)`.
 */
let closingByUser = false

/** Called right before closing the Web pane with x (TODO 580). */
export function markWebPaneClosing(): void {
  closingByUser = true
}

interface FindState {
  readonly open: boolean
  readonly text: string
  readonly matches: number | null
  readonly active: number
}

const CLOSED_FIND: FindState = { open: false, text: '', matches: null, active: 0 }

type Failure =
  | { readonly kind: 'failed'; readonly code: number; readonly url: string }
  | { readonly kind: 'gone' }

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function WebViewerPane({
  uri,
  nav,
  close
}: {
  readonly uri: string
  /** The back / forward buttons (ViewerPane's are used as is). */
  readonly nav: React.ReactNode
  /** x (ViewerPane's). */
  readonly close: React.ReactNode
}): React.JSX.Element {
  const t = useT()
  const accent = useViewerAccentStyle()
  const deferred = useStore((state) => state.viewerDeferred)
  const transient = useStore((state) => state.transient)
  /** A blank tab (TODO 522). No page is loaded, the view is hidden, and only the URL field is shown. */
  const blank = uri === WEB_BLANK_URL
  const favorite = useWeb((state) => isFavoriteUrl(state.favorites, uri))
  const activeTabId = useWeb((state) => state.tabs.activeId)
  const focusAddress = useWeb((state) => state.focusAddress)
  const addressInput = useRef<HTMLInputElement | null>(null)
  /** What was being typed in the URL field (null = not typing; show the current URL). */
  const [address, setAddress] = useState<string | null>(null)
  const [addressInvalid, setAddressInvalid] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const findInput = useRef<HTMLInputElement | null>(null)
  /** The URL the view is showing now (that it was told to load). If the same as `selectedUri`, it is not reloaded. */
  const viewUrl = useRef<string | null>(null)
  /** The id of the current tab at the time `viewUrl` was loaded. */
  const viewTab = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  /** TODO 547: if the failure is a certificate error, whether that host's certificate can be made an exception (whether main remembers the certificate it refused). */
  const [certificate, setCertificate] = useState<WebCertificateStatus>(UNTRUSTABLE_CERTIFICATE)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [find, setFind] = useState<FindState>(CLOSED_FIND)

  // Sync of the rectangle and show / hide. The latest state is fetched with refs (the watcher's listener is not recreated).
  const lastRect = useRef<Rect | null>(null)
  const visible = useRef(false)
  const blocked = useRef(true)
  blocked.current = deferred || transient !== null || blank
  /** TODO 1221: whether the Web content is full screen (main's `fullscreen` notice). The overlay decision is made for the whole window. */
  const fullscreen = useRef(false)

  const sync = useCallback(() => {
    const element = body.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    const rect: Rect = { x: box.left, y: box.top, width: box.width, height: box.height }
    if (!sameRect(lastRect.current, rect)) {
      lastRect.current = rect
      void window.aios.web.setBounds(rect)
    }
    const covered = shouldHideWebView(
      coverTarget(
        { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        fullscreen.current
      ),
      collectCovers(document)
    )
    const next = !blocked.current && !covered
    if (next === visible.current) return
    visible.current = next
    if (next) {
      void window.aios.web.setVisible(true, false)
      setSnapshot(null)
      return
    }
    // Only when hiding with an overlay, place the snapshot (to reduce flicker). Not needed when the pane is hidden or nothing is loaded yet.
    const wantSnapshot = !blocked.current && box.width > 0 && box.height > 0
    void window.aios.web.setVisible(false, wantSnapshot).then((image) => {
      if (!visible.current) setSnapshot(image)
    })
  }, [])

  // The table of keys to send back, and cleanup. Closed with x -> close all the views. Switched to a file, etc. -> hide and keep alive (TODO 580).
  // The table (keys that main should send back when the page has focus) is built with the current assignments and sent when the pane is shown and when the assignments change
  // (TODO 549) (TODO 589).
  useEffect(() => {
    closingByUser = false
    const sendShortcuts = (): void => void window.aios.web.setShortcuts(webViewShortcuts(PLATFORM))
    sendShortcuts()
    const stopWatching = onKeybindingsChanged(sendShortcuts)
    return () => {
      stopWatching()
      viewUrl.current = null
      viewTab.current = null
      visible.current = false
      lastRect.current = null
      const reason: WebCloseReason = closingByUser ? 'close' : 'hide'
      closingByUser = false
      void window.aios.web.close(reason)
    }
  }, [])

  // Rectangle watching: size changes, window size, overlay appearing / disappearing.
  useEffect(() => {
    const element = body.current
    if (element === null) return
    const observer = new ResizeObserver(() => sync())
    observer.observe(element)
    const stop = watchCovers(sync)
    sync()
    return () => {
      observer.disconnect()
      stop()
    }
  }, [sync])

  // When the state changes (not loading yet <-> loading, a temporary display coming / going), re-sync.
  useEffect(() => {
    sync()
  }, [deferred, transient, blank, sync])

  // When the URL changes, discard the half-typed URL field (TODO 522). But keep it while typing (the field has focus) -
  // so a redirect during loading or navigation inside the page does not wipe what was typed (TODO 554, same as a browser).
  useEffect(() => {
    if (addressInput.current !== null && document.activeElement === addressInput.current) return
    setAddress(null)
    setAddressInvalid(false)
  }, [uri])

  /** Put focus in the URL field and select everything (even if the page has focus, first return to the renderer's document). */
  const focusAddressField = useCallback(() => {
    requestAnimationFrame(() => {
      window.focus()
      addressInput.current?.focus()
      addressInput.current?.select()
    })
  }, [])

  // Put focus in the URL field on a signal (`focusAddress`, a new blank tab / Cmd+L - TODO 522 / 554).
  const seenFocus = useRef(focusAddress)
  useEffect(() => {
    if (seenFocus.current === focusAddress) return
    seenFocus.current = focusAddress
    focusAddressField()
  }, [focusAddress, focusAddressField])

  // When a blank tab is shown, go to the URL field (TODO 554). If + is pressed in a pane that was showing a file, this component is
  // created after the signal, so the signal above alone did not put focus there.
  useEffect(() => {
    if (blank) focusAddressField()
  }, [blank, focusAddressField])

  // Load when the URL changes (nothing if the view is already showing that URL). A blank tab is not loaded.
  // If the current tab changed, load even with the same URL (the same page opened in another tab: so that main's `willLoad` makes the destination of
  // the view's notices the new tab - code-review 2026-10-08). What was loaded while the tab id was not yet known
  // takes over the first id learned (no reload on restore at startup).
  useEffect(() => {
    if (deferred || blank) return
    if (viewUrl.current === uri && (viewTab.current === null || viewTab.current === activeTabId)) {
      viewTab.current = activeTabId
      return
    }
    // 598-4: the current tab changed, but the new current tab's URL differs from the URL being shown - either right after the current tab was closed
    // (main's `onTabsChanged` notice arrives before the `select` of `closeWebTab`) or in the middle of moving to another tab. If we loaded here,
    // the closed page's URL would be loaded in main's new current tab (the right neighbor), swapping the right neighbor out. Wait for the following `select`.
    if (viewUrl.current === uri && activeTabId !== null) {
      const active = useWeb.getState().tabs.tabs.find((tab) => tab.id === activeTabId)
      if (active !== undefined && active.url !== uri) return
    }
    viewUrl.current = uri
    viewTab.current = activeTabId
    setFailure(null)
    setFind(CLOSED_FIND)
    void window.aios.web.load(uri)
  }, [uri, deferred, blank, activeTabId])

  /** Enter in the URL field: if it is a loadable URL, open it in the current tab (TODO 522). If the same URL, reload. */
  const submitAddress = useCallback(() => {
    if (address === null) return
    // A file path (`/Users/…`, `~/…`, TODO 771) is opened in the viewer. How it is resolved and the choke point are main's (`fs.resolveLink`).
    if (isLocalPathInput(address)) {
      setAddress(null)
      setAddressInvalid(false)
      addressInput.current?.blur()
      openLinkHref(address.trim(), null)
      return
    }
    const url = normalizeAddress(address)
    if (url === null) {
      setAddressInvalid(true)
      return
    }
    setAddress(null)
    setAddressInvalid(false)
    addressInput.current?.blur()
    if (url === uri) {
      if (viewUrl.current === null) {
        viewUrl.current = uri
        void window.aios.web.load(uri)
      } else void window.aios.web.reload()
      return
    }
    useStore.getState().select(url)
  }, [address, uri])

  const openFind = useCallback(() => {
    setFind((state) => ({ ...state, open: true }))
    // Focus after showing the field (return focus to the renderer's document).
    requestAnimationFrame(() => {
      window.focus()
      findInput.current?.focus()
      findInput.current?.select()
    })
  }, [])

  // Notices from main.
  useEffect(
    () =>
      window.aios.web.onEvent((event: WebViewEvent) => {
        switch (event.kind) {
          case 'navigated': {
            viewUrl.current = event.url
            setFailure(null)
            const state = useStore.getState()
            if (state.selectedUri !== event.url) state.select(event.url, { replace: event.replace })
            return
          }
          case 'loading':
            setLoading(event.loading)
            return
          case 'failed':
            setFailure({ kind: 'failed', code: event.code, url: event.url })
            return
          case 'gone':
            setFailure({ kind: 'gone' })
            return
          case 'found':
            setFind((state) => (state.open ? { ...state, matches: event.matches, active: event.active } : state))
            return
          case 'shortcut':
            if (event.id === 'webFind') openFind()
            else if (event.id === 'webReload') void window.aios.web.reload()
            else runViewerShortcut(event.id)
            return
          case 'fullscreen':
            // TODO 1221: entering / leaving full screen. The range of the overlay decision changes, so re-sync.
            fullscreen.current = event.mode !== null
            sync()
            return
        }
      }),
    [openFind, sync]
  )

  const runFind = useCallback((text: string, forward: boolean, findNext: boolean) => {
    if (text === '') {
      void window.aios.web.stopFind()
      setFind((state) => ({ ...state, matches: null, active: 0 }))
      return
    }
    void window.aios.web.find({ text, forward, findNext })
  }, [])

  const closeFind = useCallback(() => {
    void window.aios.web.stopFind()
    setFind(CLOSED_FIND)
    void window.aios.web.focus()
  }, [])

  const loadNow = useCallback(() => {
    useStore.setState({ viewerDeferred: false })
  }, [])

  const reload = useCallback(() => {
    setFailure(null)
    if (viewUrl.current === null) {
      // Not loaded yet (including right after a load failure) -> load the current URL.
      viewUrl.current = uri
      void window.aios.web.load(uri)
    } else void window.aios.web.reload()
  }, [uri])

  // TODO 547: if it failed with a certificate error, ask main whether it can be made an exception (to decide whether to show the band's button).
  useEffect(() => {
    setCertificate(UNTRUSTABLE_CERTIFICATE)
    if (failure?.kind !== 'failed' || !isCertificateError(failure.code)) return
    let live = true
    void window.aios.web.certificateStatus(failure.url).then(
      (status) => {
        if (live) setCertificate(status)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [failure])

  /** "Trust this host's certificate": main remembers the certificate it just refused, and reloads. */
  const trustCertificate = useCallback(() => {
    if (failure?.kind !== 'failed') return
    const url = failure.url
    void window.aios.web.trustCertificate(url).then((trusted) => {
      if (!trusted) {
        setCertificate(UNTRUSTABLE_CERTIFICATE)
        return
      }
      setFailure(null)
      viewUrl.current = url
      void window.aios.web.load(url)
    })
  }, [failure])

  const host = blank ? '' : (webHostOf(uri) ?? uri)
  const findLabel = `${t('web.find.placeholder')} (${webViewKeyLabel('webFind', PLATFORM)})`
  const starLabel = t(favorite ? 'web.favorites.remove' : 'web.favorites.add')

  return (
    <div className="viewer-pane web-viewer-pane">
      <div className="viewer-header" style={accent}>
        {nav}
        <span className="viewer-path web-viewer-address" title={blank ? undefined : uri}>
          {host === '' ? null : <span className="web-viewer-host">{host}</span>}
          {/* TODO 522 / 554 / 691: the URL field. Type and press Enter to open in the current tab (main re-validates); Esc restores.
              In 691 words that are not URLs now go to a Google search, so the Latin-input marker of 556 was removed
              (it got in the way of searching in Japanese). */}
          <input
            ref={addressInput}
            type="text"
            className={`web-viewer-url web-address-input${addressInvalid ? ' invalid' : ''}`}
            value={address ?? (blank ? '' : uri)}
            placeholder={t('web.address.placeholder')}
            aria-label={t('web.address.label')}
            aria-invalid={addressInvalid}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setAddress(event.target.value)
              setAddressInvalid(false)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submitAddress()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setAddress(null)
                setAddressInvalid(false)
                event.currentTarget.blur()
              }
            }}
          />
        </span>
        <span className="viewer-spacer" />
        {blank ? null : (
          // TODO 522: the Favorite star (to the right of the URL field, as in Chrome).
          <Tooltip content={starLabel}>
            <button
              type="button"
              className={`icon-button web-viewer-star${favorite ? ' active' : ''}`}
              aria-label={starLabel}
              aria-pressed={favorite}
              onClick={() => toggleFavorite(uri, activeTabTitle(useWeb.getState(), uri))}
            >
              <StarIcon filled={favorite} />
            </button>
          </Tooltip>
        )}
        {blank ? null : loading ? (
          <Tooltip content={t('web.stop')}>
            <button
              type="button"
              className="icon-button web-viewer-stop"
              onClick={() => void window.aios.web.stop()}
              aria-label={t('web.stop')}
            >
              <ComposerStopIcon />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content={`${t('web.reload')} (${webViewKeyLabel('webReload', PLATFORM)})`}>
            <button
              type="button"
              className="icon-button web-viewer-reload"
              onClick={deferred ? loadNow : reload}
              aria-label={t('web.reload')}
            >
              <WebReloadIcon />
            </button>
          </Tooltip>
        )}
        {blank ? null : (
          <Tooltip content={t('web.openInBrowser')}>
            <button
              type="button"
              className="icon-button web-viewer-external"
              onClick={() => void window.aios.app.openExternal(uri)}
              aria-label={t('web.openInBrowser')}
            >
              <OpenExternalIcon />
            </button>
          </Tooltip>
        )}
        {close}
      </div>
      {find.open ? (
        <div className="web-find-bar" role="search">
          <input
            ref={findInput}
            type="search"
            {...ASCII_INPUT}
            className="web-find-input"
            value={find.text}
            placeholder={findLabel}
            aria-label={findLabel}
            onChange={(event) => {
              const text = event.target.value
              setFind((state) => ({ ...state, text }))
              runFind(text, true, true)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                runFind(find.text, !event.shiftKey, false)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
              }
            }}
          />
          <span className="web-find-count">
            {find.matches === null ? '' : find.matches === 0 ? t('web.find.none') : `${find.active}/${find.matches}`}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => runFind(find.text, false, false)}
            aria-label={t('web.find.prev')}
          >
            <JumpPrevIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => runFind(find.text, true, false)}
            aria-label={t('web.find.next')}
          >
            <JumpNextIcon />
          </button>
          <button type="button" className="icon-button" onClick={closeFind} aria-label={t('web.find.close')}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
      {failure !== null ? (
        <div className="viewer-banner error web-viewer-failed" role="alert">
          <span>
            {failure.kind === 'gone'
              ? t('web.gone')
              : certificate.trustable
                ? t(certificate.changed ? 'web.cert.changed' : 'web.cert.failed', {
                    host: webHostOf(failure.url) ?? failure.url,
                    code: failure.code
                  })
                : t('web.failed', { code: failure.code })}
          </span>
          {/* TODO 547: certificate exception (no new dialog; a button inside the band). */}
          {failure.kind === 'failed' && certificate.trustable ? (
            <button type="button" className="web-cert-trust" onClick={trustCertificate}>
              {t('web.cert.trust')}
            </button>
          ) : null}
          {failure.kind === 'failed' ? (
            <button
              type="button"
              className="web-failed-external"
              onClick={() => void window.aios.app.openExternal(failure.url)}
            >
              {t('web.openInBrowser')}
            </button>
          ) : null}
          <button type="button" onClick={reload}>
            {t('web.reload')}
          </button>
        </div>
      ) : null}
      <div className="viewer-body web-viewer-body" ref={body} data-testid="web-viewer-body">
        {blank ? (
          <div className="web-viewer-deferred web-viewer-blank">
            <span>{t('web.blank')}</span>
          </div>
        ) : deferred ? (
          <div className="web-viewer-deferred">
            <span>{t('web.deferred')}</span>
            <button type="button" onClick={loadNow}>
              {t('web.load')}
            </button>
          </div>
        ) : snapshot !== null ? (
          <img className="web-viewer-snapshot" src={snapshot} alt="" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  )
}
