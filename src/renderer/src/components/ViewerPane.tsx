/**
 * ViewerPane (ARCHITECTURE.md chapter 5 / 5.2 / 7.8).
 *
 * **The viewer was isolated in Phase 4.** A viewer is a plugin under `plugins/` and runs inside a sandboxed iframe of a
 * separate origin (`sandbox="allow-scripts"`, without `allow-same-origin`). The host's responsibilities are unchanged since Phase 1:
 *
 *   - Resolve a viewer from the URI (done by PluginHost)
 *   - Read the content and pass it to the viewer as `resource` (now **through the Broker**)
 *   - Hold the draft being edited; **only the host calls the save IPC**
 *
 * The channel to the viewer is **a single MessageChannel port**. The iframe has an opaque origin, so the other side cannot be checked by
 * the targetOrigin of `postMessage`. Right after load, exactly one port is handed over, and from then on we talk only over that port.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ResolvedViewer, ViewerChoices, ViewerGuestMessage, ViewerHostMessage } from '@shared/plugin.js'
import type { ViewerResource } from '@shared/types.js'
import { isOpenDefaultAllowed } from '@shared/open-default.js'
import { displayPath, uriBasename } from '@shared/uri.js'
import { isOpenableExternally } from '@shared/open-external.js'
import { isWebPaneUri } from '@shared/web-tabs.js'
import { MAX_LINK_HREF } from '@shared/link.js'
import { openExternalLink, openLinkHref } from '../markdown-link.js'
import { useStore } from '../store.js'
import { useTheme } from '../themeStore.js'
import { useLocale } from '../localeStore.js'
import { useEditor } from '../editorStore.js'
import { useThreads } from '../threadStore.js'
import { PathActions } from './PathActions.js'
import { Tooltip } from './Tooltip.js'
import { ContextMenu, useContextMenuState } from './ContextMenu.js'
import {
  codeNavMenuItems,
  openButtonLabelKey,
  pathContextMenuItems,
  selectionSearchMenuItems
} from '../path-context-menu.js'
import { describeReason, useT, type MessageKey } from '../i18n/index.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { OpenExternalIcon } from '../icons/OpenExternalIcon.js'
import { ShowInFilesIcon } from '../icons/ShowInFilesIcon.js'
import { canShowInFiles, showInFiles } from '../show-in-files.js'
import { followShownFile, watchFrameFocusEnter } from '../files-follow-viewer.js'
import { ViewerBackIcon } from '../icons/ViewerBackIcon.js'
import { ViewerForwardIcon } from '../icons/ViewerForwardIcon.js'
import { SymbolsIcon } from '../icons/SymbolsIcon.js'
import { ReopenWithIcon } from '../icons/ReopenWithIcon.js'
import { reopenDecision, reopenMenuEntries, showReopenWith } from '../viewer-reopen.js'
import {
  closeShownView,
  noteViewerPushed,
  recordViewerPosition,
  runViewerNav,
  useViewerNavState
} from '../viewerHistory.js'
import { acceptViewerPosition } from '@shared/viewer-position.js'
import { viewerNavKeyLabel, type ViewerNavId } from '../shortcuts.js'
import { currentKeybindings, searchKeyLabel, symbolsKeyLabel, viewerEditorKeyLabel } from '../shortcuts.js'
import { keyPlatformOf } from '../composer-keys.js'
import { acceptViewerContextMenu, acceptViewerSelection } from '../viewer-selection.js'
import { recenterMessageFor, revealMessageFor } from '../viewer-line.js'
import { useViewerAccentStyle } from '../viewer-accent.js'
import {
  ResourceRevisions,
  acceptsDraft,
  currentResource,
  routableResource,
  samePush,
  type LoadedResource,
  type PushedResource
} from '../viewer-route.js'
import { TransientViewerPane } from './TransientViewerPane.js'
import { acceptOpenEntry, archiveLabelOf } from '../transient-file.js'
import { WebViewerPane, markWebPaneClosing } from './WebViewerPane.js'
import { closeWebTab, useWeb } from '../webStore.js'
import { DraftConflictBanner } from './DraftConflictBanner.js'
import { registerViewerCloser, runViewerShortcut, searchSelection, viewerEditorKeys, viewerShortcuts } from '../shortcut-actions.js'
import { SAVE_SHORTCUT_ID, isSaveShortcut } from '../shortcuts.js'
import { SAVED_FLASH_MS, saveIndicator, shouldSaveByKey } from '../viewer-save.js'
import { acceptViewModes, showsViewModes, type ViewerViewMode, type ViewModesReport } from '@shared/viewer-view-mode.js'
import { ViewerModeSwitch } from './ViewerModeSwitch.js'
import { ViewerAddressBar } from './ViewerAddressBar.js'
import { draftBaseOf, restoreDraft, syncDraft } from '../viewer-drafts.js'
import { reselectDecision, shownViewer, type ShownViewer } from '../viewer-reselect.js'
import { acceptAcceptsEdits, dropInsertable, useViewerDrop, type AcceptsEditsReport } from '../viewer-drop.js'
import { openDroppedUris } from '../drop-open.js'
import { dropInsertFormat, type DropLinkDenial } from '@shared/drop-link.js'
import { setViewerSearchFocus } from '../ascii-input.js'
import { initAutoSave, useAutoSave } from '../autoSaveStore.js'
import { useKeybindings } from '../keybindingStore.js'
import { armsDelay, canAutoSave, planBackgroundSave, watchFrameFocusLoss } from '../viewer-auto-save.js'
import { autoSaveDelayFor } from '@shared/auto-save.js'
import { registerPaneSaver, trackSave, type PaneSaveResult } from '../viewer-drafts-close.js'

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: MessageKey }

/** Failure reason of saving (main's `reason`) -> dictionary key (7.4.4). */
const SAVE_ERRORS: Record<string, MessageKey> = {
  conflict: 'viewer.save.conflict',
  denied: 'viewer.save.denied',
  'not-found': 'viewer.save.notFound',
  'too-large': 'viewer.save.tooLarge',
  locked: 'viewer.save.locked',
  unsupported: 'viewer.save.unsupported',
  io: 'viewer.save.io'
}

/** From `ViewerResource` to the shape passed to the viewer. **Paths are not passed** (the rule of chapter 7). */
function toPayload(
  resource: ViewerResource,
  tr: Parameters<typeof describeReason>[0]
): ViewerHostMessage extends never ? never : unknown {
  if (resource.kind === 'text') {
    return {
      kind: 'text' as const,
      text: resource.text,
      truncated: resource.truncated,
      size: resource.size
    }
  }
  if (resource.kind === 'binary') {
    return { kind: 'binary' as const, resourceUrl: resource.resourceUrl, size: resource.size }
  }
  // TODO 947: the reason codes main passes (such as `path-not-regular`) cannot be translated by the viewer in the iframe, so they are turned into sentences here.
  return { kind: 'error' as const, message: describeReason(tr, resource.message) }
}

/**
 * The button that closes the view in front (item 70). Since TODO 1297 it works like closing a browser tab
 * (`closeShownView`): focus moves to the view seen just before, and only when nothing is left does the pane show its
 * empty state. The pane itself never goes away. The shortcut is ⌘W through `registerViewerCloser` (TODO 843).
 */
function CloseButton({
  onClick,
  floating
}: {
  readonly onClick: () => void
  readonly floating?: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <Tooltip content={t('viewer.close')}>
      <button
        type="button"
        className={`icon-button viewer-close${floating === true ? ' floating' : ''}`}
        onClick={onClick}
        aria-label={t('viewer.close')}
      >
        <CloseIcon />
      </button>
    </Tooltip>
  )
}

/** The key convention attached to the balloon (mac / other). Decided once at startup, like the table in `shortcut-actions.ts`. */
const NAV_KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

/**
 * The heading's "back" and "forward" (TODO 369, wave 20 bundle D). History is in `viewerHistory.ts` (per thread, not persisted).
 * It is icon-only, so the balloon is a `Tooltip` (no `title`, item 320). **mouseenter does not reach a disabled button**
 * (Chromium does not send mouse events to disabled form controls), so the balloon is received by an outer
 * `span`, and a disabled button passes through to the span with `pointer-events: none` (the section at the end of styles.css).
 */
function NavButton({ id, enabled }: { readonly id: ViewerNavId; readonly enabled: boolean }): React.JSX.Element {
  const t = useT()
  const label = t(id === 'viewerBack' ? 'viewer.back' : 'viewer.forward')
  const tip = `${label} (${viewerNavKeyLabel(id, NAV_KEY_PLATFORM)})`
  return (
    <Tooltip content={tip}>
      <span className="viewer-nav-slot">
        <button
          type="button"
          className={`icon-button viewer-nav ${id === 'viewerBack' ? 'viewer-back' : 'viewer-forward'}`}
          disabled={!enabled}
          onClick={() => runViewerNav(id)}
          aria-label={label}
        >
          {id === 'viewerBack' ? <ViewerBackIcon /> : <ViewerForwardIcon />}
        </button>
      </span>
    </Tooltip>
  )
}

function FileViewerPane(): React.JSX.Element {
  const t = useT()
  // The 2px underline of the heading is the color of the displayed thread's working directory (item 190).
  const accent = useViewerAccentStyle()
  const uri = useStore((state) => state.selectedUri)
  const highlightQuery = useStore((state) => state.highlightQuery)
  // One-shot instruction to jump to a line (item 273). A message separate from `resource`; it remembers the number sent so it is not sent twice.
  const viewerLine = useStore((state) => state.viewerLine)
  // One-shot instruction to re-center on a search hit (TODO 446). Like the line instruction, it is sent only once per number.
  const viewerRecenter = useStore((state) => state.viewerRecenter)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const platform = useStore((state) => state.appInfo?.platform)
  // Item 115: open from the line where the selection currently is (the start of the file if none).
  const selectionFromLine = useStore((state) => state.viewerSelection?.fromLine ?? null)
  const openInEditor = useEditor((state) => state.open)
  // TODO 1214: the single heading button dispatches by extension (`.xlsx` / `.pdf` ... use the OS default app). Right-click has two rows.
  const openFile = useEditor((state) => state.openFile)
  const openDefault = useEditor((state) => state.openDefault)
  const createThreadInFolder = useThreads((state) => state.createThreadInFolder)
  // TODO 299: the right-click menu of the path display in the heading.
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()
  // Item 97 second half: notice of a draft conflict. The band itself is DraftConflictBanner.tsx.
  const draftConflict = useStore((state) => state.draftConflict)
  const setDraftConflict = useStore((state) => state.setDraftConflict)
  // TODO 673: the one-shot instruction for an external tool's rewrite, a silent reload when there is no draft.
  const externalReload = useStore((state) => state.externalReload)
  // TODO 312 (wave 18 bundle B): the per-file draft table. Even when the URI changes the draft is not discarded, and it is restored on return.
  const rememberDraft = useStore((state) => state.rememberDraft)
  const forgetDraft = useStore((state) => state.forgetDraft)
  // TODO 369: enabled / disabled state of the heading's back / forward (the displayed thread's history).
  const nav = useViewerNavState()
  const [viewer, setViewer] = useState<ResolvedViewer | null>(null)
  /**
   * The content that was read and its origin (URI and plugin). It is not cleared when the URI switches: clearing would
   * draw the empty state and detach the iframe, recreating it even between files of the same plugin. Whether the content
   * belongs to the displayed URI is checked with `currentResource` (item 149).
   */
  const [loaded, setLoaded] = useState<LoadedResource | null>(null)
  /**
   * A copy of the current content (code-review of TODO 606). Copied at render, and written together with the state when a save succeeds. The flush before closing
   * (`latestPaneSave`) can call the `doSave` of an old render that has not been redrawn yet after waiting for a save in progress, so the base
   * mtime is read from here (so we do not write with an old mtime and cause a false conflict).
   */
  const loadedNow = useRef<LoadedResource | null>(null)
  loadedNow.current = loaded
  const resource = currentResource(uri, viewer, loaded)
  const [draft, setDraftState] = useState<string | null>(null)
  /**
   * A copy of the current draft (TODO 555). Written together with the state so that, after a save round trip (await), we can see "whether characters were typed in the meantime".
   * `setDraft` is the entry point that writes these two in step.
   */
  const draftNow = useRef<string | null>(null)
  const setDraft = useCallback((next: string | null): void => {
    draftNow.current = next
    setDraftState(next)
  }, [])
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  /**
   * Number of the save success (TODO 969). Only while set (`SAVED_FLASH_MS`) does the heading show "Saved" with a check mark. Advanced on the success of `doSave` for
   * any of manual save, Cmd+S, autosave (TODO 555) and save-by-overwrite. Cleared when moving to another file.
   */
  const [savedFlash, setSavedFlash] = useState<number | null>(null)
  /** The "view switch" the viewer reported (TODO 969, Source / Preview). Shown in the heading with `ViewerModeSwitch`. */
  const [viewModes, setViewModes] = useState<ViewModesReport | null>(null)
  // TODO 555: viewer autosave (VS Code's `files.autoSave`). Default is off. The setting lives in one place in main, and all windows are notified.
  const autoSaveMode = useAutoSave((state) => state.mode)
  const autoSaveDelayMs = useAutoSave((state) => state.delayMs)
  useEffect(() => initAutoSave(), [])
  /** The latest value read from effect cleanup (moving to another file, closing) (TODO 555). */
  const uriNow = useRef(uri)
  uriNow.current = uri
  const autoSaveModeNow = useRef(autoSaveMode)
  autoSaveModeNow.current = autoSaveMode
  /** A draft whose autosave was refused for a reason other than a conflict (TODO 555). The same one is not tried again repeatedly. */
  const autoSaveFailed = useRef<string | null>(null)
  /** x was pressed while there are unsaved edits (item 70). Confirmed inline. */
  const [confirmClose, setConfirmClose] = useState(false)
  const frame = useRef<HTMLIFrameElement | null>(null)
  /** Focus key of the search field inside the viewer (TODO 463). Released when the pane disappears. */
  const searchFocusKey = useId()
  useEffect(() => () => setViewerSearchFocus(searchFocusKey, false), [searchFocusKey])
  /** The port handed to the current iframe and that iframe's `src` (item 149: which viewer's port it is). */
  const port = useRef<{ readonly port: MessagePort; readonly url: string } | null>(null)
  /** The URI last sent to the current port (= the file the viewer is drawing). Used to receive drafts. */
  const pushedUri = useRef<string | null>(null)
  /** The "go to this line" number already sent to the viewer (item 273). Numbers are not reused even if the iframe is replaced. */
  const sentLineNonce = useRef(0)
  /** The "re-center on the hit" number already sent to the viewer (TODO 446). */
  const sentRecenterNonce = useRef(0)
  /** Version per content read (items 309-2 / 303). It does not change on a resend, and is the marker by which the viewer keeps its body. */
  const revisions = useRef(new ResourceRevisions())
  /** The `resource` last sent to the current port (do not send the same one twice, item 309-2). */
  const lastPush = useRef<PushedResource | null>(null)
  /** Files dropped onto the viewer that the choke point refused (TODO 366). Shown in the band. */
  const [dropDenied, setDropDenied] = useState<readonly DropLinkDenial[]>([])
  /** The URI of a file that has a symbol list (the viewer reported it with `symbols`) (TODO 468). Shows the heading button. */
  const [symbolsUri, setSymbolsUri] = useState<string | null>(null)
  /** What the viewer reported as "whether the current view accepts edits" (TODO 587, Source / Preview). Used to decide whether a drop inserts or opens. */
  const [acceptsEdits, setAcceptsEdits] = useState<AcceptsEditsReport | null>(null)
  /**
   * Number for reopening the same URI (TODO 471). Increased when the viewer it resolves to changes because an extension was enabled / disabled, to rerun step 1).
   * The draft remains in the table (`viewerDrafts`), so it is carried to the reopened viewer (e.g. the fallback `aios.text`) by the restore of 1).
   */
  const [reopen, setReopen] = useState(0)
  /** The current reopen number (TODO 555: lets effect cleanup tell "a reopen" from "moving to another file"). */
  const reopenNow = useRef(reopen)
  reopenNow.current = reopen
  /** Candidates for "open with another viewer" (TODO 907). Fetched from main whenever the current URI and viewer change. */
  const [choices, setChoices] = useState<ViewerChoices | null>(null)
  /** There is an unsaved draft, so we did not switch to a viewer that cannot edit (TODO 907). The reason is shown in the band. */
  const [reopenBlocked, setReopenBlocked] = useState(false)
  /** Main refused the re-selection (`viewer.choose` was false: dropped from the candidates, extension unusable, etc.). The reason is shown in the band. */
  const [reopenFailed, setReopenFailed] = useState(false)

  // 1) When the URI changes (or on reopening - TODO 471), resolve the viewer and read the content.
  //    The previous file's draft remains in the table (`viewerDrafts`) (1b below), so it can be discarded here.
  //    The new file's draft is restored from the table once it has been read (TODO 312). On reopening, the draft of the same URI comes back
  //    (in the render right after `setDraft(null)`, 1b is `syncDraft(null, …)` = a no-op, so it is not removed from the table).
  useEffect(() => {
    setDraft(null)
    setSave({ kind: 'idle' })
    setSavedFlash(null)
    setConfirmClose(false)
    setDropDenied([])
    setReopenBlocked(false)
    setReopenFailed(false)
    if (uri === null) {
      setViewer(null)
      setLoaded(null)
      return
    }
    let cancelled = false
    /** The reopen number at which this effect ran (TODO 555: no background save on a reopen). */
    const reopenAtStart = reopen
    // The read permission granted by `open` is returned when the URI is switched / closed (review D-3).
    // If the resolution comes back after cleanup, it is returned on the spot.
    let opened: { pluginId: string; uri: string } | null = null
    const release = (): void => {
      if (opened === null) return
      void window.aios.viewer.close(opened.pluginId, opened.uri)
      opened = null
    }
    void (async () => {
      const resolved = await window.aios.viewer.open(uri)
      if (resolved !== null) opened = { pluginId: resolved.pluginId, uri }
      if (cancelled) {
        release()
        return
      }
      setViewer(resolved)
      if (resolved === null) {
        // `message` does not reach the viewer (when viewer === null, the empty state is drawn).
        setLoaded({ uri, pluginId: '', resource: { kind: 'error', message: 'no-viewer' } })
        return
      }
      const next = await window.aios.viewer.read(resolved.pluginId, uri)
      if (cancelled) return
      // Overlay the remembered draft (TODO 312). The content and the draft go in the same render - if a render with
      // "no draft" came in between, 1b would see it and remove the draft from the table.
      const restored = restoreDraft(useStore.getState().viewerDrafts[uri], next)
      if (restored.forget) useStore.getState().forgetDraft(uri)
      setLoaded({
        uri,
        pluginId: resolved.pluginId,
        resource: restored.resource,
        ...(restored.draft === null ? {} : { draft: restored.draft })
      })
      setDraft(restored.draft)
      // The disk changed while we were away -> the existing draft-conflict band (item 97 second half / TODO 313).
      if (restored.conflict) useStore.getState().setDraftConflict({ uri, toolName: null })
    })()
    return () => {
      cancelled = true
      const isReopen = uriNow.current === uri && reopenNow.current !== reopenAtStart
      // TODO 673 (code-review fix, first half of serious 7): unless this is a reopen (471), we are really leaving this URI
      // (to another file, to null, to a web / transient display, or on unmount), so
      // stop watching for external rewrites. When switching to another existing file, the `track()` of the `read()` right after
      // drops the previous watch anyway, but dropping it first here does no harm (idempotent).
      if (!isReopen) window.aios.viewer.untrackWatch()
      // TODO 555: if autosave is ON, write the unsaved draft of the file being left (the one remembered in the table) in the background, then return the permission
      // (the write goes through with the permission from `open`). No write on reopening the same URI (TODO 471).
      const background =
        opened === null || isReopen
          ? null
          : planBackgroundSave({
              mode: autoSaveModeNow.current,
              uri,
              pluginId: opened.pluginId,
              stored: useStore.getState().viewerDrafts[uri],
              conflictUri: useStore.getState().draftConflict?.uri ?? null
            })
      if (background === null) {
        release()
        return
      }
      // TODO 606: count it as a write in progress (the flush before closing the window waits for this to finish before starting).
      void trackSave(window.aios.viewer.write(background.pluginId, background.uri, background.text, background.baseMtimeMs))
        .then(
          (result) => {
            // Once written, remove it from the table (on return, it is the saved body). If the user went back and typed again in the meantime, keep it.
            // If refused (conflict, etc.), keep it in the table - on return it is restored as before, and for a conflict the band appears.
            const state = useStore.getState()
            if (result.ok && state.viewerDrafts[background.uri]?.text === background.text) {
              state.forgetDraft(background.uri)
            }
          },
          () => undefined
        )
        .finally(release)
    }
  }, [uri, reopen, setDraft])

  /**
   * 1c) When an extension is enabled / disabled, re-select the viewer of the displayed file (TODO 471). `plugins.onChanged` is
   * delivered to all windows, so every window's ViewerPane tries its own display. The permission of the trial resolution (`viewer.open`) is returned right away.
   * Reopen only when the resolved viewer differs from the current one (`reselectDecision`).
   */
  const shown = useRef<ShownViewer | null>(null)
  shown.current = shownViewer(uri, viewer, loaded)
  useEffect(() => {
    let disposed = false
    let seq = 0
    const unsubscribe = window.aios.plugins.onChanged(() => {
      const asked = shown.current
      if (asked === null) return
      seq += 1
      const mine = seq
      void (async () => {
        const probed = await window.aios.viewer.open(asked.uri)
        if (probed !== null) void window.aios.viewer.close(probed.pluginId, asked.uri)
        // Look only at the trial of the latest `onChanged` that returns later (when enabling / disabling in succession).
        if (disposed || mine !== seq) return
        const decision = reselectDecision(asked, shown.current, useStore.getState().selectedUri, probed)
        if (decision === 'reopen') setReopen((count) => count + 1)
      })()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  // 1d) Candidates for "open with another viewer" (TODO 907). Fetched once the opened viewer is decided (fetched again after a reopen).
  const viewerPluginId = viewer?.pluginId ?? null
  useEffect(() => {
    setChoices(null)
    // Do not show the entry point in a fake window.aios (tests) that lacks the entry.
    if (uri === null || viewerPluginId === null || window.aios.viewer.choices === undefined) return
    let live = true
    void window.aios.viewer.choices(uri).then(
      (next) => {
        if (live) setChoices(next ?? null)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [uri, viewerPluginId])

  /** Chosen in the "open with another viewer" menu (TODO 907). Make it the default, then reopen the same URI. */
  const reopenWith = useCallback(
    (target: { readonly pluginId: string; readonly editable: boolean }, isDirty: boolean): void => {
      if (uri === null) return
      const decision = reopenDecision({
        currentPluginId: viewerPluginId,
        targetPluginId: target.pluginId,
        targetEditable: target.editable,
        dirty: isDirty
      })
      if (decision === 'none') return
      if (decision === 'blocked') {
        setReopenBlocked(true)
        return
      }
      setReopenBlocked(false)
      setReopenFailed(false)
      const asked = uri
      void window.aios.viewer.choose(asked, target.pluginId).then(
        (ok) => {
          if (useStore.getState().selectedUri !== asked) return
          if (ok) setReopen((count) => count + 1)
          else setReopenFailed(true)
        },
        () => {
          if (useStore.getState().selectedUri === asked) setReopenFailed(true)
        }
      )
    },
    [uri, viewerPluginId]
  )

  /**
   * **The port is discarded only when the iframe is replaced.**
   *
   * It must not be discarded just because the URI changed: between files opened by the same plugin the
   * `src` does not change, so the iframe is not remounted and `onLoad` never fires again.
   * If the port is lost then, the second and later files never reach the viewer, and the display
   * stays stuck on the first file opened (hit on a real machine).
   */
  useEffect(() => {
    port.current = null
    pushedUri.current = null
    lastPush.current = null
    setSymbolsUri(null)
    setAcceptsEdits(null)
    setViewModes(null)
  }, [viewer?.url])

  // `readOnly` is what main judged as "readable but not savable" (an auto memory `.md`, item 254).
  const textEditable =
    viewer?.editable === true &&
    resource?.kind === 'text' &&
    !resource.truncated &&
    resource.readOnly !== true
  // TODO 1212 stage 1: the cell values of `.xlsx`. The draft is a list of edits (strings), and the base is the empty string (`draftBaseOf`).
  const cellEditable = resource?.kind === 'binary' && resource.cellEdits === true
  const editable = textEditable || cellEditable
  const draftBase = draftBaseOf(resource)
  const dirty = draft !== null && draftBase !== null && draft !== draftBase

  // 1b) Copy the draft to the table (TODO 312). Only when the content of the displayed URI is in place - the render
  //     right after changing the URI is "new URI + previous file's draft", so do not touch it while `resource` is null.
  //     It is removed when the draft returns to the original body, on save, on reload, and on x (each of those operations calls it).
  useEffect(() => {
    if (uri === null) return
    const sync = syncDraft(draft, resource)
    if (sync.kind === 'remember') rememberDraft(uri, sync.draft)
    else if (sync.kind === 'forget') forgetDraft(uri)
  }, [uri, draft, resource, rememberDraft, forgetDraft])

  // Mirror to the store that there are unsaved edits (item 97). The "open / close" from main
  // (`viewerMemory.ts`) looks at it and does not discard the draft. Cleared when closed (detached).
  const setViewerDirty = useStore((state) => state.setViewerDirty)
  useEffect(() => {
    setViewerDirty(dirty)
  }, [dirty, setViewerDirty])
  useEffect(() => () => setViewerDirty(false), [setViewerDirty])
  /**
   * Color theme (7.4.1). The parent's CSS variables do not reach the iframe, so it is passed by name.
   * The source of the value is the single effective theme main resolved (mirrored by themeStore).
   * It is in the dependencies of `push`, so **`resource` is resent even if only the theme changes**
   * (the iframe is not remounted unless `src` changes, so this is the only way to convey it).
   */
  const theme = useTheme((state) => state.resolved)
  /**
   * Display language (7.4.4). Like the theme, **only the name** is passed, and the viewer looks it up in a small dictionary on the plugins side
   * (the boundary check forbids importing the renderer's dictionary). When it changes, `resource` is resent.
   */
  const locale = useLocale((state) => state.resolved)
  /**
   * Key assignments (TODO 549 / 589). When they change, `resource` is resent to replace the table of keys the open viewer sends back
   * (the version is the same, so the viewer does not replace the body). `keybindingStore` finishes `setKeybindings` before swapping its record,
   * so `viewerShortcuts()` at resend time is the new table (wave 33 proxy verification 620-1).
   */
  const keybindings = useKeybindings((state) => state.overrides)

  // 2) Send the content to the iframe. After the port is connected, and when the content or theme changes.
  //    **Only content where three things line up is sent: the displayed URI, the current viewer, and the iframe the port was handed to**
  //    (item 149). Nothing is sent in the middle of a switch (while waiting for the new URI's resolution and read).
  //    Formerly "new URI + previous file's content" was sent to the previous iframe, and on Markdown -> PNG
  //    `aios.markdown` went to fetch the heading list with the PNG's URI and the Broker refused it with `no-grant`.
  const push = useCallback(() => {
    const target = port.current
    const routable = routableResource(uri, viewer, loaded, target?.url ?? null)
    if (target === null || uri === null || routable === null || loaded === null) return
    noteViewerPushed(uri)
    const revision = revisions.current.of(loaded)
    const pushed: PushedResource = {
      port: target.port,
      uri,
      revision,
      editable: editable === true,
      theme,
      locale,
      highlightQuery,
      keybindings
    }
    // Do not send the same content to the same port twice (a new iframe's load and `ready`, item 309-2).
    if (samePush(lastPush.current, pushed)) return
    const message: ViewerHostMessage = {
      type: 'resource',
      uri,
      // **Do not pass the absolute path.** All the viewer needs is the name, for language detection.
      label: uriBasename(uri),
      resource: toPayload(routable, t) as never,
      // The draft restored on return (TODO 312). The body (`resource.text`) stays as the disk content.
      ...(loaded.draft === undefined ? {} : { draft: loaded.draft }),
      editable: editable === true,
      theme,
      locale,
      // App keys that should be sent back when pressed inside the viewer (item 189).
      shortcuts: viewerShortcuts(),
      // Keys inside the viewer's editor (TODO 692: go to declaration / list assignments and uses). The viewer takes them itself.
      editorKeys: viewerEditorKeys(),
      // The in-file search term (TODO 56). Attached only when opened from a search hit; the viewer highlights it.
      ...(highlightQuery === null ? {} : { highlightQuery }),
      // Version of the content (items 309-2 / 303). It does not change when the theme, language or search term is resent, so for the
      // same version the viewer does not replace the body and keeps the draft, cursor and line markers.
      revision
    }
    target.port.postMessage(message)
    pushedUri.current = uri
    lastPush.current = pushed
  }, [uri, viewer, loaded, editable, theme, locale, highlightQuery, keybindings, t])

  /**
   * Jump to a line (item 273). Only while the viewer is drawing the file the instruction is for (after `resource` was sent),
   * sent once per number. It is on the same port, so it arrives after `resource`.
   */
  const pushLine = useCallback(() => {
    const target = port.current
    if (target === null) return
    const message = revealMessageFor(viewerLine, pushedUri.current, sentLineNonce.current)
    if (message === null || viewerLine === null) return
    target.port.postMessage(message)
    sentLineNonce.current = viewerLine.nonce
  }, [viewerLine])

  /**
   * Re-center on a search hit (TODO 446). Like `pushLine`, once per number only while the viewer is drawing the file the instruction is for
   * (after `resource` was sent). When the same hit is pressed again, `resource` is thinned out by `samePush` and
   * only this arrives.
   */
  const pushRecenter = useCallback(() => {
    const target = port.current
    if (target === null) return
    const message = recenterMessageFor(viewerRecenter, pushedUri.current, sentRecenterNonce.current)
    if (message === null || viewerRecenter === null) return
    target.port.postMessage(message)
    sentRecenterNonce.current = viewerRecenter.nonce
  }, [viewerRecenter])

  /**
   * Drop onto the viewer (TODO 366 / 407). Only for a viewer that accepts edits, an overlay is put over the iframe while a file is dragged, and
   * the dropped file becomes `insert-text` in the format of each plugin (a link for `aios.markdown`, the raw full path otherwise) and is passed
   * to the viewer (the insertion point is the viewer's caret). The destination is the file the viewer is drawing now (`pushedUri`).
   */
  // TODO 563: a drop onto a viewer that does not accept edits (image, PDF, read-only, truncated) opens that file. While editing, as before it is an
  // insert, and dropping with Option held opens it (owner decision 2026-10-09). Opening also goes through main's `drop.checkLinks` (choke point).
  const drop = useViewerDrop({
    enabled: viewer !== null,
    // TODO 587: the Preview of `aios.markdown` / `aios.html` does not accept insertion, so it falls back to opening, per the viewer's report.
    // A cell-value draft (`.xlsx`) does not accept inserted text - a dropped file is opened.
    insertable: dropInsertable(textEditable, acceptsEdits, uri),
    open: (uris) => void openDroppedUris(uris, (list) => window.aios.drop.checkLinks(list)),
    format: dropInsertFormat(viewer?.pluginId ?? ''),
    insert: (text) => {
      const target = port.current
      const drawn = pushedUri.current
      if (target === null || drawn === null || drawn !== useStore.getState().selectedUri) return false
      // Give the iframe focus to show the caret (`view.focus()` inside the iframe alone does not transfer it from the parent).
      frame.current?.focus()
      const message: ViewerHostMessage = { type: 'insert-text', uri: drawn, text }
      target.port.postMessage(message)
      return true
    },
    onDenied: setDropDenied,
    uriFor: (file) => window.aios.drop.uriFor(file),
    check: (uris) => window.aios.drop.checkLinks(uris),
    trace: (trace) => window.aios.drop.trace(trace)
  })
  /** Called from the port's listener (created once at load), so the latest is fetched through a ref. */
  const latestNoticeGuestDrag = useRef(drop.noticeGuestDrag)
  latestNoticeGuestDrag.current = drop.noticeGuestDrag
  const latestNoticeGuestDrop = useRef(drop.noticeGuestDrop)
  latestNoticeGuestDrop.current = drop.noticeGuestDrop

  /**
   * The heading's "go to symbol" (TODO 468). Makes the viewer open the list and gives the iframe focus so focus enters the input field
   * (`focus()` inside the iframe alone does not transfer it from the parent - same as insert-text).
   */
  const openSymbols = useCallback(() => {
    const target = port.current
    const drawn = pushedUri.current
    if (target === null || drawn === null) return
    frame.current?.focus()
    const message: ViewerHostMessage = { type: 'open-symbols', uri: drawn }
    target.port.postMessage(message)
  }, [])

  /**
   * Chosen in the heading's "view switch" (TODO 969). Sends `set-view-mode` addressed to the file the viewer is drawing. **The marker is not
   * moved first** (wave 81 review Y): the bridge passes only values within the view the viewer last declared, so if moved first, when it is
   * dropped only the heading would keep pointing to the new value. The marker moves only on the `view-modes` the viewer sends back after applying
   * (when dropped, the bridge resends the current value). The round trip is a MessagePort within the same window and fits in one frame.
   */
  const changeViewMode = useCallback((mode: ViewerViewMode) => {
    const target = port.current
    const drawn = pushedUri.current
    if (target === null || drawn === null) return
    const message: ViewerHostMessage = { type: 'set-view-mode', uri: drawn, mode }
    target.port.postMessage(message)
  }, [])

  /** Save by key / menu (item 313). The port's listener is not recreated, so the latest function is called through a ref. */
  const latestSaveByKey = useRef<() => void>(() => undefined)
  /**
   * Right-click on selected text (TODO 630). `openMenu` (`useContextMenuState`) and `t` (`useT`) are
   * new references on every render, so, like the other entry points (`latestSaveByKey` etc.), the latest is called through a ref
   * (the port's listener is created only once, at the iframe's load).
   */
  const latestContextMenu = useRef<(message: Parameters<typeof acceptViewerContextMenu>[0]) => void>(() => undefined)
  latestContextMenu.current = (raw) => {
    // Values from the plugin (an untrusted iframe) are checked for type, finiteness and length, and discarded unless addressed to the displayed file (code-review).
    const message = acceptViewerContextMenu(raw, pushedUri.current)
    if (message === null) return
    const rect = frame.current?.getBoundingClientRect()
    if (rect === undefined) return
    // TODO 1030: line up the three searches (body / file name / conversation) directly (with key notation).
    const searches = selectionSearchMenuItems(
      message.text,
      t,
      (target, query) => searchSelection(query, target),
      (target) => searchKeyLabel(target, currentKeybindings().platform)
    )
    // TODO 692: over a name, "go to declaration" and "list assignments and uses" (before search, as in VS Code). When chosen, ask the viewer.
    const navigation = message.codeNav
      ? codeNavMenuItems(
          t,
          (action) =>
            viewerEditorKeyLabel(
              action === 'declaration' ? 'code.goToDeclaration' : 'code.listReferences',
              currentKeybindings().platform
            ),
          (action) => {
            const target = port.current
            const drawn = pushedUri.current
            if (target === null || drawn === null || drawn !== message.uri) return
            // Give it to the iframe so focus enters the cursor at the destination and the list's input field (same as `openSymbols`).
            frame.current?.focus()
            const request: ViewerHostMessage = { type: 'code-nav', uri: drawn, action }
            target.port.postMessage(request)
          }
        )
      : []
    const items = [...navigation, ...searches]
    if (items.length === 0) return
    openMenu(
      {
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX: rect.left + message.x,
        clientY: rect.top + message.y
      },
      items
    )
  }
  /**
   * The port's listener is created only once, at the iframe's load, so the `push` called from it
   * always fetches the latest (if it held the `push` from load time, a late `ready`
   * could resend the content of an old URI).
   */
  const latestPush = useRef(push)
  /**
   * The sender of the line instruction (item 273) also fetches the latest. **Rewritten before the `push` effect** -
   * so that right after sending the new file's `resource`, the instruction is sent within the same effect.
   */
  const latestPushLine = useRef(pushLine)
  useEffect(() => {
    latestPushLine.current = pushLine
  }, [pushLine])
  /** The sender of the re-center instruction (TODO 446) also fetches the latest (rewritten before the `push` effect). */
  const latestPushRecenter = useRef(pushRecenter)
  useEffect(() => {
    latestPushRecenter.current = pushRecenter
  }, [pushRecenter])
  useEffect(() => {
    latestPush.current = push
    push()
    // Send the re-center before the line instruction (if both exist, the line wins).
    latestPushRecenter.current()
    latestPushLine.current()
  }, [push])
  // Even when only the re-center instruction changes (the same hit pressed again), `resource` is not resent.
  useEffect(() => {
    pushRecenter()
  }, [pushRecenter])
  // When only the line instruction changes, `resource` is not resent (resending makes the viewer replace the body, and
  // the same file's draft disappears). A number already sent is rejected by `revealMessageFor`, so it does not arrive twice.
  useEffect(() => {
    pushLine()
  }, [pushLine])

  // 3) When the iframe has loaded, hand over one port.
  const onLoad = useCallback(() => {
    const target = frame.current?.contentWindow
    if (target === null || target === undefined || viewer === null) return
    const channel = new MessageChannel()
    const own = channel.port1
    const pluginId = viewer.pluginId
    port.current = { port: own, url: viewer.url }
    // Release the previous iframe's search field focus without waiting for the blur notice (TODO 463).
    setViewerSearchFocus(searchFocusKey, false)
    pushedUri.current = null
    lastPush.current = null
    /** Whether this port still belongs to the current iframe. Requests and replies after the iframe was replaced are discarded. */
    const isCurrent = (): boolean => port.current?.port === own
    own.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) return
      const message = event.data as ViewerGuestMessage
      if (message.type === 'draft') {
        // Only when what the viewer is drawing is the displayed file (a mismatch during a switch, item 149).
        // TODO 938: if the URI the draft claims (the file whose body the viewer was drawing) differs from the `resource` sent now, discard it.
        // A draft from an older bridge that does not claim a uri goes back to the previous matching (pushedUri / selectedUri) (wave 49 review).
        if (
          typeof message.text === 'string' &&
          acceptsDraft(pushedUri.current, useStore.getState().selectedUri, message.uri)
        ) {
          setDraft(message.text)
        }
        return
      }
      if (message.type === 'ready') {
        latestPush.current()
        latestPushRecenter.current()
        latestPushLine.current()
        return
      }
      if (message.type === 'drag-files') {
        // A file drag that entered over the viewer directly from outside the window (TODO 366). Show the overlay, and from then on the host receives it.
        latestNoticeGuestDrag.current()
        return
      }
      if (message.type === 'drop-files') {
        // A file dropped inside the viewer because the overlay was not in time (TODO 407). The `File` is passed as is to the preload's `uriFor`
        // (a fabricated `File` has an empty path, so the viewer cannot claim a path).
        // TODO 429: the value is passed without checking, and when it is discarded because it is not an array or not during a drag, the reason is logged.
        latestNoticeGuestDrop.current(message.files, { count: message.count, cloneFailed: message.cloneFailed })
        return
      }
      if (message.type === 'shortcut') {
        // An app key pressed inside the viewer (OOPIF) (item 189). It does not reach the parent's keydown.
        if (message.id === SAVE_SHORTCUT_ID) latestSaveByKey.current()
        else runViewerShortcut(message.id)
        return
      }
      if (message.type === 'selection') {
        // Selection range (item 97). The viewer's value is not trusted but checked, and only the displayed file's is kept.
        // Whether to attach it to the send is the Composer's decision. It is neither saved nor indexed here.
        const accepted = acceptViewerSelection(message, useStore.getState().selectedUri)
        if (accepted !== undefined) useStore.getState().setViewerSelection(accepted)
        return
      }
      if (message.type === 'page') {
        // The current page (TODO 1061 item 2). Only the displayed file's, and only integers of 1 or more are kept. Not saved.
        const { selectedUri } = useStore.getState()
        const page: unknown = message.page
        if (
          selectedUri !== null &&
          message.uri === selectedUri &&
          typeof page === 'number' &&
          Number.isSafeInteger(page) &&
          page >= 1
        ) {
          useStore.getState().setViewerPage({ uri: selectedUri, page })
        }
        return
      }
      if (message.type === 'scroll-position') {
        // The position currently being viewed (TODO 1146). The viewer's value is checked, and remembered only for URIs in the displayed conversation's back / forward history
        // (a previous file's value arriving right after a switch is also accepted if it is in the history). It does not include the body.
        const position = acceptViewerPosition(message.position)
        if (typeof message.uri === 'string' && position !== null) recordViewerPosition(message.uri, position)
        return
      }
      if (message.type === 'open-external') {
        // "Open externally" from the viewer (5.1 "External links"). The viewer cannot reach the OS
        // (constraint 8): the host only dispatches and forwards to main's IPC, and main re-validates.
        // A plain-click http(s) goes to ViewerPane's web view (TODO 400). For modifier keys only the boolean is looked at.
        if (typeof message.url === 'string' && isOpenableExternally(message.url)) {
          openExternalLink(message.url, {
            shiftKey: message.shiftKey === true,
            metaKey: message.metaKey === true,
            ctrlKey: message.ctrlKey === true
          })
        }
        return
      }
      if (message.type === 'open-link') {
        // A link in the viewer's body (item 254). The base is the folder of the file the viewer is drawing (`pushedUri`); how it is resolved, the choke point
        // and existence are main's (`fs.resolveLink`). The viewer's value is passed after checking only type and length.
        if (typeof message.href === 'string' && message.href.length <= MAX_LINK_HREF) {
          openLinkHref(message.href, pushedUri.current)
        }
        return
      }
      if (message.type === 'search-focus') {
        // Focus of the search field inside the viewer (TODO 463). It only reports; whether to switch is main's decision.
        setViewerSearchFocus(searchFocusKey, message.focused === true)
        return
      }
      if (message.type === 'open-default-app') {
        // A request to open with the OS default app (TODO 405, `.avi` of `aios.video`). If it differs from the file the viewer is showing
        // (`pushedUri`), discard it (a mismatch during a switch, same shape as the other messages). Main re-validates.
        // TODO 850: only when a bundled plugin asks about an extension in the table (main also re-validates with the same table and leaves it in the audit).
        if (typeof message.uri === 'string' && message.uri === pushedUri.current && isOpenDefaultAllowed(pluginId, message.uri)) {
          void window.aios.editor.openDefaultApp(message.uri, pluginId)
        }
        return
      }
      if (message.type === 'open-entry') {
        // Open a file inside an archive (zip) in a temporary display (TODO 905). It only puts the bytes the viewer extracted into a temporary display with no URI
        // (the read permission does not grow). Discard it if it differs from the displayed archive (`pushedUri`) or if the shape or size is odd.
        const accepted = acceptOpenEntry(message, pushedUri.current)
        if (accepted !== null) {
          useStore.getState().openTransientFile({ ...accepted, source: archiveLabelOf(pushedUri.current) })
        }
        return
      }
      if (message.type === 'symbols') {
        // Whether a symbol list exists (TODO 468). Accepted only for the file the viewer is drawing (a mismatch during a switch).
        if (typeof message.uri === 'string' && message.uri === pushedUri.current) {
          setSymbolsUri(message.available === true ? message.uri : null)
        }
        return
      }
      if (message.type === 'accepts-edits') {
        // Whether the current view accepts edits (TODO 587). Accepted only for the file the viewer is drawing (a mismatch during a switch).
        const report = acceptAcceptsEdits(message, pushedUri.current)
        if (report !== null) setAcceptsEdits(report)
        return
      }
      if (message.type === 'view-modes') {
        // The selectable views and the current view (TODO 969). Only for the file the viewer is drawing, and only values within the vocabulary are accepted.
        const report = acceptViewModes(message, pushedUri.current)
        if (report !== null) setViewModes(report)
        return
      }
      if (message.type === 'context-menu') {
        // Right-click on selected text (TODO 630). The coordinates are inside the iframe, so to convert them to host-side
        // coordinates we add the iframe's own rectangle (the iframe is a separate document and does not share `clientX`/`clientY`).
        // The shape check and the check for a mismatch during a switch (comparison with `pushedUri`) are inside `latestContextMenu`.
        latestContextMenu.current(message)
        return
      }
      if (message.type === 'command') {
        // Commands from viewer -> plugin-host (7.1). They run inside the isolated process.
        // The reply is returned **only to the port the request came from**. If the iframe was replaced while waiting, it is discarded
        // (formerly it replied to `port.current`, so the previous viewer's reply could reach the new viewer).
        // The replaced iframe's document is gone, so no Promise is left waiting on the viewer side.
        const reply = (response: ViewerHostMessage): void => {
          if (isCurrent()) own.postMessage(response)
        }
        void window.aios.viewer.command(pluginId, message.command, message.arg).then(
          (response) =>
            reply(
              response.ok
                ? { type: 'command-result', id: message.id, result: response.result }
                : { type: 'command-error', id: message.id, message: response.message }
            ),
          (err: unknown) =>
            reply({
              type: 'command-error',
              id: message.id,
              message: err instanceof Error ? err.message : 'error'
            })
        )
      }
    }
    own.start()
    // The other side has an opaque origin, so targetOrigin has to be '*'.
    // Instead, **only the port is handed over**, which limits the channel from then on to this one line.
    target.postMessage({ type: 'aios-port' }, '*', [channel.port2])
    latestPush.current()
    latestPushRecenter.current()
    latestPushLine.current()
  }, [viewer, searchFocusKey, setDraft])

  const loadedAtRender = loaded
  const draftAtRender = draft
  /**
   * True if saved. Also true when there is nothing to write (it is fine to close).
   * `force` (a small observation of TODO 313, wave 17 bundle J): `true` only when called from "Save by overwriting" in the draft-conflict band
   * - it passes no mtime (`expectedMtimeMs: null`) and lets main's conflict check (`ViewerBroker.write`) go
   * through. Normal saving (the heading's "Save" button, Cmd+S) is blocked by `shouldSaveByKey` while a conflict is active, so it does not
   * come here.
   */
  const doSave = useCallback(
    async (options?: {
      readonly force?: boolean
      readonly auto?: boolean
      /**
       * TODO 606 (code-review): use the current copies (`loadedNow` / `draftNow`), not the render's values, as the base and the body. Because the flush before closing
       * calls this function from an old render after waiting for a save in progress. If that save already cleared the draft, nothing is done.
       */
      readonly latest?: boolean
    }): Promise<boolean> => {
      const latest = options?.latest === true
      const loaded = latest ? loadedNow.current : loadedAtRender
      const draft = latest ? draftNow.current : draftAtRender
      const resource = currentResource(uri, viewer, loaded)
      if (uri === null || draft === null || viewer === null || loaded === null || resource === null) return true
      if (resource.kind === 'error' || draftBaseOf(resource) === null) return true
      const saved = draft
      setSave({ kind: 'saving' })
      const expectedMtimeMs = options?.force === true ? null : resource.mtimeMs
      const result = await trackSave(window.aios.viewer.write(viewer.pluginId, uri, saved, expectedMtimeMs))
      if (uriNow.current !== uri) {
        // Code-review (TODO 555): we moved to another file during the round trip (onFocusChange runs the moment another file is pressed).
        // What is displayed (content, draft, conflict band, save marker) belongs to the file we moved to, so it is not touched. Only the draft table
        // of the file we left is tidied: if written and the table's draft is still the body we wrote, remove it. If refused (conflict, etc.), keep it
        // in the table - on return it is restored as before, and for a conflict the band appears.
        const state = useStore.getState()
        if (result.ok && state.viewerDrafts[uri]?.text === saved) state.forgetDraft(uri)
        return result.ok
      }
      if (!result.ok) {
        if (options?.auto === true && result.reason === 'conflict') {
          // TODO 555: the disk side had changed -> no autosave; put it on the draft-conflict band (97 / 92). Later saves go through
          // the band's "Save by overwriting" / "Reload" (`shouldSaveByKey` blocks them while a conflict is active).
          setSave({ kind: 'idle' })
          setDraftConflict({ uri, toolName: null, autoSave: true })
          return false
        }
        if (options?.auto === true) autoSaveFailed.current = saved
        setSave({ kind: 'error', message: SAVE_ERRORS[result.reason ?? 'io'] ?? 'viewer.save.io' })
        return false
      }
      autoSaveFailed.current = null
      // If characters were typed during the save round trip (likely with autosave, TODO 555), keep the newer draft and do not
      // advance the content version - advancing would make the viewer replace the editor with the saved body, losing the typed characters and the cursor.
      const newer = draftNow.current !== null && draftNow.current !== saved
      let nextResource: ViewerResource
      if (resource.kind === 'text') {
        nextResource = { ...resource, text: saved, mtimeMs: result.mtimeMs, size: result.size }
      } else if (newer) {
        // TODO 1212 stage 1: there are cell edits added during the save. The viewer stays on the current display (original workbook + the list of edits) and only the base
        // mtime advances (the next save rewrites the whole list of edits - it only writes the same values, so overlapping changes nothing).
        nextResource = { ...resource, mtimeMs: result.mtimeMs, size: result.size }
      } else {
        // Make the viewer re-read the workbook that was written (the URL changes with the mtime - `withCacheBust`). If it cannot be read, only the base advances.
        const reread = await window.aios.viewer.read(viewer.pluginId, uri)
        nextResource =
          reread.kind === 'binary'
            ? { ...reread, mtimeMs: result.mtimeMs, size: result.size }
            : { ...resource, mtimeMs: result.mtimeMs, size: result.size }
        if (uriNow.current !== uri) {
          // We moved to another file during the re-read (the same cleanup as after the round trip above).
          const state = useStore.getState()
          if (state.viewerDrafts[uri]?.text === saved) state.forgetDraft(uri)
          return true
        }
      }
      const next: LoadedResource = {
        uri,
        pluginId: viewer.pluginId,
        resource: nextResource
      }
      if (newer) revisions.current.carry(loaded, next)
      loadedNow.current = next
      setLoaded(next)
      if (!newer) {
        setDraft(null)
        forgetDraft(uri)
      }
      setSave({ kind: 'idle' })
      setSavedFlash((count) => (count ?? 0) + 1)
      setDraftConflict(null)
      return true
    },
    [uri, draftAtRender, loadedAtRender, viewer, setDraftConflict, forgetDraft, setDraft]
  )

  /**
   * TODO 606: from the flush before closing the window / quitting (`viewer-drafts-close.ts`), have this pane save the displayed file.
   * If `viewer.write` were called from outside, the base mtime held here would stay old, and the next save after cancelling the close would wrongly become a conflict.
   * Nothing is written if a conflict band is showing, it cannot be edited, or the content is not in place (`conflict` / `skip`).
   */
  const latestPaneSave = useRef<() => Promise<PaneSaveResult>>(async () => 'skip')
  latestPaneSave.current = async (): Promise<PaneSaveResult> => {
    if (uri === null || !dirty) return 'skip'
    if (!editable || loaded === null || loaded.uri !== uri) return 'skip'
    // The conflict band is the store's current value (an autosave while waiting may have raised the band - this function may belong to an old render).
    const conflictNow = useStore.getState().draftConflict
    if (conflictNow !== null && conflictNow.uri === uri) return 'conflict'
    // Called after waiting for a save in progress (`flushDrafts`). This function may belong to an old render, so the base and body come from the copies.
    if (await doSave({ auto: true, latest: true })) return 'saved'
    return useStore.getState().draftConflict?.uri === uri ? 'conflict' : 'failed'
  }
  const dirtyNow = useRef(dirty)
  dirtyNow.current = dirty
  useEffect(
    () =>
      registerPaneSaver({
        uri: () => uriNow.current,
        dirty: () => dirtyNow.current,
        save: () => latestPaneSave.current()
      }),
    []
  )

  /** "Save by overwriting" in the conflict band. The band stays a single one (not stacked) - once saved, it disappears with the band. */
  const overwriteAndSave = useCallback(() => {
    void doSave({ force: true })
  }, [doSave])

  // Item 97 second half: "Reload the disk content" of the draft-conflict band. Discards the draft and
  // re-reads what the model wrote (no save - whether to overwrite is the user's next decision).
  const reloadFromDisk = useCallback(async () => {
    if (uri === null || viewer === null) return
    setDraft(null)
    forgetDraft(uri)
    setDraftConflict(null)
    // Even if we moved to another file during the re-read, the origin differs, so it does not become the displayed content.
    const next = await window.aios.viewer.read(viewer.pluginId, uri)
    setLoaded({ uri, pluginId: viewer.pluginId, resource: next })
  }, [uri, viewer, setDraftConflict, forgetDraft, setDraft])

  // TODO 673: an external tool rewrote the file and there is no draft (checked in both main and this window,
  // `planExternalChange` of viewerMemory.ts). Reload silently - with no draft, `reloadFromDisk` is effectively
  // just "re-read the content" (nothing to discard). The scroll position is kept as far as possible without
  // changing the viewer's contract (CodeMirror's `setValue` only swaps the contents of the same EditorView and
  // does not recreate scrollDOM). Changing the uri resets `externalReload` to null on the store side
  // (`select`), so merely switching files does not refire the reload.
  //
  // **Code-review fix (serious 4, data loss)**: it has the same nonce shape as `viewerLine` / `viewerRecenter`,
  // but did not remember whether it had been consumed. Whenever the identity of `viewer` / `reloadFromDisk` changed
  // (through a reselect probe of 471 or a remount), this effect ran again and reloaded the same
  // `externalReload` any number of times as a "new instruction", silently discarding a draft born in the meantime.
  // Remember "up to which nonce we have handled" in a ref like `sentLineNonce` to prevent double handling.
  // In addition, re-check `dirtyNow` right before actually reloading - even if there was no draft when the command arrived
  // (`planExternalChange`), if the user started writing before the effect ran,
  // do not reload and raise the conflict band instead.
  const handledReloadNonce = useRef<number | null>(null)
  const reloadIfExternallyChanged = useCallback(() => {
    if (externalReload === null || externalReload.uri !== uri || viewer === null) return
    if (handledReloadNonce.current === externalReload.nonce) return
    handledReloadNonce.current = externalReload.nonce
    if (dirtyNow.current) {
      setDraftConflict({ uri, toolName: null })
      return
    }
    void reloadFromDisk()
  }, [externalReload, uri, viewer, reloadFromDisk, setDraftConflict])
  useEffect(() => {
    reloadIfExternallyChanged()
  }, [reloadIfExternallyChanged])

  /**
   * x (item 70). If there are unsaved edits, it does not close silently and shows a three-way choice inline.
   * `window.confirm` is not used (on Electron macOS focus does not return, same reason as T19).
   */
  const requestClose = useCallback(() => {
    if (dirty) {
      // TODO 555: if autosave is ON, save without asking and close (same as VS Code). If it cannot be saved (conflict, failure), do not close and
      // show the band / error. If a conflict band is showing or it cannot be edited, the inline three-way choice as before.
      if (autoSaveMode !== 'off' && editable && draftConflict === null && save.kind !== 'saving') {
        void doSave({ auto: true }).then((ok) => {
          if (ok) closeShownView()
        })
        return
      }
      setConfirmClose(true)
      return
    }
    if (uri !== null) forgetDraft(uri)
    closeShownView()
  }, [dirty, uri, forgetDraft, autoSaveMode, editable, draftConflict, save.kind, doSave])

  // TODO 843: Cmd+W / Ctrl+W calls the same requestClose as x (the reference changes every render, so go through a ref).
  const latestRequestClose = useRef(requestClose)
  latestRequestClose.current = requestClose
  useEffect(() => registerViewerCloser(() => latestRequestClose.current()), [])

  /** "Close without saving" in the unsaved confirmation. Closing = the intent to discard the draft, so it is also removed from the table (TODO 312). */
  const discardAndClose = useCallback(() => {
    if (uri !== null) forgetDraft(uri)
    closeShownView()
  }, [uri, forgetDraft])

  const saveAndClose = useCallback(async () => {
    setConfirmClose(false)
    // If it fails, do not close. The reason appears in the save error display.
    if (await doSave()) closeShownView()
  }, [doSave])

  // Save by key / menu (item 313). Do nothing if it cannot be edited, there is no draft, a save is in progress, or a draft conflict is active
  // (during a conflict only from the band's "Save by overwriting" - a small observation of TODO 313, wave 17 bundle J).
  const saveByKey = useCallback(() => {
    if (shouldSaveByKey({ editable, dirty, saving: save.kind === 'saving', conflict: draftConflict !== null })) {
      void doSave()
    }
  }, [editable, dirty, save.kind, draftConflict, doSave])
  latestSaveByKey.current = saveByKey

  // TODO 555: autosave. The decision is in `viewer-auto-save.ts`, and the save is `doSave` above (it passes the base mtime, so main refuses a conflict).
  const autoSaveGate = {
    mode: autoSaveMode,
    editable,
    dirty,
    saving: save.kind === 'saving',
    conflict: draftConflict !== null,
    failedBefore: draft !== null && draft === autoSaveFailed.current
  }
  const autoSaveNow = useCallback(() => {
    void doSave({ auto: true })
  }, [doSave])
  const latestAutoSave = useRef<() => void>(() => undefined)
  latestAutoSave.current = canAutoSave(autoSaveGate) ? autoSaveNow : () => undefined
  const delayArmed = armsDelay(autoSaveGate)
  // TODO 1212 stage 1: one save of `.xlsx` rewrites the whole file, so a lower bound is put on the wait (`autoSaveDelayFor`).
  const effectiveDelayMs = autoSaveDelayFor(autoSaveDelayMs, cellEditable)
  // afterDelay: reset every time the draft changes (`draft` is a dependency). Save once `delayMs` has passed after it goes quiet.
  useEffect(() => {
    if (!delayArmed) return
    const timer = setTimeout(() => latestAutoSave.current(), effectiveDelayMs)
    return () => clearTimeout(timer)
  }, [delayArmed, draft, effectiveDelayMs])
  // onFocusChange: save when the viewer (iframe) loses focus (another place in the window, another app).
  const watchesFocus = autoSaveMode === 'onFocusChange' && viewer !== null
  useEffect(() => {
    if (!watchesFocus) return
    return watchFrameFocusLoss(window, () => frame.current, () => latestAutoSave.current())
  }, [watchesFocus])
  // TODO 1300: focus going into the viewer (its iframe, which the parent only sees as its own blur) makes Files follow the shown file.
  const hasFrame = viewer !== null
  useEffect(() => {
    if (!hasFrame) return
    return watchFrameFocusEnter(window, () => frame.current, followShownFile)
  }, [hasFrame])

  // TODO 969: the "Saved" flash disappears `SAVED_FLASH_MS` after a successful save. If saved again in a row, the count restarts.
  useEffect(() => {
    if (savedFlash === null) return
    const timer = setTimeout(() => setSavedFlash(null), SAVED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [savedFlash])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isSaveShortcut(event)) {
        // Do not show the browser's "Save page".
        event.preventDefault()
        latestSaveByKey.current()
      }
    }
    window.addEventListener('keydown', onKey)
    // The "Save" of the File menu. The accelerator is consumed by electron first, so it works even when the
    // viewer (OOPIF) has focus. The destination is only the focused window.
    const unsubscribe = window.aios.app.onMenuCommand((command) => {
      if (command === 'save') latestSaveByKey.current()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      unsubscribe()
    }
  }, [])

  // A state without a header (loading, no viewer) puts only x in the top right corner (item 70). Unsaved edits are
  // impossible (there is no viewer yet), so no confirmation is needed. With nothing shown (TODO 1297: the pane is always
  // there) there is nothing to close, so the empty state has no x.
  const emptyState = (message: string): React.JSX.Element => (
    <div className="viewer-pane empty">
      <CloseButton onClick={closeShownView} floating />
      {message}
    </div>
  )
  if (uri === null) return <div className="viewer-pane empty">{t('viewer.empty')}</div>
  if (loaded === null) return emptyState(t('common.loading'))
  if (viewer === null) return emptyState(t('viewer.noViewer'))
  const indicator = saveIndicator({
    editable,
    dirty,
    saving: save.kind === 'saving',
    justSaved: savedFlash !== null
  })

  return (
    // TODO 1300: a click or focus anywhere in the pane (heading included) makes Files follow the shown local file.
    <div className="viewer-pane" onPointerDownCapture={followShownFile} onFocusCapture={followShownFile}>
      <div className="viewer-header" style={accent} data-plugin-id={viewer.pluginId}>
        {/* TODO 369: back / forward (at the left end of the heading, like VS Code's Go Back / Go Forward). */}
        <span className="viewer-nav-group">
          <NavButton id="viewerBack" enabled={nav.back} />
          <NavButton id="viewerForward" enabled={nav.forward} />
        </span>
        {/* TODO 970: the always-typeable address bar (path / URL). Uses all the remaining width of the heading (`.viewer-address`). */}
        <ViewerAddressBar
          uri={uri}
          homeUri={homeUri}
          // TODO 299: right-click menu (open in editor / copy path / show in Finder / new chat here).
          onContextMenu={(event) =>
            openMenu(
              event,
              pathContextMenuItems(uri, false, t, platform, {
                openInEditor: (target) => openInEditor(target, { line: selectionFromLine }),
                openInDefaultApp: openDefault,
                reveal: (target, dir) => window.aios.editor.reveal(target, dir),
                createThreadInFolder
              })
            )
          }
        />
        {/* TODO 558: for a symlink file, the real target is shown dimly next to the link's path (owner decision). */}
        {viewer.linkTargetUri === undefined ? null : (
          <span className="viewer-link-target" title={t('viewer.linkTarget')}>
            → {displayPath(viewer.linkTargetUri, homeUri)}
          </span>
        )}
        {showsViewModes(viewModes, uri) ? <ViewerModeSwitch report={viewModes} onChange={changeViewMode} /> : null}
        {indicator === 'save' ? (
          // TODO 969: the save button, shown only when there is a change. The condition for being pressable is as before (`shouldSaveByKey`).
          <button
            type="button"
            className="viewer-save"
            onClick={() => void doSave()}
            // During a draft conflict, saving is not done here (a small observation of TODO 313) - use the band's "Save by overwriting".
            disabled={
              !shouldSaveByKey({
                editable,
                dirty,
                saving: save.kind === 'saving',
                conflict: draftConflict !== null
              })
            }
          >
            {t('viewer.save')}
          </button>
        ) : indicator === 'saving' ? (
          <span className="viewer-save-status">{t('viewer.saving')}</span>
        ) : indicator === 'saved' ? (
          // TODO 969: shown only right after a successful save (not a button). Disappears after `SAVED_FLASH_MS`.
          <span className="viewer-save-status viewer-saved" role="status">
            <span aria-hidden="true">✅</span> {t('viewer.saved')}
          </span>
        ) : null}
        {symbolsUri !== null && symbolsUri === uri ? (
          // TODO 468: the list of symbols in the file (Cmd+R). Not shown for languages and text that have no symbol table.
          <Tooltip content={`${t('viewer.symbols')} (${symbolsKeyLabel(NAV_KEY_PLATFORM)})`}>
            <button
              type="button"
              className="icon-button viewer-symbols"
              onClick={openSymbols}
              aria-label={t('viewer.symbols')}
            >
              <SymbolsIcon />
            </button>
          </Tooltip>
        ) : null}
        {choices !== null && showReopenWith(choices) ? (
          // TODO 907: open with another viewer (VS Code's Reopen Editor With...). The chosen viewer becomes the default for that extension.
          <Tooltip content={t('viewer.reopenWith')}>
            <button
              type="button"
              className="icon-button viewer-reopen-with"
              aria-label={t('viewer.reopenWith')}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const isDirty = dirty
                openMenu(
                  {
                    preventDefault: () => event.preventDefault(),
                    stopPropagation: () => event.stopPropagation(),
                    clientX: rect.left,
                    clientY: rect.bottom
                  },
                  reopenMenuEntries(choices, viewer.pluginId).map((entry) => ({
                    key: `reopen-with:${entry.pluginId}`,
                    label: entry.builtinDefault
                      ? t('viewer.reopenWith.default', { name: entry.name })
                      : entry.name,
                    checked: entry.checked,
                    onSelect: () => reopenWith(entry, isDirty)
                  }))
                )
              }}
            >
              <ReopenWithIcon />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content={t(openButtonLabelKey(uri, { line: selectionFromLine }, 'viewer.openInEditor'))}>
          <button
            type="button"
            className="icon-button viewer-open-editor"
            onClick={() => void openFile(uri, { line: selectionFromLine })}
            aria-label={t(openButtonLabelKey(uri, { line: selectionFromLine }, 'viewer.openInEditor'))}
          >
            <OpenExternalIcon />
          </button>
        </Tooltip>
        {canShowInFiles(uri) ? (
          // TODO 1007: in the sidebar's Files, open the tree down to this file and select it (Show in Finder is PathActions).
          <Tooltip content={t('viewer.showInFiles')}>
            <button
              type="button"
              className="icon-button viewer-show-in-files"
              onClick={() => showInFiles(uri)}
              aria-label={t('viewer.showInFiles')}
            >
              <ShowInFilesIcon />
            </button>
          </Tooltip>
        ) : null}
        <PathActions uri={uri} />
        <CloseButton onClick={requestClose} />
      </div>
      {confirmClose && dirty ? (
        <div className="viewer-banner viewer-confirm" role="alert">
          <span>{t('viewer.unsaved')}</span>
          <button type="button" className="danger" onClick={discardAndClose}>
            {t('viewer.closeWithoutSaving')}
          </button>
          <button type="button" onClick={() => void saveAndClose()}>
            {t('viewer.saveAndClose')}
          </button>
          <button type="button" onClick={() => setConfirmClose(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
      {save.kind === 'error' ? <div className="viewer-banner error">{t(save.message)}</div> : null}
      {reopenBlocked && dirty ? (
        <div className="viewer-banner error viewer-reopen-blocked" role="alert">
          <span>{t('viewer.reopenWith.blocked')}</span>
          <button type="button" onClick={() => setReopenBlocked(false)}>
            {t('common.close')}
          </button>
        </div>
      ) : null}
      {reopenFailed ? (
        <div className="viewer-banner error viewer-reopen-failed" role="alert">
          <span>{t('viewer.reopenWith.failed')}</span>
          <button type="button" onClick={() => setReopenFailed(false)}>
            {t('common.close')}
          </button>
        </div>
      ) : null}
      {draftConflict !== null ? (
        <DraftConflictBanner
          conflict={draftConflict}
          onReload={() => void reloadFromDisk()}
          onOverwrite={overwriteAndSave}
          onDismiss={() => setDraftConflict(null)}
        />
      ) : null}
      {dropDenied.length > 0 ? (
        <div className="viewer-banner error viewer-drop-denied" role="alert">
          <span>
            {t('viewer.drop.denied', {
              name: uriBasename(dropDenied[0]?.uri ?? '') || '?',
              reason: describeReason(t, dropDenied[0]?.reason)
            })}
            {dropDenied.length > 1 ? ` ${t('viewer.drop.deniedMore', { count: dropDenied.length - 1 })}` : ''}
          </span>
          <button type="button" onClick={() => setDropDenied([])}>
            {t('common.close')}
          </button>
        </div>
      ) : null}
      {/*
        The drag target is here, the parent of the overlay (TODO 429). dragover / drop on the overlay bubble up, and even if the finger is released
        while the overlay has momentarily disappeared, `preventDefault` is called here and it flows to the same path (`overlay-drop`).
      */}
      <div
        className={drop.dragging ? 'viewer-body viewer-dropping' : 'viewer-body'}
        onDragOver={drop.handlers.onDragOver}
        onDragLeave={drop.handlers.onDragLeave}
        onDrop={drop.handlers.onDrop}
      >
        {/*
          Isolation (7.8): without allow-same-origin it becomes an opaque origin.
          Plugin code can touch neither the renderer's DOM nor window.aios.

          `allow="clipboard-write"` is for the viewer's copy button (5.1.2.1, T25).
          **An iframe with an opaque origin is not covered by the Permissions Policy default (`self`)**,
          so without this `navigator.clipboard.writeText` fails with
          "blocked because of a permissions policy" (measured). **Write only**;
          `clipboard-read` is not granted (the plugin cannot read the clipboard).
        */}
        <iframe
          ref={frame}
          className="viewer-frame"
          title={viewer.name}
          src={viewer.url}
          sandbox="allow-scripts"
          allow="clipboard-write"
          onLoad={onLoad}
        />
        {drop.dragging ? (
          // A drag over the iframe (OOPIF) does not reach the parent, so during a drag only, a transparent overlay receives it (TODO 366).
          // Meanwhile `pointer-events: none` is also applied to the iframe (`.viewer-dropping .viewer-frame`, TODO 407).
          // Drag events are received by the parent `.viewer-body` (429). With pointer events, it disappears only when dragover stops.
          <div
            className="viewer-drop-overlay"
            data-testid="viewer-drop-overlay"
            onPointerMove={drop.handlers.onPointerMove}
            onPointerDown={drop.handlers.onPointerDown}
          />
        ) : null}
      </div>
      <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </div>
  )
}

/**
 * If there is a temporary display (item 104, diff), bring it to the front and hide the file's viewer **while keeping it alive in the background**
 * (`.viewer-transient + .viewer-pane` is removed in CSS). The position of the second child does not change, so
 * `FileViewerPane` is not recreated, and closing the temporary display with x returns to the original file together with its draft.
 */
export function ViewerPane(): React.JSX.Element {
  const transient = useStore((state) => state.transient)
  // An http(s) URL is a web page (TODO 400). It is placed in the same position (second child) in place of the file's viewer, so
  // while a temporary diff display is in front, it is hidden by the same CSS.
  // A blank tab (`about:blank`, TODO 522) is also drawn with the web heading (URL field).
  const webUri = useStore((state) => (isWebPaneUri(state.selectedUri) ? state.selectedUri : null))
  return (
    <>
      {transient !== null ? <TransientViewerPane transient={transient} /> : null}
      {webUri !== null ? <WebPane uri={webUri} /> : <FileViewerPane />}
    </>
  )
}

/**
 * Give the web page's heading the same back / forward and x as the file viewer (TODO 400). x closes the current Web tab
 * like ⌘W (TODO 1297, a browser's tab close): `closeWebTab` goes back to what was shown before it (TODO 832 (2)).
 */
function WebPane({ uri }: { readonly uri: string }): React.JSX.Element {
  const nav = useViewerNavState()
  return (
    <WebViewerPane
      uri={uri}
      nav={
        <span className="viewer-nav-group">
          <NavButton id="viewerBack" enabled={nav.back} />
          <NavButton id="viewerForward" enabled={nav.forward} />
        </span>
      }
      close={
        <CloseButton
          onClick={() => {
            const { activeId } = useWeb.getState().tabs
            if (activeId !== null) {
              void closeWebTab(activeId)
              return
            }
            // No tab is current (should not happen): close the views kept alive (TODO 580) and fall back to the history.
            markWebPaneClosing()
            closeShownView()
          }}
        />
      }
    />
  )
}
