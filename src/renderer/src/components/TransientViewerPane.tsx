/**
 * A temporary display with no URI (ARCHITECTURE.md 7.4.6, item 104). Draws a diff in the plugin (`aios.diff`) iframe.
 * In TODO 905, files inside an archive (zip) are also drawn in the same frame (the viewer iframe resolved by the name's extension).
 * The extension details / audit log added here in TODO 367 were moved in TODO 458 to the ThreadPane location (`mainPanel.ts`).
 *
 * Inside ViewerPane, it is drawn only while `useStore().transient` is set. The file's viewer
 * (`selectedUri`) stays alive hidden behind, and clearing `transient` with x brings it back as it was
 * (the draft is not lost either). **It does not write to the per-thread memory (item 63)**: the memory's listener
 * watches only `selectedUri`, so a display going through here is structurally never recorded.
 *
 * It asks main (`viewer.openPayload` / `viewer.openTransientFile`) to resolve the viewer, but **grants no permission to read files**.
 * The content (the before / after pair, or bytes extracted from an archive) is passed directly from here over a port, so the viewer reads
 * nothing (constraint 8). The body is passed only for display, and is neither saved nor indexed (constraints 9 / 10).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DiffPayload, ResolvedViewer, ViewerHostMessage, ViewerImageConversion, ViewerWirePayload } from '@shared/plugin.js'
import { useStore, type HelpView, type TransientView } from '../store.js'
import { useTheme } from '../themeStore.js'
import { useLocale } from '../localeStore.js'
import { useKeybindings } from '../keybindingStore.js'
import { useT } from '../i18n/index.js'
import { useViewerAccentStyle } from '../viewer-accent.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { runViewerShortcut, viewerShortcuts } from '../shortcut-actions.js'
import {
  acceptOpenEntry,
  transientFileLabel,
  transientFilePayload,
  wireResource,
  type TransientFileView
} from '../transient-file.js'
import { isHeifName, transientFileBaseName } from '@shared/transient-file.js'
import { acceptViewerSelection } from '../viewer-selection.js'
import { Tooltip } from './Tooltip.js'
import { acceptViewModes, showsViewModes, type ViewerViewMode, type ViewModesReport } from '@shared/viewer-view-mode.js'
import { ViewerModeSwitch } from './ViewerModeSwitch.js'
import { parseHelpUri, prepareHelpDocument, type HelpDocument } from '@shared/help.js'

/** The head of the identifier of a temporary diff display (TODO 1091 item 2). Not a URI; only an addressing marker between host and viewer. */
const TRANSIENT_DIFF_URI_PREFIX = 'aios-transient:diff/'

/** The name shown in the heading. If both sides have the same name, that one name. */
export function diffLabel(payload: DiffPayload): string {
  const { before, after } = payload
  return before.name === after.name ? after.name : `${before.name} → ${after.name}`
}

export function TransientViewerPane({
  transient
}: {
  readonly transient: TransientView
}): React.JSX.Element {
  if (transient.kind === 'help') return <HelpTransientPane transient={transient} />
  return transient.kind === 'file' ? <FileTransientPane transient={transient} /> : <DiffTransientPane transient={transient} />
}

/**
 * Help (TODO 1174, ARCHITECTURE.md 7.4.13). Main reads the bundled HTML and returns the body (`help.open`, only a URI is passed), and it is passed
 * to the Preview of `aios.html` as temporary text. Preview does not run scripts, so the initial language, colors and version are
 * written into the document here (`prepareHelpDocument`). If the colors change, it is rewritten and resent (Preview redraws).
 */
function HelpTransientPane({ transient }: { readonly transient: HelpView }): React.JSX.Element {
  const t = useT()
  const theme = useTheme((state) => state.resolved)
  const version = useStore((state) => state.appInfo?.build.version ?? '')
  /** undefined = not yet, null = could not be read. Loading the document is folded into `TransientFrame`'s `resolve`. */
  const [doc, setDoc] = useState<HelpDocument | null | undefined>(undefined)
  const latest = useRef(0)
  const resolve = useCallback(async (): Promise<ResolvedViewer | null> => {
    const mine = ++latest.current
    let next: HelpDocument | null
    try {
      next = await window.aios.help.open(transient.uri)
    } catch {
      next = null
    }
    // Discard an old answer that was overtaken by a reopen.
    if (mine === latest.current) setDoc(next)
    return next?.viewer ?? null
  }, [transient.uri])
  const lang = doc?.lang ?? parseHelpUri(transient.uri)?.lang ?? 'en'
  const payloadFor = useCallback(
    (): ViewerWirePayload => {
      const text = prepareHelpDocument(doc?.text ?? '', { lang, theme, version })
      return { kind: 'text', text, truncated: false, size: new TextEncoder().encode(text).byteLength }
    },
    [doc, lang, theme, version]
  )
  return (
    <TransientFrame
      label={t('help.title')}
      resolveKey={`help:${transient.uri}:${transient.nonce}`}
      resolve={resolve}
      payloadFor={payloadFor}
      // Help is Preview only (no switching to Source).
      viewModes={false}
      // If the document could not be read (null), there is no viewer either. Use different text from the case where it was read but there is no viewer (the extension was turned off).
      noViewer={doc === null ? t('help.loadFailed') : t('help.noViewer')}
    />
  )
}

function DiffTransientPane({ transient }: { readonly transient: DiffPayload }): React.JSX.Element {
  const t = useT()
  // Identifier for each temporary diff display (TODO 1091 item 2). Tells whether a selection notification belongs to the previous diff (used for the `uri` of `selection`).
  // Advance the generation each time the content changes (adjusting state during render; do not use a module variable with side effects).
  const instance = useId()
  const [seen, setSeen] = useState(transient)
  const [generation, setGeneration] = useState(0)
  if (seen !== transient) {
    setSeen(transient)
    setGeneration(generation + 1)
  }
  const viewUri = `${TRANSIENT_DIFF_URI_PREFIX}${instance}/${generation}`
  const resolve = useCallback(() => window.aios.viewer.openPayload(transient.kind), [transient.kind])
  const payloadFor = useCallback((): ViewerWirePayload => transient, [transient])
  return (
    <TransientFrame
      label={diffLabel(transient)}
      resolveKey={transient.kind}
      resolve={resolve}
      payloadFor={payloadFor}
      viewUri={viewUri}
      // TODO 460: aios.diff can be disabled even though it is built in. In that case, instead of the file's "no viewer can open this",
      // show that there is no diff viewer and how to restore it (the approval itself can be judged from the raw arguments of "content").
      noViewer={t('viewer.noDiffViewer')}
    />
  )
}

function FileTransientPane({ transient }: { readonly transient: TransientFileView }): React.JSX.Element {
  const t = useT()
  const heif = isHeifName(transient.name)
  /** Remember the resolved viewer together with which temporary display (nonce) it belongs to. Conversion starts only after it is known to be an image viewer. */
  const [resolvedFor, setResolvedFor] = useState<{ readonly nonce: number; readonly viewer: ResolvedViewer | null } | null>(null)
  const resolve = useCallback(async (): Promise<ResolvedViewer | null> => {
    const viewer = await window.aios.viewer.openTransientFile(transient.name)
    setResolvedFor({ nonce: transient.nonce, viewer })
    return viewer
  }, [transient.name, transient.nonce])
  // TODO 1162: a HEIC / HEIF inside a zip does not go through `aios-res://`, so ask main to make a JPEG and then pass it to the viewer
  // (name, heading and viewer resolution stay as they were). Conversion is done only when the resolved viewer is an image viewer that receives the content by `url`
  // (no conversion if there is no viewer or it is a text viewer; wave 77 review Y).
  const needsConversion = heif && resolvedFor?.nonce === transient.nonce && resolvedFor.viewer?.delivery === 'url'
  const [converted, setConverted] = useState<{ readonly nonce: number; readonly result: ViewerImageConversion } | null>(null)
  useEffect(() => {
    if (!needsConversion) return
    let cancelled = false
    const finish = (result: ViewerImageConversion): void => {
      if (!cancelled) setConverted({ nonce: transient.nonce, result })
    }
    window.aios.viewer.convertImageForDisplay(transient.name, transient.data).then(finish, () => finish({ ok: false, reason: 'failed' }))
    return () => {
      cancelled = true
    }
  }, [needsConversion, transient.name, transient.data, transient.nonce])
  const pending = needsConversion && converted?.nonce !== transient.nonce
  const payloadFor = useCallback(
    (viewer: ResolvedViewer): ViewerWirePayload | null => {
      if (!heif || viewer.delivery !== 'url') return transientFilePayload(transient, viewer)
      // Send nothing during the conversion (the viewer stays empty; the heading and the loading display are shown by TransientFrame).
      if (converted?.nonce !== transient.nonce) return null
      const result = converted.result
      if (result.ok) return { kind: 'bytes', data: result.bytes, size: result.bytes.byteLength, mime: 'image/jpeg' }
      // Different text per reason (imageUnsupportedFormat / imageConvertFailed / imageTooLarge in plugins/_shared/i18n.ts).
      const message =
        result.reason === 'unsupported-platform' ? 'unsupported-format' : result.reason === 'too-large' ? 'too-large' : 'convert-failed'
      return { kind: 'error', message }
    },
    [heif, transient, converted]
  )
  return (
    <TransientFrame
      label={transientFileLabel(transient)}
      resolveKey={`${transient.nonce}`}
      resolve={resolve}
      payloadFor={payloadFor}
      revision={transient.nonce}
      pending={pending}
      // If an archive inside an archive (a zip inside a zip) is opened, replace the current temporary display with it.
      openEntrySource={transientFileBaseName(transient.name)}
      noViewer={t('viewer.noViewer')}
    />
  )
}

function TransientFrame({
  label,
  resolveKey,
  resolve,
  payloadFor,
  revision,
  openEntrySource,
  viewUri = '',
  viewModes: showModes = true,
  pending = false,
  noViewer
}: {
  readonly label: string
  /** When this changes, the viewer is resolved again. */
  readonly resolveKey: string
  readonly resolve: () => Promise<ResolvedViewer | null>
  /** null = there is no content to pass yet (conversion in progress). Nothing is sent to the viewer. */
  readonly payloadFor: (viewer: ResolvedViewer) => ViewerWirePayload | null
  readonly revision?: number
  /** The archive's name when accepting `open-entry` from an archive viewer. If absent, it is not accepted. */
  readonly openEntrySource?: string
  /** The `uri` passed to the viewer. '' for a temporary file display; for a diff, the identifier (TODO 1091 item 2, to check the destination of selection notifications). */
  readonly viewUri?: string
  /** Whether to show "view switch" (TODO 969) in the heading. Not shown for Help, which is Preview only. */
  readonly viewModes?: boolean
  /** While the content is being prepared (HEIC conversion, up to 30 seconds). Keep the viewer's frame and overlay a loading display on top. */
  readonly pending?: boolean
  readonly noViewer: string
}): React.JSX.Element {
  const t = useT()
  // The underline of the heading uses the color of the displayed thread's cwd, as with a file viewer (item 190).
  const accent = useViewerAccentStyle()
  const closeTransient = useStore((state) => state.closeTransient)
  const theme = useTheme((state) => state.resolved)
  const locale = useLocale((state) => state.resolved)
  // Resend when the key assignments change (same as ViewerPane; wave 33 proxy verification 620-1).
  const keybindings = useKeybindings((state) => state.overrides)
  /** undefined = resolving, null = no viewer claims it. */
  const [resolved, setResolved] = useState<{ readonly key: string; readonly viewer: ResolvedViewer | null } | undefined>(
    undefined
  )
  const viewer = resolved?.key === resolveKey ? resolved.viewer : undefined
  const frame = useRef<HTMLIFrameElement | null>(null)
  const port = useRef<MessagePort | null>(null)
  /** Content whose bytes were already sent to the current port. If the same, from the second time on it is `bytes-ref` (do not copy 64 MB each time). */
  const sent = useRef<{ readonly port: MessagePort; readonly resource: ViewerWirePayload } | null>(null)
  /** The "view switch" the viewer reported (TODO 969, .md / .html inside a zip). A temporary display has no URI, so the destination is ''. */
  const [viewModes, setViewModes] = useState<ViewModesReport | null>(null)

  useEffect(() => {
    let cancelled = false
    void resolve().then(
      (next) => {
        if (!cancelled) setResolved({ key: resolveKey, viewer: next })
      },
      () => {
        if (!cancelled) setResolved({ key: resolveKey, viewer: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [resolve, resolveKey])

  // Discard the port only when the iframe is replaced (same reason as ViewerPane, Phase 4).
  useEffect(() => {
    port.current = null
    sent.current = null
    setViewModes(null)
  }, [viewer?.url, resolveKey])

  // The content depends on how the viewer receives it (a string for a text viewer, bytes otherwise). It is not rebuilt when the theme / language is resent.
  const resource = useMemo(() => (viewer === undefined || viewer === null ? null : payloadFor(viewer)), [viewer, payloadFor])

  const push = useCallback(() => {
    const target = port.current
    if (target === null || resource === null) return
    const alreadySent = sent.current?.port === target && sent.current.resource === resource
    const message: ViewerHostMessage = {
      type: 'resource',
      // A temporary display has no URI. The viewer returns no draft (only the diff returns a selection, with the same identifier as `viewUri`).
      uri: viewUri,
      label,
      resource: wireResource(resource, alreadySent),
      editable: false,
      theme,
      locale,
      // App keys that should be sent back when pressed inside the viewer (item 189).
      shortcuts: viewerShortcuts(),
      ...(revision === undefined ? {} : { revision })
    }
    target.postMessage(message)
    if (resource.kind === 'bytes') sent.current = { port: target, resource }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keybindings is the marker that the contents of viewerShortcuts() changed
  }, [resource, label, revision, theme, locale, keybindings, viewUri])

  /**
   * The port's listener is created only once, at the iframe's load, so the `push` called from it always looks up the latest
   * (same as ViewerPane's `latestPush`). If it held the `push` from load time, a `ready` arriving after a theme change
   * would resend with the old theme / language.
   */
  const latestPush = useRef(push)
  const latestViewUri = useRef(viewUri)
  latestViewUri.current = viewUri
  useEffect(() => {
    latestPush.current = push
    push()
  }, [push])

  const onLoad = useCallback(() => {
    const target = frame.current?.contentWindow
    if (target === null || target === undefined) return
    const channel = new MessageChannel()
    port.current = channel.port1
    sent.current = null
    channel.port1.onmessage = (event: MessageEvent) => {
      // It is a read-only viewer, so it accepts only "ready", the app keys (item 189), and the request to open a file
      // inside an archive (TODO 905, from an archive inside an archive).
      const data = event.data as { type?: unknown; id?: unknown; uri?: unknown; name?: unknown; data?: unknown } | null
      if (data?.type === 'ready') latestPush.current()
      else if (data?.type === 'shortcut') runViewerShortcut(data.id)
      else if (data?.type === 'selection' && latestViewUri.current !== '') {
        // Diff selection (TODO 1091 item 2). Discard it if it differs from the current diff's identifier. It does not become an attachment candidate.
        const accepted = acceptViewerSelection(data as { uri?: unknown; selection?: unknown }, latestViewUri.current)
        if (accepted !== undefined) useStore.getState().setTransientSelection(accepted)
      }
      else if (data?.type === 'view-modes') {
        const report = acceptViewModes(data as { uri?: unknown; modes?: unknown; current?: unknown }, '')
        if (report !== null) setViewModes(report)
      }
      else if (data?.type === 'open-entry' && openEntrySource !== undefined) {
        const accepted = acceptOpenEntry(data, '')
        if (accepted !== null) useStore.getState().openTransientFile({ ...accepted, source: openEntrySource })
      }
    }
    channel.port1.start()
    target.postMessage({ type: 'aios-port' }, '*', [channel.port2])
    latestPush.current()
  }, [openEntrySource])

  /** Chosen in the heading's "view switch" (TODO 969). */
  const changeViewMode = useCallback((mode: ViewerViewMode) => {
    const target = port.current
    if (target === null) return
    setViewModes((prev) => (prev === null ? prev : { ...prev, current: mode }))
    const message: ViewerHostMessage = { type: 'set-view-mode', uri: '', mode }
    target.postMessage(message)
  }, [])

  const close = (
    <Tooltip content={t('viewer.close')}>
      <button
        type="button"
        className="icon-button viewer-close"
        onClick={closeTransient}
        aria-label={t('viewer.close')}
      >
        <CloseIcon />
      </button>
    </Tooltip>
  )

  return (
    <div className="viewer-pane viewer-transient">
      <div className="viewer-header" style={accent}>
        <span className="viewer-path">{label}</span>
        <span className="viewer-id">{viewer?.pluginId ?? ''}</span>
        <span className="viewer-spacer" />
        {showModes && showsViewModes(viewModes, '') ? <ViewerModeSwitch report={viewModes} onChange={changeViewMode} /> : null}
        {close}
      </div>
      {viewer === undefined ? (
        <div className="viewer-pane empty">{t('common.loading')}</div>
      ) : viewer === null ? (
        <div className="viewer-pane empty">{noViewer}</div>
      ) : (
        <div className="viewer-body viewer-pending-host" aria-busy={pending || undefined}>
          {pending ? <div className="viewer-pending">{t('common.loading')}</div> : null}
          {/* Isolation (7.8) is the same as ViewerPane's iframe. The clipboard is not needed either, so no allow is attached. */}
          <iframe
            // When a temporary display file is reopened (even with the same viewer), recreate the iframe, so stale resends from the previous port do not mix in.
            key={resolveKey}
            ref={frame}
            className="viewer-frame"
            title={viewer.name}
            src={viewer.url}
            sandbox="allow-scripts"
            onLoad={onLoad}
          />
        </div>
      )}
    </div>
  )
}
