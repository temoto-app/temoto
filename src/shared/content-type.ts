/**
 * The table of extension -> Content-Type (the only one). Both main's `aios-res://` serving (`capability/resource.ts`) and the type attached to
 * `blob:` for the temporary view (`transient-file.ts`, TODO 905) look it up here. The key is a lowercase extension (no dot).
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  // Video (TODO 405, `aios.video`). `.avi` cannot be played in Chromium (the plugin shows guidance and falls back to opening with the default
  // app), but serving is decided by the extension alone, so the type is still given.
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  // Audio (TODO 1271, also `aios.video`). All five play in Electron's Chromium (verified with canPlayType on Electron 44).
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  // aios.office (TODO 405 (4)). The viewer only fetches and reads it as a zip, but declares the type correctly under nosniff.
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // A workbook with macros (TODO 1212 stage 2). The viewer only reads the table and does not run the macros.
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  // aios.zip (TODO 905). The viewer reads only the tail and the central directory with Range.
  zip: 'application/zip'
}

/** The type for an extension (with or without the dot, case-insensitive). Null if not in the table. */
export function contentTypeForExtension(extension: string): string | null {
  const key = (extension.startsWith('.') ? extension.slice(1) : extension).toLowerCase()
  return Object.hasOwn(CONTENT_TYPES, key) ? (CONTENT_TYPES[key] ?? null) : null
}
