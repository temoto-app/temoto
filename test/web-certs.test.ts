// @vitest-environment jsdom
/**
 * TODO 547 (wave 27 bundle B): exceptions for the certificates of internal https (self-signed and internal CA), per host.
 *
 * - `WebCertificateTrust` (main, no electron): a certificate that Chromium refused is remembered as a candidate to ask about. The renderer's 'trust this host's certificate'
 *   saves its fingerprint, and from then on that fingerprint is accepted. If the fingerprint changes, it asks again. Revocation and the like are not made exceptions.
 *   The renderer passes only the URL (main sees the fingerprint itself).
 * - the key `web.trustedCertificates` in `app_settings` (owner main) and the check of the saved value
 * - only the session for Web display takes effect: the single `certificate-error` place in `web/extras.ts` decides only for the webContents of the page's session.
 *   `setCertificateVerifyProc` is not used (598-2: it caches the proc's results; a check of the source)
 * - renderer (jsdom): the error band has 'trust this host's certificate' and 'open in browser'; pressing the first trusts the host and re-reads
 *
 * The real certificate and the real session are not used (the check on a real machine is done by the owner on a Mac on the internal network). The model is not called either.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  CERT_ACCEPT,
  CERT_USE_CHROMIUM,
  WebCertificateTrust,
  certErrorCodeOf,
  fingerprintOfPem
} from '../src/main/web/certificates.js'
import {
  MAX_TRUSTED_CERTIFICATES,
  isCertificateError,
  sanitizeTrustedCertificates,
  shortFingerprint,
  type TrustedCertificate
} from '../src/shared/web-certs.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { WEB_TRUSTED_CERTIFICATES } from '../src/common/settings-keys.js'
import { EMPTY_WEB_TABS } from '../src/shared/web-tabs.js'
import type { WebViewEvent } from '../src/shared/web-view.js'

const pem = (bytes: number[]): string =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(bytes).toString('base64')}\n-----END CERTIFICATE-----\n`
const PEM_A = pem([1, 2, 3, 4])
const PEM_B = pem([5, 6, 7, 8])
const sha = (bytes: number[]): string => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

describe('WebCertificateTrust (TODO 547)', () => {
  let saved: (readonly TrustedCertificate[])[]
  let changed: number
  const make = (initial: readonly TrustedCertificate[] = []): WebCertificateTrust =>
    new WebCertificateTrust({
      read: () => initial,
      write: (list) => saved.push(list),
      now: () => 1_700_000_000_000,
      changed: () => changed++
    })

  beforeEach(() => {
    saved = []
    changed = 0
  })

  it('指紋は PEM の DER の SHA-256 (小文字 16 進)。読めなければ null', () => {
    expect(fingerprintOfPem(PEM_A)).toBe(sha([1, 2, 3, 4]))
    expect(fingerprintOfPem('nope')).toBeNull()
    expect(fingerprintOfPem(42)).toBeNull()
  })

  it('Chromium が通した証明書には口を出さない (-3)', () => {
    expect(make().verify({ hostname: 'example.com', errorCode: 0, certificatePem: PEM_A })).toBe(CERT_USE_CHROMIUM)
  })

  it('-202 を断って候補に覚え、信用するとその指紋なら受け入れる', () => {
    const trust = make()
    const check = { hostname: 'vm-soft04', errorCode: -202, certificatePem: PEM_A }
    expect(trust.status('https://vm-soft04/redmine/')).toEqual({ trustable: false, changed: false })
    expect(trust.verify(check)).toBe(CERT_USE_CHROMIUM)
    expect(trust.status('https://vm-soft04/redmine/issues/1')).toEqual({ trustable: true, changed: false })
    expect(trust.trust('https://vm-soft04/redmine/issues/1')).toBe(true)
    expect(saved.at(-1)).toEqual([{ host: 'vm-soft04', fingerprint: sha([1, 2, 3, 4]), addedAt: 1_700_000_000_000 }])
    expect(changed).toBe(1)
    expect(trust.verify(check)).toBe(CERT_ACCEPT)
    // The candidates are used up (pressing again adds nothing)
    expect(trust.trust('https://vm-soft04/')).toBe(false)
  })

  it('指紋が変わったら受け入れず、また聞く (changed)', () => {
    const trust = make([{ host: 'vm-soft04', fingerprint: sha([1, 2, 3, 4]), addedAt: 1 }])
    expect(trust.verify({ hostname: 'VM-SOFT04', errorCode: -202, certificatePem: PEM_A })).toBe(CERT_ACCEPT)
    expect(trust.verify({ hostname: 'vm-soft04', errorCode: -202, certificatePem: PEM_B })).toBe(CERT_USE_CHROMIUM)
    expect(trust.status('https://vm-soft04/')).toEqual({ trustable: true, changed: true })
    expect(trust.trust('https://vm-soft04/')).toBe(true)
    expect(saved.at(-1)?.map((entry) => entry.fingerprint)).toEqual([sha([5, 6, 7, 8])])
  })

  it('失効 (-206) などは例外にしない。http や別ホストの URL では信用できない', () => {
    const trust = make()
    expect(trust.verify({ hostname: 'revoked.example', errorCode: -206, certificatePem: PEM_A })).toBe(CERT_USE_CHROMIUM)
    expect(trust.status('https://revoked.example/')).toEqual({ trustable: false, changed: false })
    trust.verify({ hostname: 'vm-soft04', errorCode: -202, certificatePem: PEM_A })
    expect(trust.trust('http://vm-soft04/')).toBe(false)
    expect(trust.trust('https://other/')).toBe(false)
    expect(trust.trust('javascript:alert(1)')).toBe(false)
    expect(saved).toEqual([])
  })

  it('取り消し: 一覧から消え、以後は受け入れない', () => {
    const trust = make([{ host: 'vm-soft04', fingerprint: sha([1, 2, 3, 4]), addedAt: 1 }])
    expect(trust.revoke('nobody')).toHaveLength(1)
    expect(changed).toBe(0)
    expect(trust.revoke('vm-soft04')).toEqual([])
    expect(changed).toBe(1)
    expect(trust.verify({ hostname: 'vm-soft04', errorCode: -202, certificatePem: PEM_A })).toBe(CERT_USE_CHROMIUM)
  })

  it('保存値の検め・鍵の往復・札', () => {
    expect(isCertificateError(-202)).toBe(true)
    expect(isCertificateError(-102)).toBe(false)
    expect(sanitizeTrustedCertificates('x')).toEqual([])
    const good = { host: 'A.example', fingerprint: 'AB'.repeat(32), addedAt: 5 }
    expect(sanitizeTrustedCertificates([good, { host: 'bad host', fingerprint: 'ab'.repeat(32), addedAt: 1 }])).toEqual([
      { host: 'a.example', fingerprint: 'ab'.repeat(32), addedAt: 5 }
    ])
    const many = Array.from({ length: MAX_TRUSTED_CERTIFICATES + 3 }, (_, i) => ({
      host: `h${i}`,
      fingerprint: 'cd'.repeat(32),
      addedAt: i
    }))
    const kept = sanitizeTrustedCertificates(many)
    expect(kept).toHaveLength(MAX_TRUSTED_CERTIFICATES)
    expect(kept[0]?.host).toBe('h3')
    expect(shortFingerprint('ab'.repeat(32))).toBe('AB:AB:AB:AB:AB:AB:AB:AB…')

    const db = new Database(':memory:')
    runMigrations(db)
    const settings = new AppSettingsStore(db)
    expect(WEB_TRUSTED_CERTIFICATES.owner).toBe('main')
    expect(settings.readTyped(WEB_TRUSTED_CERTIFICATES)).toEqual([])
    settings.writeTyped(WEB_TRUSTED_CERTIFICATES, [{ host: 'vm-soft04', fingerprint: sha([1]), addedAt: 2 }])
    expect(settings.readTyped(WEB_TRUSTED_CERTIFICATES)).toEqual([{ host: 'vm-soft04', fingerprint: sha([1]), addedAt: 2 }])
    db.close()
  })
})

describe('例外は Web 表示の session だけ (TODO 547、ソースの検査)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
    })

  it('598-2: 決めるのは web/extras.ts の certificate-error だけで、Web 表示の session の webContents に限る。proc は使わない', () => {
    const files = walk(join(__dirname, '..', 'src'))
    // The proc's result is cached by the network service and is not discarded even when attached again (measured, Electron 44). Trust and revocation stop working.
    expect(files.filter((file) => readFileSync(file, 'utf8').includes('.setCertificateVerifyProc('))).toEqual([])
    const users = files.filter((file) => /['"]certificate-error['"]/.test(readFileSync(file, 'utf8')))
    expect(users.map((file) => file.slice(file.indexOf('src')))).toEqual([join('src', 'main', 'web', 'extras.ts')])
    const extras = readFileSync(join(__dirname, '..', 'src', 'main', 'web', 'extras.ts'), 'utf8')
    expect(extras).toContain('session.fromPartition(WEB_PARTITION)')
    expect(extras).not.toMatch(/session\.defaultSession/)
    // Does not touch the webContents of other sessions (goes back before preventDefault)
    const handler = extras.slice(extras.indexOf("app.on('certificate-error'"))
    expect(handler.indexOf('if (contents.session !== webSession) return')).toBeGreaterThan(0)
    expect(handler.indexOf('if (contents.session !== webSession) return')).toBeLessThan(handler.indexOf('event.preventDefault()'))
  })

  it('598-2: certificate-error の名前 → 番号は例外にしてよい 3 つだけ', () => {
    expect(certErrorCodeOf('net::ERR_CERT_AUTHORITY_INVALID')).toBe(-202)
    expect(certErrorCodeOf('net::ERR_CERT_COMMON_NAME_INVALID')).toBe(-200)
    expect(certErrorCodeOf('net::ERR_CERT_DATE_INVALID')).toBe(-201)
    expect(certErrorCodeOf('net::ERR_CERT_REVOKED')).toBeNull()
    expect(certErrorCodeOf(undefined)).toBeNull()
  })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('エラーの帯のボタン (TODO 547、jsdom)', () => {
  let container: HTMLDivElement
  let root: Root
  let emit: ((event: WebViewEvent) => void) | null = null
  const calls: string[] = []
  let status = { trustable: true, changed: false }
  let WebViewerPane: typeof import('../src/renderer/src/components/WebViewerPane.js').WebViewerPane
  let store: typeof import('../src/renderer/src/store.js')
  let web: typeof import('../src/renderer/src/webStore.js')

  const stub = (): void => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    }
    window.focus = () => undefined
    ;(window as unknown as { aios: unknown }).aios = {
      web: {
        load: vi.fn(async (url: string) => {
          calls.push(`load:${url}`)
          return true
        }),
        setBounds: vi.fn(async () => undefined),
        setVisible: vi.fn(async () => null),
        setShortcuts: vi.fn(async () => undefined),
        reload: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onEvent: (listener: (event: WebViewEvent) => void) => {
          emit = listener
          return () => {
            emit = null
          }
        },
        certificateStatus: vi.fn(async (url: string) => {
          calls.push(`status:${url}`)
          return status
        }),
        trustCertificate: vi.fn(async (url: string) => {
          calls.push(`trust:${url}`)
          return true
        })
      },
      app: {
        openExternal: vi.fn(async (url: string) => {
          calls.push(`external:${url}`)
          return true
        })
      }
    }
  }

  beforeAll(async () => {
    stub()
    ;({ WebViewerPane } = await import('../src/renderer/src/components/WebViewerPane.js'))
    store = await import('../src/renderer/src/store.js')
    web = await import('../src/renderer/src/webStore.js')
  })

  beforeEach(async () => {
    stub()
    calls.length = 0
    status = { trustable: true, changed: false }
    store.useStore.setState({ selectedUri: 'https://vm-soft04/redmine/', viewerDeferred: false, transient: null })
    web.useWeb.setState({ tabs: EMPTY_WEB_TABS, favorites: [] })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(WebViewerPane, { uri: 'https://vm-soft04/redmine/', nav: null, close: null }))
    })
    calls.length = 0
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const fail = async (code: number): Promise<void> => {
    await act(async () => {
      emit?.({ kind: 'failed', code, url: 'https://vm-soft04/redmine/issues/1' })
      await Promise.resolve()
    })
  }

  it('-202: 帯に信用するボタンとブラウザで開く。押すと信用して読み直す', async () => {
    await fail(-202)
    expect(calls).toEqual(['status:https://vm-soft04/redmine/issues/1'])
    const banner = container.querySelector('.web-viewer-failed') as HTMLElement
    expect(banner.textContent).toContain('vm-soft04')
    const trust = banner.querySelector('.web-cert-trust') as HTMLButtonElement
    expect(trust).not.toBeNull()
    await act(async () => (banner.querySelector('.web-failed-external') as HTMLButtonElement).click())
    expect(calls.at(-1)).toBe('external:https://vm-soft04/redmine/issues/1')
    await act(async () => {
      trust.click()
      await Promise.resolve()
    })
    expect(calls.slice(-2)).toEqual([
      'trust:https://vm-soft04/redmine/issues/1',
      'load:https://vm-soft04/redmine/issues/1'
    ])
    expect(container.querySelector('.web-viewer-failed')).toBeNull()
  })

  it('証明書以外のエラーは聞かず、信用するボタンも出さない', async () => {
    await fail(-102)
    expect(calls).toEqual([])
    expect(container.querySelector('.web-cert-trust')).toBeNull()
    expect(container.querySelector('.web-failed-external')).not.toBeNull()
  })

  it('main が候補を覚えていなければ (失効など) ボタンを出さない', async () => {
    status = { trustable: false, changed: false }
    await fail(-206)
    expect(container.querySelector('.web-cert-trust')).toBeNull()
  })
})
