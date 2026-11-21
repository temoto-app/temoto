/**
 * A row for a shell run with `!` in the prompt field (item 116, ARCHITECTURE.md 4.5.7).
 *
 * Made to look like the tool-call frame (`.tool-block`), with the command and the result (exit code,
 * timeout, no working folder, failed to start) in the heading. The output is opened to view; if short, it starts open.
 * The failure text comes from the dictionary (7.4.4). What comes from main is only the status code (`ShellRunStatus`) and numbers.
 */
import { useState } from 'react'
import type { ShellRunPayload } from '@shared/agent.js'
import { useT } from '../i18n/index.js'

/** At or below this many lines, it starts open. */
const OPEN_BY_DEFAULT_LINES = 12

export function ShellRunBlock({ run }: { run: ShellRunPayload }): React.JSX.Element {
  const t = useT()
  const lines = run.stdout.split('\n').length + (run.stderr === '' ? 0 : run.stderr.split('\n').length)
  const [open, setOpen] = useState(lines <= OPEN_BY_DEFAULT_LINES)
  const bad = run.status !== 'ok'
  const status =
    run.status === 'ok'
      ? t('shell.status.ok')
      : run.status === 'exit'
        ? run.exitCode === null
          ? t('shell.status.killed')
          : t('shell.status.exit', { code: run.exitCode })
        : run.status === 'timeout'
          ? t('shell.status.timeout')
          : run.status === 'no-cwd'
            ? t('shell.status.noCwd')
            : t('shell.status.failed', { code: run.errorCode ?? '?' })
  const empty = run.stdout === '' && run.stderr === ''
  return (
    <div className="tool-block shell-block">
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{t('shell.label')}</span>
        <span className="tool-summary shell-command">! {run.command}</span>
        <span className={`tool-status${bad ? ' bad' : ''}`}>
          {status} · {t('shell.seconds', { n: Math.round(run.durationMs / 100) / 10 })}
        </span>
      </button>
      {open ? (
        <div className="tool-detail">
          {empty ? <div className="tool-note">{t('shell.noOutput')}</div> : null}
          {run.stdout !== '' ? <pre className="tool-result">{run.stdout}</pre> : null}
          {run.stderr !== '' ? <pre className="tool-result shell-stderr">{run.stderr}</pre> : null}
          {run.truncated ? <div className="tool-note">{t('shell.truncated')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
