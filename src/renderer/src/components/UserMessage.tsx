import { useEffect, useState } from 'react'
import type { SentAttachment } from '@shared/agent.js'
import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { fitAttachmentPreview } from './Composer.js'
import { openSentImage } from '../open-attachment-image.js'

/**
 * The frame of the user's own message (TODO 352, wave 19 bundle A, ARCHITECTURE.md 5.1).
 *
 * **It does not go through Markdown; it is drawn as plain text exactly as typed** (`white-space: pre-wrap`). This matches how the CLI and the
 * VS Code extension look (owner decision (b)). In Markdown a lone newline becomes a soft break (a space), and the newlines entered in the
 * Composer collapsed into one paragraph. `*` and `#` are also shown as they are (not emphasis or headings), and
 * URLs are not made links. They are string children in React, so HTML is not interpreted (React does the escaping).
 *
 * The attachment mark (the parenthesized "attachment: name" mark, or `@path`) and the selection heading (item 97) are lines main's `composeText` adds before the body; here they are
 * shown one line at a time like any other line. However, the parenthesized attachment mark arrives after `foldTimeline` has replaced it with a sentence in the
 * display language (TODO 519, `shared/attachment-mark.ts`).
 *
 * A sub-agent's message (`message subagent`) is model output, so it stays Markdown (`Message` of ThreadPane).
 *
 * TODO 550: sent images are lined up as thumbnails (`SentImage`) above the body. Hovering shows a large balloon (the same `attachment-preview-tip` as
 * the Composer's chip in 461).
 * TODO 814: an image that points to a file (one with `uri`) opens in the viewer on click (`aios.image`, `select`).
 * TODO 971: an image with only a reduced version (a clipboard paste, a captured screen) also opens on click - no file is created; the reduced
 * version is put in a temporary display (`open-attachment-image.ts`). This overturned 461's "clicking opens nothing".
 */
export function UserMessage({
  text,
  attachments
}: {
  text: string
  /** Sent images (TODO 550). Lined up as thumbnails above the body. */
  attachments?: readonly SentAttachment[]
}): React.JSX.Element {
  return (
    <div className="message user">
      {attachments !== undefined && attachments.length > 0 ? (
        <div className="user-attachments">
          {attachments.map((attachment, index) => (
            <SentImage key={`${index}:${attachment.name}`} attachment={attachment} />
          ))}
        </div>
      ) : null}
      <div className="user-text">{text}</div>
    </div>
  )
}

/**
 * The `aios-res://` URL of an image that points to a file (TODO 550). Main is asked on each display, but only once per
 * URI within the same window (main reuses the token. If the file disappears, only the `<img>` load fails).
 */
const imageUrls = new Map<string, Promise<string | null>>()

function imageUrlOf(uri: string): Promise<string | null> {
  let pending = imageUrls.get(uri)
  if (pending === undefined) {
    pending = window.aios.threads.attachmentImage(uri).catch(() => null)
    imageUrls.set(uri, pending)
    // Do not remember the ones that could not be fetched (a temporary failure, refused) - ask again at the next display (code-review 2026-10-10).
    void pending.then((resolved) => {
      if (resolved === null) imageUrls.delete(uri)
    })
  }
  return pending
}

/** One sent image. The reduced version if there is one, `aios-res://` for a file, and only the name if neither. */
function SentImage({ attachment }: { attachment: SentAttachment }): React.JSX.Element {
  const t = useT()
  const [url, setUrl] = useState<string | null>(attachment.thumbnail ?? null)
  const [failed, setFailed] = useState(false)
  // To decide the size of the balloon preview without waiting for decode, keep the original size at the time it was readable (same as 461).
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (attachment.thumbnail !== undefined || attachment.uri === undefined) return
    let alive = true
    void imageUrlOf(attachment.uri).then((resolved) => {
      if (alive) setUrl(resolved)
    })
    return () => {
      alive = false
    }
  }, [attachment.thumbnail, attachment.uri])
  // TODO 971: a file opens by URI, and a pasted / captured image opens its reduced version in a temporary display (if neither exists, it does not open).
  const open =
    attachment.uri === undefined && attachment.thumbnail === undefined
      ? undefined
      : (): void => {
          openSentImage(attachment)
        }
  if (attachment.name === '' && attachment.uri === undefined && attachment.thumbnail === undefined) {
    // TODO 878: the past part of a conversation continued from a transcript. A badge saying only that there was an image (no destination to open, no name).
    return <span className="chip user-attachment-name">🖼</span>
  }
  if (url === null || failed) {
    return open === undefined ? (
      <span className="chip user-attachment-name">🖼 {attachment.name}</span>
    ) : (
      <button type="button" className="chip user-attachment-name clickable" onClick={open}>
        🖼 {attachment.name}
      </button>
    )
  }
  return (
    <Tooltip
      placement="top"
      className="attachment-preview-tip"
      content={() => (
        <>
          <img
            className="attachment-preview"
            src={url}
            alt=""
            {...fitAttachmentPreview(natural ?? { width: 0, height: 0 })}
          />
          <div className="attachment-preview-name">{attachment.name}</div>
        </>
      )}
    >
      <img
        className={open === undefined ? 'user-attachment-thumb' : 'user-attachment-thumb clickable'}
        onClick={open}
        src={url}
        alt={t('composer.attachmentThumb', { name: attachment.name })}
        decoding="async"
        draggable={false}
        onError={() => {
          // The token was evicted in main (limit of 512) / the file disappeared: drop the remembered URL and ask again at the next display.
          if (attachment.uri !== undefined) imageUrls.delete(attachment.uri)
          setFailed(true)
        }}
        onLoad={(event) =>
          setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
        }
      />
    </Tooltip>
  )
}
