/**
 * The guidance for unattended / scheduled runs after a login expiry (TODO 1282, owner decision 2026-11-21: guidance only).
 *
 * The command and the variable name come from main (the Adapter's table, constraint 6). **{app} never runs the command, never
 * asks for, accepts, stores or shows the token** - there is no input field here on purpose. Used by the settings screen
 * (Account) and by the expired-login bar of an unattended conversation.
 */
import { useEffect, useState } from 'react'
import type { UnattendedLoginGuide } from '@shared/login-recovery.js'
import { useT } from '../i18n/index.js'

let cached: Promise<UnattendedLoginGuide | null> | null = null

function loadGuide(): Promise<UnattendedLoginGuide | null> {
  const api = typeof window === 'undefined' ? undefined : window.aios?.agent
  if (api?.unattendedLoginGuide === undefined) return Promise.resolve(null)
  cached ??= api.unattendedLoginGuide().catch(() => null)
  return cached
}

/** For tests. */
export function resetUnattendedGuideForTest(): void {
  cached = null
}

export function UnattendedAuthGuide({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const t = useT()
  const [guide, setGuide] = useState<UnattendedLoginGuide | null>(null)
  useEffect(() => {
    let alive = true
    void loadGuide().then((value) => {
      if (alive) setGuide(value)
    })
    return () => {
      alive = false
    }
  }, [])
  if (guide === null) return null
  return (
    <div className={`unattended-auth-guide${compact ? ' compact' : ''}`}>
      {compact ? <p>{t('auth.unattended.lead')}</p> : null}
      <ol>
        <li>
          {t('auth.unattended.step1')} <code>{guide.setupCommand}</code>
        </li>
        <li>
          {t('auth.unattended.step2')} <code>{guide.tokenEnv}</code>
        </li>
        <li>{t('auth.unattended.step3')}</li>
      </ol>
      <p className="hint">{t('auth.unattended.safety')}</p>
    </div>
  )
}
