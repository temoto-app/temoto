/**
 * `aios.image` — png / jpg / gif / webp and others (ARCHITECTURE.md 7.3 / 7.4).
 *
 * The image itself is served by main's `aios-res://` protocol handler.
 * **The viewer only receives a URL and does not read the file.** The Broker's path check
 * runs before serving, so a file outside the allowed range does not surface.
 */
import '@pluginshared/viewer.css'
import { connect } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { connectFilterModes, mountZoom } from '@pluginshared/zoom.js'

const bridge = connect('aios.image')
const root = document.getElementById('root')
/** The heading's interpolation switch (TODO 1200). Records and reports the zoom of the shown image (null = no image). */
const showFilterModes = connectFilterModes(bridge)

/**
 * Show a message. It also clears the interpolation switch (TODO 1200, the host's heading) — there is no image, so nothing to choose.
 * `uri` is the file being shown (empty string for a temporary view).
 */
function message(text: string, uri: string): void {
  showFilterModes(uri, null)
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
}

let shown: { readonly url: string; readonly img: HTMLImageElement } | null = null

bridge.onResource((event) => {
  if (root === null) return
  if (event.resource.kind === 'error') {
    // In a temporary view (a HEIC inside a zip), main could not convert it (TODO 1162).
    // Wording per reason (wave 77 review Y): even on macOS, it does not say "macOS only".
    const reasons: Readonly<Record<string, 'imageUnsupportedFormat' | 'imageConvertFailed' | 'imageTooLarge'>> = {
      'unsupported-format': 'imageUnsupportedFormat',
      'convert-failed': 'imageConvertFailed',
      'too-large': 'imageTooLarge'
    }
    const key = reasons[event.resource.message]
    if (key !== undefined) {
      message(vt(key), event.uri)
      return
    }
    message(vt('cannotOpen', { reason: event.resource.message }), event.uri)
    return
  }
  if (event.resource.kind !== 'binary') {
    message(vt('notImage'), event.uri)
    return
  }

  // Do not touch the element on a resend of the same contents (theme, language, etc.) (TODO 1131: reload flicker).
  const url = event.resource.resourceUrl
  if (shown !== null && shown.url === url && shown.img.isConnected) return
  root.textContent = ''
  const frame = document.createElement('div')
  frame.className = 'image-viewer'
  const img = document.createElement('img')
  img.alt = ''
  img.src = url
  shown = { url, img }
  // HEIC / HEIF is converted by main with sips and returned (TODO 1154). If it cannot be converted (non-macOS, or a failure), it is a 415 and arrives here.
  const converted = /\.(heic|heif)$/i.test(event.uri)
  img.addEventListener('error', () => message(vt(converted ? 'imageUnsupportedFormat' : 'imageFailed'), event.uri))
  frame.append(img)
  // Zoom (TODO 1188): open at actual size (1 image px = 1 physical px); small pictures get an integer multiple. The size is known only after load.
  const bar = document.createElement('div')
  const zoom = mountZoom(bar, frame, img)
  // The interpolation switch (Nearest / Bilinear) goes in the host's heading (TODO 1200). Nearest every time it opens (not remembered).
  showFilterModes(event.uri, zoom)
  const natural = (): void => zoom.setNatural(img.naturalWidth, img.naturalHeight)
  const meta = document.createElement('div')
  meta.className = 'image-meta'
  meta.textContent = `${(event.resource.size / 1024).toFixed(1)} KB`
  root.append(bar, frame, meta)
  // Measure the initial scale after attaching to the DOM (even with a cached `complete`, the frame size does not become 0 — review Y-2).
  if (img.complete) natural()
  else img.addEventListener('load', natural)
})
