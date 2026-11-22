/**
 * The "About" at the end of the settings screen (TODO 316, wave 17 bundle A, ARCHITECTURE.md 5.8).
 *
 * It shows rows in the same order as VS Code's "Help > About" (Version / Commit / Date + relative / Electron / Chromium /
 * Node.js / V8 / OS), and "Copy" puts everything on the clipboard. No dialog is shown
 * (policy: fewer dialogs). The way copying works is the same as copying code (T17, `CopyButton`):
 * `navigator.clipboard.writeText`, and once it succeeds, "Copied" is shown for 1.5 seconds.
 *
 * "Open the log folder" (TODO 376) selects the log file currently being written in Finder
 * (`~/Library/Logs/aios/`, and `<userData>/logs/` for a `--user-data-dir` copy). It reduces the effort of reporting a bug.
 */
import { useEffect, useRef, useState } from 'react'
import {
  formatBuildCopyText,
  relativeAge,
  UNKNOWN_COMMIT,
  type BuildInfo,
  type RuntimeInfo
} from '@shared/build-info.js'
import type { DbBreakdown } from '@shared/db-breakdown.js'
import { useStore } from '../store.js'
import { formatBytes } from '../thread/timeline.js'
import { useT, type MessageKey, type Translate as T } from '../i18n/index.js'
import { useBuildInfoJump } from '../buildInfoJump.js'
import { thirdPartyNotices } from '../third-party-notices.js'
import { localizedHeading, metaBody } from '@shared/third-party-notices.js'
import { useLocale } from '../localeStore.js'
import { InlineMarkdown } from './InlineMarkdown.js'
import { openHelp, openReleaseNotes } from '../help.js'

/** The id of the heading the BottomBar badge jumps to. */
export const BUILD_INFO_ANCHOR = 'settings-build-info'

function describeAge(t: T, iso: string, nowMs: number): string {
  const age = relativeAge(iso, nowMs)
  if (age === null) return ''
  if (age.unit === 'now') return t('build.ago.now')
  const key: MessageKey =
    age.unit === 'minute' ? 'build.ago.minute' : age.unit === 'hour' ? 'build.ago.hour' : 'build.ago.day'
  return t(key, { count: age.count })
}

function rowsOf(
  t: T,
  build: BuildInfo,
  runtime: RuntimeInfo,
  nowMs: number
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const age = describeAge(t, build.date, nowMs)
  const commit =
    build.commit === UNKNOWN_COMMIT ? t('build.unknown') : build.dirty ? `${build.commit} (${t('build.dirty')})` : build.commit
  return [
    { label: t('build.version'), value: build.version },
    { label: t('build.commit'), value: commit },
    { label: t('build.date'), value: build.date === '' ? t('build.unknown') : age === '' ? build.date : `${build.date} (${age})` },
    { label: 'Electron', value: runtime.electron },
    { label: 'Chromium', value: runtime.chromium },
    { label: 'Node.js', value: runtime.node },
    { label: 'V8', value: runtime.v8 },
    { label: t('build.os'), value: runtime.os }
  ]
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * The DB breakdown (TODO 846 / 914 / 988). **It is not measured just by opening**: only once, when pressed,
 * the index process reads all pages with `dbstat`.
 */
function DbBreakdownBlock(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'failed' } | { kind: 'done'; result: DbBreakdown }
  >({ kind: 'idle' })
  const run = (): void => {
    setState({ kind: 'busy' })
    window.aios.app
      .measureDatabase()
      .then((result) => setState(result === null ? { kind: 'failed' } : { kind: 'done', result }))
      .catch(() => setState({ kind: 'failed' }))
  }
  return (
    <div className="db-breakdown">
      <div className="settings-actions">
        <button type="button" disabled={state.kind === 'busy'} onClick={run}>
          {state.kind === 'busy' ? t('build.db.measuring') : t('build.db.measure')}
        </button>
      </div>
      <p className="db-breakdown-hint">{t('build.db.note')}</p>
      {state.kind === 'failed' ? <p className="db-breakdown-hint">{t('build.db.failed')}</p> : null}
      {state.kind === 'done' ? (
        <>
          <dl className="build-info-rows">
            <div className="build-info-row">
              <dt>{t('build.db.file')}</dt>
              <dd>{formatBytes(state.result.fileBytes)}</dd>
            </div>
            <div className="build-info-row">
              <dt>{t('build.db.wal')}</dt>
              <dd>{formatBytes(state.result.walBytes)}</dd>
            </div>
            <div className="build-info-row">
              <dt>{t('build.db.free')}</dt>
              <dd>
                {formatBytes(state.result.reclaimableBytes)} ({t('build.db.freePages', { pages: state.result.freelistPages })})
              </dd>
            </div>
          </dl>
          {state.result.dbstatAvailable ? null : <p className="db-breakdown-hint">{t('build.db.noDbstat')}</p>}
          <table className="db-breakdown-table">
            <tbody>
              {state.result.entries.map((entry) => (
                <tr key={entry.name}>
                  <td className="db-breakdown-name">{entry.name}</td>
                  <td className="db-breakdown-num">{entry.bytes === null ? '-' : formatBytes(entry.bytes)}</td>
                  <td className="db-breakdown-num">{entry.rows === null ? '' : entry.rows.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.result.totalEntries > state.result.entries.length ? (
            <p className="db-breakdown-hint">
              {t('build.db.more', { count: state.result.totalEntries - state.result.entries.length })}
            </p>
          ) : null}
          <p className="db-breakdown-hint">{t('build.db.took', { seconds: (state.result.tookMs / 1000).toFixed(1) })}</p>
        </>
      ) : null}
    </div>
  )
}

export function BuildInfoSection(): React.JSX.Element | null {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const appInfo = useStore((state) => state.appInfo)
  const seq = useBuildInfoJump((state) => state.seq)
  const consume = useBuildInfoJump((state) => state.consume)
  const host = useRef<HTMLElement | null>(null)
  const [copied, setCopied] = useState(false)
  // So that "n minutes ago" does not go stale. Redraw every minute.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  // When coming from the BottomBar badge, show this section (whether mounted right after settings opened, or while already open).
  useEffect(() => {
    if (!useBuildInfoJump.getState().pending || host.current === null) return
    host.current.scrollIntoView({ block: 'start' })
    consume()
  }, [seq, consume, appInfo])

  if (appInfo === null) return null
  const { build, runtime } = appInfo
  return (
    <section ref={host} className="settings-category build-info" aria-labelledby={BUILD_INFO_ANCHOR}>
      <h2 id={BUILD_INFO_ANCHOR}>{t('build.title')}</h2>
      <dl className="build-info-rows">
        {rowsOf(t, build, runtime, nowMs).map((row) => (
          <div key={row.label} className="build-info-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="settings-actions">
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(formatBuildCopyText(build, runtime)).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
        >
          {copied ? t('common.copied') : t('build.copy')}
        </button>
        {/* TODO 376: open the log folder in Finder (with the current file selected). Only main knows the path. */}
        <button type="button" onClick={() => void window.aios.editor.revealLogs()}>
          {t('build.openLogs')}
        </button>
        {/* TODO 1308: write the masked problem report and show it in Finder (nothing is sent; the user checks it and sends it). */}
        <button type="button" onClick={() => void window.aios.editor.reportProblem()}>
          {t('build.reportProblem')}
        </button>
        {/* TODO 1174: show Help in ViewerPane as a temporary view (same as the "Help" menu and the ? in the Activity Bar). */}
        <button type="button" onClick={openHelp}>
          {t('help.open')}
        </button>
        {/* TODO 1186: show the bundled changelog (English only) in ViewerPane as a temporary view (same as the "Help > Release Notes" menu). */}
        <button type="button" onClick={openReleaseNotes}>
          {t('help.releaseNotes')}
        </button>
      </div>
      <DbBreakdownBlock />
      {/* TODO 438: show the licenses of all bundled third-party material (MIT and others require the copyright notice and license text to be included in copies).
          The canonical copy is the single place THIRD_PARTY_NOTICES.md; we do not hold a duplicate here, just split the same Markdown embedded at build time
          by heading (`thirdPartyNotices()`). The full text is kept collapsed. */}
      <h3 className="build-info-notices-title">{t('build.notices')}</h3>
      {/* TODO 453: the heading is "name · license name". The earlier "(... License)" shell (in Japanese too) overlapped when the license name
          already contained the word, as in "Apache License 2.0", so it was removed. The Markdown marks in headings and description rows are
          drawn by `InlineMarkdown` (raw `` ` `` / `**` are not shown). */}
      {thirdPartyNotices().map((notice) => (
        <details key={notice.heading} className="build-info-notice">
          <summary>
            <InlineMarkdown text={localizedHeading(notice, locale)} />
            {notice.license === '' ? null : (
              <span className="build-info-notice-license">
                {' · '}
                <InlineMarkdown text={notice.license} />
              </span>
            )}
          </summary>
          {notice.meta.map((line) => (
            <div key={line} className="build-info-notice-meta">
              <InlineMarkdown text={metaBody(line)} />
            </div>
          ))}
          <pre className="build-info-notice-text">{notice.text}</pre>
        </details>
      ))}
    </section>
  )
}
