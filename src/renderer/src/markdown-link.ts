/**
 * When a link in the body is pressed (item 254, ARCHITECTURE.md 5.1 / 5.1.1). Shared by the ThreadPane body and the
 * `aios.markdown` viewer (relayed by the host's ViewerPane).
 *
 * - `http:` / `https:` -> the ViewerPane web view (TODO 400). shift / ⌘ + click goes to the OS browser.
 * - `mailto:` -> ask main to "open this externally" (main re-validates).
 * - `file:`, relative, no scheme -> resolved by main's `fs.resolveLink`. The base is the folder of `baseUri` (the .md open in
 *   the viewer), else the active thread's cwd, then auto memory. If resolved, it opens in the ViewerPane; if not, the reason
 *   is shown in the band at the top of the window (`app-error`, the existing mechanism) and disappears after a few seconds.
 *   **A folder switches to Files mode and opens that folder** (TODO 586, the same path as `revealFolderInFiles` of 436).
 * - `thread://<threadId>/<eventId>` (TODO 1155, a message in a past conversation) -> ask main where it is (`threads.locateLink`),
 *   select that conversation in the thread list and move to the message (the same `jumpToEvent` as a conversation-search ⌘K hit).
 *   If it was deleted, the band offers the Japanese UI's "restore and open" action; if it does not exist, a band with the reason.
 * - Anything else (an in-page `#heading`, empty, an unknown scheme) -> do nothing.
 *
 * **The renderer does not decide**: it only sorts (`linkAction`); how to resolve, the choke point, and existence are main's.
 */
import { linkAction } from '@shared/link.js'
import { parseThreadLink, threadLinkStep, type ThreadLinkStep, type ThreadLinkTarget } from '@shared/thread-link.js'
import { isWebViewerUrl, webLinkTarget, type LinkClickModifiers } from '@shared/open-external.js'
import { slackMessageOf } from '@shared/slack-link.js'
import { useStore } from './store.js'
import { revealFolderInFiles } from './shortcut-actions.js'
import { useThreads } from './threadStore.js'
import { hasLinkNextSteps, popoverKindFor, useLinkNotice, useLinkPopover } from './linkNoticeStore.js'
import { openWebUrl } from './webStore.js'

/** How long (ms) to keep the "not found" band up. Pressing it dismisses it earlier (the existing behavior of `app-error`). */
export const LINK_NOTICE_MS = 6000

let noticeTimer: ReturnType<typeof setTimeout> | null = null

/** Show the reason in the band and clear it after `LINK_NOTICE_MS` (if the reason is still the same). A substitute for a toast. */
export function notify(reason: string): void {
  useThreads.setState({ error: reason })
  if (noticeTimer !== null) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    if (useThreads.getState().error === reason) useThreads.setState({ error: null })
  }, LINK_NOTICE_MS)
}

/**
 * Open an external link (`http:` / `https:` / `mailto:`) (TODO 400). A plain click on `http(s)` goes to the ViewerPane web view;
 * shift / ⌘ (Ctrl) + click and `mailto:` go to the OS browser / mail client. In both cases main re-validates.
 * Links in the timeline, the `aios.markdown` preview, and the `fetch` tool rows all go through the same rule.
 */
export function openExternalLink(url: string, modifiers: LinkClickModifiers = {}): void {
  const target = webLinkTarget(url, modifiers)
  // TODO 522: a web page in the ViewerPane opens as a new tab (listed under "open tabs" in the Sidebar's web mode).
  if (target === 'viewer') {
    // TODO 553: a Slack message link is, if the workspace is a remembered one, rewritten into a form that skips the relay page
    // before opening (the table and the rewrite are main's, `@shared/slack-link.js`). Anything else opens in place as before.
    if (slackMessageOf(url) === null) openWebUrl(url, true)
    else {
      void window.aios.web.resolveLink(url).then(
        (next) => openWebUrl(isWebViewerUrl(next) ? next : url, true),
        () => openWebUrl(url, true)
      )
    }
  } else if (target === 'external') void window.aios.app.openExternal(url)
}

/**
 * Open a `thread://` link (TODO 1155). main checks where it is (and re-validates the id's shape); the dispatch is `threadLinkStep`.
 */
export async function openThreadLink(target: ThreadLinkTarget): Promise<void> {
  useLinkNotice.getState().clear()
  useLinkPopover.getState().clear()
  try {
    const location = await window.aios.threads.locateLink(target.threadId, target.eventId)
    applyThreadLinkStep(threadLinkStep(target, location))
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err))
  }
}

/** Carry out the dispatch result. The "restore and open" action of `LinkNotice` also comes here after the restore. */
export function applyThreadLinkStep(step: ThreadLinkStep): void {
  const threads = useThreads.getState()
  switch (step.kind) {
    case 'jump':
    case 'open':
      // The acceptance condition is "selected in the thread list". If in another mode (Files, etc.), return to the thread list
      // (`setMode` collapses when the same mode is pressed, so it is not used).
      if (threads.mode !== 'threads') useThreads.setState({ mode: 'threads' })
      if (step.kind === 'jump') void threads.jumpToEvent(step.threadId, step.eventId)
      else {
        void threads.selectThread(step.threadId)
        if (step.reason !== null) notify(step.reason)
      }
      return
    case 'deleted':
      if (useThreads.getState().error !== null) useThreads.setState({ error: null })
      useLinkNotice.getState().show({ ok: false, reason: 'thread-link-deleted', restoreThread: step.target })
      return
    case 'missing':
      notify('thread-link-not-found')
  }
}

/** TODO 995: serial number of the last pressed link. So that the result of an earlier link that returns late does not show a bubble. */
let linkClickSeq = 0

/** Open `href`. `baseUri` is the file used as the base for relative links (the .md in the viewer). null for the ThreadPane. */
export function openLinkHref(
  href: string | null,
  baseUri: string | null,
  modifiers: LinkClickModifiers = {},
  /** Called instead of the band when it could not be resolved (`link-not-found`) (TODO 970: if it looks like a host name, open it in Web). */
  onNotFound?: () => void,
  /** TODO 995: position of the pressed link (viewport). If given, a bubble is shown next to it when unresolved (not found / excluded). */
  anchor?: { x: number; y: number }
): void {
  // TODO 1155: a link to a message in a past conversation. `linkAction` makes `thread:` 'none' (shared with the plugin viewer), so check this first.
  const threadTarget = parseThreadLink(href)
  if (threadTarget !== null) {
    void openThreadLink(threadTarget)
    return
  }
  const action = linkAction(href)
  if (href === null || action === 'none') return
  if (action === 'external') {
    openExternalLink(href.trim(), modifiers)
    return
  }
  const threadId = useThreads.getState().activeThreadId
  // Dismiss the previous link's band (TODO 808 / 816) when the next link is pressed.
  useLinkNotice.getState().clear()
  useLinkPopover.getState().clear()
  const clickSeq = ++linkClickSeq
  void window.aios.fs.resolveLink({ href, threadId, baseUri }).then(
    (result) => {
      // TODO 995: when unresolved, also show a small bubble next to the pressed link (the band is still shown below as before).
      if (!result.ok && anchor !== undefined && onNotFound === undefined && clickSeq === linkClickSeq) {
        const kind = popoverKindFor(result.reason)
        if (kind !== null) useLinkPopover.getState().show(anchor, kind)
      }
      // With a line (`foo.ts:42` / `#L42`), jump to that line (item 273). One-shot, not kept in the memory.
      if (result.ok && result.directory === true) revealFolderInFiles(result.uri)
      else if (result.ok) {
        useStore.getState().select(result.uri, { line: result.line ?? null, column: result.column ?? null })
      } else if (onNotFound !== undefined && result.reason === 'link-not-found') {
        onNotFound()
      } else if (hasLinkNextSteps(result)) {
        // The candidate list, the tried paths, "search by name", and the hand-off entry point (TODO 808 / 816) go to the band (`LinkNotice`).
        if (useThreads.getState().error !== null) useThreads.setState({ error: null })
        useLinkNotice.getState().show(result)
      } else notify(result.reason)
    },
    (err: unknown) => notify(err instanceof Error ? err.message : String(err))
  )
}
