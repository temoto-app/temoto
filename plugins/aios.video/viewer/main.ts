/**
 * `aios.video` — mp4 / m4v / mov / webm / avi, and audio wav / mp3 / m4a / ogg / flac (TODO 1271) (ARCHITECTURE.md 7.3 / 7.4).
 *
 * The media itself is served by main's `aios-res://` protocol handler. **The viewer only receives a URL
 * and does not read the file.** Chromium fetches Range directly for `<video>` playback,
 * so the whole file need not be read (exactly the Range support of `protocol.ts`).
 *
 * **`.avi` cannot be played in Chromium** (both the container and most codecs are unsupported, TODO 405).
 * It is recognized first by extension, and no `<video>` is created; it falls back to a notice + "open with the default app".
 * For `.mov` the codec cannot be known from the extension alone, so `<video>` is tried and, on `error`, it falls back to the same notice.
 *
 * A temporary view (TODO 905, a video inside a zip) has no URI (`uri` is empty). There is no file to hand to the default app, so
 * the button is not shown and the reason is shown instead. The extension is taken from the last element of the heading (`a.zip › dir/x.avi`).
 */
import '@pluginshared/viewer.css'
import { connect } from '@pluginshared/bridge.js'
import { vt } from '@pluginshared/i18n.js'
import { connectFilterModes, mountZoom } from '@pluginshared/zoom.js'
import { uriExtension } from '@shared/uri.js'
import { transientFileBaseName } from '@shared/transient-file.js'

const bridge = connect('aios.video')
const root = document.getElementById('root')

/** Audio (TODO 1271): played with a plain `<audio controls>` (play / pause, seek, position and time, volume are Chromium's own). */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac'])

/** Extensions known not to play in Chromium's `<video>` (TODO 405). */
const UNPLAYABLE_EXTENSIONS: ReadonlySet<string> = new Set(['avi'])

/** The heading's interpolation switch (TODO 1200). Records and reports the zoom of the video being shown (null = no playable video). */
const showFilterModes = connectFilterModes(bridge)

function message(text: string, uri: string): void {
  showFilterModes(uri, null)
  if (root === null) return
  root.textContent = ''
  const div = document.createElement('div')
  div.className = 'message'
  div.textContent = text
  root.append(div)
}

/**
 * "This format cannot be played here" + "Open with the default app" (TODO 405). For a temporary view with no URI (TODO 905), instead of the button,
 * "A video inside an archive cannot be opened with the default app".
 */
function fallback(uri: string, isAudio = false): void {
  showFilterModes(uri, null)
  if (root === null) return
  root.textContent = ''
  const frame = document.createElement('div')
  frame.className = 'video-fallback'
  const text = document.createElement('div')
  text.textContent = vt(isAudio ? 'audioUnplayable' : 'videoUnplayable')
  frame.append(text)
  if (uri === '') {
    const note = document.createElement('div')
    note.textContent = vt('videoNoDefaultApp')
    frame.append(note)
  } else {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = vt('openWithDefaultApp')
    button.addEventListener('click', () => bridge.openDefaultApp(uri))
    frame.append(button)
  }
  root.append(frame)
}

/** The extension (lowercase). For a temporary view the URI is empty, so take it from the last element of the heading. */
function extensionOf(uri: string, label: string): string {
  if (uri !== '') return uriExtension(uri)
  const base = transientFileBaseName(label)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** The `<video>` now shown and its URL. If the contents change, the URL changes too (`withCacheBust`). */
let shown: { readonly url: string; readonly video: HTMLMediaElement } | null = null

bridge.onResource((event) => {
  if (root === null) return
  if (event.resource.kind === 'error') {
    message(vt('cannotOpen', { reason: event.resource.message }), event.uri)
    return
  }
  if (event.resource.kind !== 'binary') {
    message(vt('notVideo'), event.uri)
    return
  }

  const extension = extensionOf(event.uri, event.label)
  if (UNPLAYABLE_EXTENSIONS.has(extension)) {
    fallback(event.uri)
    return
  }
  const isAudio = AUDIO_EXTENSIONS.has(extension)

  // Do not touch the element on a resend of the same contents (theme, language, a change of key assignments) (TODO 1131: playback went back to the start and stopped).
  const url = event.resource.resourceUrl
  if (shown !== null && shown.url === url && shown.video.isConnected) return
  root.textContent = ''
  if (isAudio) {
    // No zoom or interpolation switch for audio (null hides it in the heading).
    showFilterModes(event.uri, null)
    const frame = document.createElement('div')
    frame.className = 'audio-viewer'
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = url
    shown = { url, video: audio }
    audio.addEventListener('error', () => fallback(event.uri, true))
    frame.append(audio)
    root.append(frame)
    return
  }
  const frame = document.createElement('div')
  frame.className = 'video-viewer'
  const video = document.createElement('video')
  video.controls = true
  video.src = url
  shown = { url, video }
  // For `.mov` and the like, the codec cannot be known from the extension alone. If Chromium cannot play it, it falls here.
  video.addEventListener('error', () => fallback(event.uri))
  frame.append(video)
  // Zoom (TODO 1188): the video's size is known only after loadedmetadata. A video larger than the frame is shrunk to fit (so the controls do not go outside the frame — review Y-3).
  const bar = document.createElement('div')
  const zoom = mountZoom(bar, frame, video, { shrinkToFit: true })
  // The interpolation switch (Nearest / Bilinear) goes in the host's heading (TODO 1200). Nearest every time it opens (not remembered).
  showFilterModes(event.uri, zoom)
  video.addEventListener('loadedmetadata', () => zoom.setNatural(video.videoWidth, video.videoHeight))
  root.append(bar, frame)
})
