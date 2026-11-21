/**
 * The "Account" section of an extension's detail (TODO 952 stage 1 / the remainder of 817, items 1 and 2). For the credentials a plugin
 * declares in its manifest that main can handle logging in to (currently Google), it shows loading the client JSON, login, re-entry and logout.
 *
 * **It never looks at any value**: main sends only presence/absence (`PluginAccountStatus`). The JSON is chosen in main's native dialog,
 * and login happens in the default browser (Google refuses embedded browsers, 721). A plugin with no declaration renders nothing.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PluginAccountError, PluginAccountResult, PluginAccountStatus } from '@shared/plugin-account.js'
import { useT, type MessageKey } from '../i18n/index.js'

/** An empty array is a module constant (the React #185 case). */
const NO_ACCOUNTS: readonly PluginAccountStatus[] = []

function statusKey(account: PluginAccountStatus): MessageKey {
  if (account.signingIn) return 'extensions.account.status.signingIn'
  if (!account.clientConfigured) return 'extensions.account.status.noClient'
  if (account.needsReauth) return 'extensions.account.status.reauth'
  return account.signedIn ? 'extensions.account.status.signedIn' : 'extensions.account.status.signedOut'
}

/** `google:gmail.modify` -> `gmail.modify` (the scope name shown next to the heading). */
function scopeLabel(credential: string): string {
  const colon = credential.indexOf(':')
  return colon < 0 ? credential : credential.slice(colon + 1)
}

/** TODO 1218: a row for a fixed token (email address + token). The entered value is only handed to main, and the field is emptied after saving (it never comes back). */
function TokenRow({
  pluginId,
  account,
  apply
}: {
  readonly pluginId: string
  readonly account: PluginAccountStatus
  readonly apply: (pending: Promise<PluginAccountResult>) => void
}): React.JSX.Element {
  const t = useT()
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const save = (): void => {
    apply(window.aios.pluginAccounts.saveToken(pluginId, account.credential, email, token))
    setToken('')
  }
  return (
    <div className="extension-account-row" data-credential={account.credential}>
      <dt>{t('extensions.account.token', { name: scopeLabel(account.credential) })}</dt>
      <dd>
        <span className={`extension-account-status${account.signedIn ? ' signed-in' : ''}`}>
          {account.signedIn ? t('extensions.account.status.tokenSaved') : t('extensions.account.status.tokenMissing')}
        </span>
        <span className="extension-detail-actions">
          <input
            type="email"
            className="extension-account-input"
            value={email}
            placeholder={t('extensions.account.token.email')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            type="password"
            className="extension-account-input"
            value={token}
            placeholder={t('extensions.account.token.token')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="button" className="extension-action" disabled={email.trim() === '' || token.trim() === ''} onClick={save}>
            {account.signedIn ? t('extensions.account.token.replace') : t('extensions.account.token.save')}
          </button>
          {account.signedIn ? (
            <button
              type="button"
              className="extension-action"
              onClick={() => apply(window.aios.pluginAccounts.signOut(pluginId, account.credential))}
            >
              {t('extensions.account.token.remove')}
            </button>
          ) : null}
        </span>
      </dd>
    </div>
  )
}

export function PluginAccountSection({ pluginId }: { readonly pluginId: string }): React.JSX.Element | null {
  const t = useT()
  const [accounts, setAccounts] = useState<readonly PluginAccountStatus[]>(NO_ACCOUNTS)
  const [error, setError] = useState<PluginAccountError | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.aios.pluginAccounts.status(pluginId).then(
        (next) => {
          if (!cancelled) setAccounts(next)
        },
        () => undefined
      )
    }
    load()
    // Main redistributes the list at the start and end of a login and on logout.
    const unsubscribe = window.aios.plugins.onChanged(load)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [pluginId])

  const apply = useCallback((pending: Promise<PluginAccountResult>): void => {
    setError(null)
    void pending.then(
      (result) => {
        setAccounts(result.accounts)
        // What the user cancelled themselves is not shown as a failure.
        setError(result.ok || result.error === 'cancelled' ? null : result.error)
      },
      () => setError('error')
    )
  }, [])

  if (accounts.length === 0) return null
  return (
    <section className="extension-account" aria-label={t('extensions.account.title')}>
      <h3>{t('extensions.account.title')}</h3>
      <dl className="extension-fields">
        {accounts.map((account) =>
          account.provider === 'token' ? (
            <TokenRow key={account.credential} pluginId={pluginId} account={account} apply={apply} />
          ) : (
          <div key={account.credential} className="extension-account-row" data-credential={account.credential}>
            <dt>{t('extensions.account.google', { scope: scopeLabel(account.credential) })}</dt>
            <dd>
              <span className={`extension-account-status${account.signedIn ? ' signed-in' : ''}`}>
                {t(statusKey(account))}
              </span>
              <span className="extension-detail-actions">
                <button
                  type="button"
                  className="extension-action"
                  disabled={account.signingIn}
                  onClick={() => apply(window.aios.pluginAccounts.importClient(pluginId))}
                >
                  {account.clientConfigured
                    ? t('extensions.account.reimportClient')
                    : t('extensions.account.importClient')}
                </button>
                {account.signingIn ? (
                  <button
                    type="button"
                    className="extension-action"
                    onClick={() => apply(window.aios.pluginAccounts.cancelSignIn(pluginId, account.credential))}
                  >
                    {t('extensions.account.cancel')}
                  </button>
                ) : account.clientConfigured && (!account.signedIn || account.needsReauth) ? (
                  <button
                    type="button"
                    className="extension-action"
                    onClick={() => apply(window.aios.pluginAccounts.signIn(pluginId, account.credential))}
                  >
                    {account.needsReauth ? t('extensions.account.reSignIn') : t('extensions.account.signIn')}
                  </button>
                ) : null}
                {!account.signingIn && (account.signedIn || account.needsReauth) ? (
                  <button
                    type="button"
                    className="extension-action"
                    onClick={() => apply(window.aios.pluginAccounts.signOut(pluginId, account.credential))}
                  >
                    {t('extensions.account.signOut')}
                  </button>
                ) : null}
              </span>
            </dd>
          </div>
          )
        )}
      </dl>
      {error === null ? null : (
        <p className="extension-account-error" role="alert">
          {t(`extensions.account.error.${error}`)}
        </p>
      )}
      <p className="hint">{t('extensions.account.hint')}</p>
    </section>
  )
}
