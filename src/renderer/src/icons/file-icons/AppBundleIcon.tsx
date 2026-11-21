/**
 * Icon at the head of a `.app` row in the Files tree (TODO 562). Receives the macOS app icon from main as a data URL
 * and shows it with `<img>` (the CSP `img-src` allows `data:`). Until it arrives, or if it cannot be fetched, the Seti folder
 * icon (`FileIcon`) stays.
 *
 * Rows are a virtual list, so only rows that are drawn (= visible) are fetched. The same URI is fetched only once per window
 * (`requests`; refetched if mtime changes). main also caches by path + mtime.
 */
import { useEffect, useState } from 'react'
import { FileIcon } from './FileIcon.js'

/** `<URI>|<mtime>` -> fetch result. Reused within the window. */
const requests = new Map<string, Promise<string | null>>()
/** Maximum number of entries to remember (oldest dropped first). */
const MAX_REQUESTS = 512

function requestIcon(uri: string, mtimeMs: number): Promise<string | null> {
  const key = `${uri}|${mtimeMs}`
  const existing = requests.get(key)
  if (existing !== undefined) return existing
  // Do not break rendering even with a fake that throws synchronously (the tests' `window.aios`).
  const request = Promise.resolve()
    .then(() => window.aios.fs.appIcon(uri))
    .catch(() => null)
  requests.set(key, request)
  while (requests.size > MAX_REQUESTS) {
    const oldest = requests.keys().next().value
    if (oldest === undefined) break
    requests.delete(oldest)
  }
  return request
}

export interface AppBundleIconProps {
  readonly uri: string
  readonly name: string
  readonly mtimeMs: number
}

export function AppBundleIcon({ uri, name, mtimeMs }: AppBundleIconProps): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSrc(null)
    void requestIcon(uri, mtimeMs).then((value) => {
      if (alive) setSrc(value)
    })
    return () => {
      alive = false
    }
  }, [uri, mtimeMs])
  if (src === null) return <FileIcon name={name} isDirectory />
  return <img className="file-icon file-icon-app" src={src} width={16} height={16} alt="" aria-hidden="true" />
}
