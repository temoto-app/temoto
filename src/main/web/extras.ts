/**
 * The wiring to the real electron and the IPC for the additions to the Web view (TODO 400 / 522) (wave 27 bundle B).
 * Kept apart from `register.ts` (since in the same wave bundles A / E touch `register.ts` / `host.ts`).
 *
 * - TODO 553: remember Slack workspace "name -> ID" from Web view navigations (`SlackTeams`), and rewrite links in answers
 *   before showing them in the ViewerPane (`web.resolveLink`). Only webContents of the page session (`persist:aios-web`) are watched
 *   (chosen by looking at the session in `web-contents-created`).
 * - TODO 547: certificate exceptions for internal https (self-signed, internal CA). Receives `app`'s `certificate-error` and decides **only for webContents of the page
 *   session** (it does not interfere with other webContents; electron's default = refuse stays).
 *   It does not apply to main's default session or the plugin network (CapabilityBroker).
 *   - 598-2 (the 32nd proxy verification): at first exceptions were accepted with `setCertificateVerifyProc`, but the proc's result is cached by the network service
 *     (a note in electron.d.ts), and on Electron 44 re-applying the proc did not drop the cache — right after trusting, even after
 *     a reload, a re-load, and `closeAllConnections`, the proc was not called and it stayed -202. Conversely the accepted result also stays, so
 *     revocation did not work either. `certificate-error` comes on every load (measured), so deciding on the spot makes adding / removing take effect immediately.
 *     The favicon fetched in the same session (`ses.fetch`) is outside the exception (favicons of internal servers do not show). Revocation also closes connections left open.
 * - TODO 697: the entry point that clears the Web view's login data (cookies and site storage). When clearing only one site, that row's
 *   cookies are removed one at a time with `cookies.remove`, and storage is cleared with `clearStorageData` for each origin seen (including the port)
 *   (`origins` of `clearData` clears only the storage of the origins passed — a fix from code-review, `login-sites.ts`).
 *   Origins seen = open tabs, places navigated to in this launch (`seenOrigins`, memory only), and history. "Clear all" is
 *   `clearData` (no origins). After clearing, the webContents showing that domain (only those of the page session) are
 *   reloaded. The certificate exceptions of 547, the Slack memory of 553, history, Favorites, and the tab memory are not touched (a different app_settings key / DB table).
 */
import { app, ipcMain, session, webContents as allWebContents, type WebContents } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { WEB_SLACK_TEAMS, WEB_TAB_READ_CONSENT, WEB_TRUSTED_CERTIFICATES } from '../../common/settings-keys.js'
import { log } from '../../common/logger.js'
import { registrableDomainOf } from '../../shared/web-login-sites.js'
import { WEB_PARTITION } from './register.js'
import { SlackTeams } from './slack.js'
import { CERT_ACCEPT, WebCertificateTrust, certErrorCodeOf } from './certificates.js'
import { LOGIN_DATA_TYPES, LOGIN_STORAGE_TYPES, WebLoginSites } from './login-sites.js'

/** The entry point called before closing the DB at `before-quit` (12.9). */
export interface WebExtrasHandle {
  shutdown(): void
}

export interface WebExtrasOptions {
  /** The history URLs (material for the "seen origins" of TODO 697). Empty if there is no history table. */
  readonly historyUrls?: () => readonly string[]
}

/** Upper bound on origins seen in this launch (memory only. The oldest are dropped first). */
const MAX_SEEN_ORIGINS = 500

export function registerWebExtras(settings: AppSettingsStore | null, options: WebExtrasOptions = {}): WebExtrasHandle {
  let stopped = false
  const webSession = session.fromPartition(WEB_PARTITION)

  const slack = new SlackTeams({
    read: () => settings?.readTyped(WEB_SLACK_TEAMS) ?? {},
    write: (teams) => {
      // After quit (after the DB is closed) nothing is written (12.9). What was remembered stays only in memory.
      if (stopped || settings === null) return
      settings.writeTyped(WEB_SLACK_TEAMS, teams)
    }
  })

  // TODO 697: the origins seen in this launch (including the port). The targets for clearing storage when clearing only one site.
  const seenOrigins = new Set<string>()
  const noteOrigin = (url: unknown): void => {
    if (typeof url !== 'string') return
    try {
      const { origin, protocol } = new URL(url)
      if (protocol !== 'https:' && protocol !== 'http:') return
      seenOrigins.delete(origin)
      seenOrigins.add(origin)
      if (seenOrigins.size > MAX_SEEN_ORIGINS) {
        const oldest = seenOrigins.values().next().value
        if (oldest !== undefined) seenOrigins.delete(oldest)
      }
    } catch {
      // A broken URL is not remembered.
    }
  }

  const watch = (contents: WebContents): void => {
    if (contents.session !== webSession) return
    const id = contents.id
    const seen = (url: unknown): void => {
      if (typeof url === 'string') slack.observe(id, url)
    }
    contents.on('did-navigate', (_event, url) => {
      seen(url)
      noteOrigin(url)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) seen(url)
    })
    // The origin of an embedded frame (such as a login iframe) also has storage (TODO 697).
    contents.on('did-frame-navigate', (_event, url) => noteOrigin(url))
    contents.once('destroyed', () => slack.forget(id))
  }
  app.on('web-contents-created', (_event, contents) => {
    try {
      watch(contents)
    } catch (err) {
      log.warn('web.extras.watchFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.handle(IpcChannel.webResolveLink, (_event, url: unknown) => slack.rewrite(url))

  // ---- TODO 547: certificate exceptions (only for the page session, moved to certificate-error in 598-2) ----
  const certificates = new WebCertificateTrust({
    read: () => settings?.readTyped(WEB_TRUSTED_CERTIFICATES) ?? [],
    write: (list) => {
      if (stopped || settings === null) return
      settings.writeTyped(WEB_TRUSTED_CERTIFICATES, list)
    }
  })
  app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
    // If it is not the Web view's session, do not interfere (electron's default = refuse. There is no other listener either).
    if (contents.session !== webSession) return
    event.preventDefault()
    let accept = false
    try {
      const errorCode = certErrorCodeOf(error)
      accept =
        errorCode !== null &&
        certificates.verify({ hostname: new URL(url).hostname, errorCode, certificatePem: certificate.data }) === CERT_ACCEPT
    } catch (err) {
      log.warn('web.cert.verifyFailed', { message: err instanceof Error ? err.message : String(err) })
    }
    callback(accept)
  })
  ipcMain.handle(IpcChannel.webCertificateStatus, (_event, url: unknown) => certificates.status(url))
  ipcMain.handle(IpcChannel.webTrustCertificate, (_event, url: unknown) => certificates.trust(url))
  ipcMain.handle(IpcChannel.webTrustedCertificates, () => certificates.trusted())
  ipcMain.handle(IpcChannel.webRevokeCertificate, async (_event, host: unknown) => {
    const before = certificates.trusted().length
    const after = certificates.revoke(host)
    // Close the connections left open with the revoked certificate (the next load starts over from verification).
    if (after.length !== before) await webSession.closeAllConnections().catch(() => undefined)
    return after
  })

  // ---- TODO 1055 (2): checking and revoking consent for the AI to read a Web tab's body (the one obtained once, the first time, through the approval inbox) ----
  // Revocation can only write (false). The only entry point that grants consent is in the gateway's read stage (`grant` in `index.ts`).
  ipcMain.handle(IpcChannel.webTabReadConsentGet, () => {
    try {
      return settings?.readTyped(WEB_TAB_READ_CONSENT) === true
    } catch {
      return false
    }
  })
  ipcMain.handle(IpcChannel.webTabReadConsentRevoke, () => {
    if (!stopped && settings !== null) settings.writeTyped(WEB_TAB_READ_CONSENT, false)
    return false
  })

  // ---- TODO 697: clear login data (cookies and site storage) ----
  const reloadLoginSite = (domain: string | null): void => {
    for (const contents of allWebContents.getAllWebContents()) {
      if (contents.session !== webSession || contents.isDestroyed()) continue
      if (domain === null) {
        contents.reload()
        continue
      }
      try {
        if (registrableDomainOf(new URL(contents.getURL()).hostname) === domain) contents.reload()
      } catch {
        // There is no URL (a blank tab), etc. — do not reload.
      }
    }
  }
  const openUrls = (): string[] => {
    const urls: string[] = []
    for (const contents of allWebContents.getAllWebContents()) {
      if (contents.session !== webSession || contents.isDestroyed()) continue
      urls.push(contents.getURL())
    }
    return urls
  }
  const loginSites = new WebLoginSites({
    listCookies: async () =>
      (await webSession.cookies.get({})).map((cookie) => ({
        domain: cookie.domain ?? '',
        name: cookie.name,
        path: cookie.path ?? '/',
        secure: cookie.secure === true
      })),
    removeCookie: (url, name) => webSession.cookies.remove(url, name),
    clearOriginStorage: (origin) => webSession.clearStorageData({ origin, storages: [...LOGIN_STORAGE_TYPES] }),
    knownUrls: () => {
      let history: readonly string[] = []
      try {
        history = options.historyUrls?.() ?? []
      } catch (err) {
        log.warn('web.login.historyUnavailable', { message: err instanceof Error ? err.message : String(err) })
      }
      return [...openUrls(), ...seenOrigins, ...history]
    },
    clearAll: () => webSession.clearData({ dataTypes: [...LOGIN_DATA_TYPES] }),
    reload: reloadLoginSite
  })
  ipcMain.handle(IpcChannel.webLoginSitesList, () => loginSites.list())
  ipcMain.handle(IpcChannel.webLoginSitesClear, (_event, domain: unknown) => loginSites.clear(domain))
  ipcMain.handle(IpcChannel.webLoginSitesClearAll, () => loginSites.clearAll())

  return {
    shutdown: () => {
      stopped = true
    }
  }
}
