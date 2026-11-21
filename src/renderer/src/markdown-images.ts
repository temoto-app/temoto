/**
 * Local images in an answer's Markdown (`![](/abs/x.png)`, relative to cwd, TODO 876, ARCHITECTURE.md 5.1).
 *
 * The renderer's CSP does not allow `file:` (`img-src 'self' aios-res: aios-plugin: data:`), so putting the body's `<img src>` as is
 * makes the load get blocked by the CSP and the image breaks. So:
 *
 * 1. `deferLocalImages(html)`: **before** rendering, move the `src` of `<img>` pointing at local files into `data-local-src`
 *    (the inside of a `<template>` is inert, so no image load starts meanwhile). External `http(s)` / `data:` / `aios-res:`
 *    images are left alone (external images are unchanged this time).
 * 2. `resolveLocalImages(root, threadId)`: **after** rendering, pass the moved `src` to main and turn it into an `aios-res://`
 *    URL (`threads.timelineImage`). Opening the path and passing it through the choke point are done by main; the renderer just
 *    receives a URL. For images that were refused (outside the range, excluded, not an image, missing), stop using `<img>` and show the alt text.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Whether `src` points at a local file (`file:`, absolute, `~/`, relative). External schemes and a leading `//` do not. */
export function isLocalImageSrc(src: string): boolean {
  const value = src.trim()
  if (value === '' || value.startsWith('//') || value.startsWith('#')) return false
  if (/^file:/i.test(value)) return true
  return !SCHEME.test(value)
}

/** Resolved URLs (thread + src -> URL). The Broker drops old tokens, so on a load failure (`onerror`) drop the entry and look it up again. */
const urls = new Map<string, string>()
/** How long to remember an unresolved result. Prevents IPC on every re-render (the answer stream re-renders on every delta). */
const NEGATIVE_TTL_MS = 5000
const misses = new Map<string, number>()
const inflight = new Map<string, Promise<string | null>>()

const keyOf = (threadId: string, src: string): string => `${threadId}\0${src}`

/** The pre-render deferral. If there is no local `<img>`, return the input as is (no DOM is built). For resolved ones, apply src directly (no flicker). */
export function deferLocalImages(html: string, threadId: string | null = null): string {
  if (!html.includes('<img')) return html
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  for (const img of Array.from(template.content.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (src === null || !isLocalImageSrc(src)) continue
    img.setAttribute('data-local-src', src)
    const url = threadId === null ? undefined : urls.get(keyOf(threadId, src))
    if (url === undefined) img.removeAttribute('src')
    else img.setAttribute('src', url)
    changed = true
  }
  return changed ? template.innerHTML : html
}

function urlOf(threadId: string, src: string, fresh: boolean): Promise<string | null> {
  const key = keyOf(threadId, src)
  if (fresh) {
    urls.delete(key)
    misses.delete(key)
  } else {
    const known = urls.get(key)
    if (known !== undefined) return Promise.resolve(known)
    const until = misses.get(key)
    if (until !== undefined) {
      if (until > Date.now()) return Promise.resolve(null)
      misses.delete(key)
    }
  }
  let pending = inflight.get(key)
  if (pending === undefined) {
    pending = window.aios.threads.timelineImage(threadId, src).catch(() => null)
    inflight.set(key, pending)
    void pending.then((url) => {
      inflight.delete(key)
      if (url === null) misses.set(key, Date.now() + NEGATIVE_TTL_MS)
      else urls.set(key, url)
    })
  }
  return pending
}

/** For tests: drop the remembered URLs. */
export function clearLocalImageCache(): void {
  urls.clear()
  misses.clear()
  inflight.clear()
}

/** Resolve the deferred `<img>`s inside `root`. Touch nothing once `alive()` becomes false (re-render, unmount). */
export function resolveLocalImages(root: HTMLElement, threadId: string | null, alive: () => boolean): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-local-src]'))) {
    const src = img.getAttribute('data-local-src') ?? ''
    const fallback = (): void => {
      if (!alive() || !img.isConnected) return
      const note = document.createElement('span')
      note.className = 'markdown-image-missing'
      note.textContent = img.alt === '' ? '🖼' : `🖼 ${img.alt}`
      img.replaceWith(note)
    }
    if (threadId === null) {
      fallback()
      continue
    }
    // On a load failure (the Broker dropped the token, etc.), drop the remembered URL and look it up once more; if that fails too, use the alt text.
    img.addEventListener(
      'error',
      () => {
        void urlOf(threadId, src, true).then((url) => {
          if (!alive() || !img.isConnected) return
          if (url === null) {
            fallback()
            return
          }
          img.addEventListener('error', fallback, { once: true })
          img.setAttribute('src', url)
        })
      },
      { once: true }
    )
    if (img.getAttribute('src') !== null) continue
    void urlOf(threadId, src, false).then((url) => {
      if (!alive() || !img.isConnected) return
      if (url === null) fallback()
      else img.setAttribute('src', url)
    })
  }
}
