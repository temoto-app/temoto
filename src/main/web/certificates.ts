/**
 * Certificate exceptions for the Web view (TODO 547, wave 27 bundle B, ARCHITECTURE 5.2.1). **Does not import electron** —
 * the wiring to the real electron (`certificate-error`, only for webContents of the Web view's session) is in `web/extras.ts`, and
 * tests call it plainly.
 *
 * - `verify`: called every time a page in the Web view's session (`persist:aios-web`) is stopped by a certificate error
 *   (in 598-2 it was moved from inside `setCertificateVerifyProc` to `certificate-error` — the proc's result is cached by the network service
 *   and was not dropped even when re-applied, so neither a reload right after trusting nor a revocation took effect). If Chromium's check passed,
 *   leave it (-3 = use Chromium's result). For an error that may become an exception (`TRUSTABLE_CERT_ERRORS`), if it matches the remembered
 *   host + fingerprint, return 0 (accept). If it does not match, refuse and **remember that certificate as a "candidate to ask about"**
 *   (the renderer's error band shows "trust this host's certificate").
 * - `trust`: pressed in the renderer. Only the fingerprint of the certificate main itself saw is trusted (the renderer passes only a URL).
 * - If the fingerprint changes it no longer matches, so it asks again (`status().changed`).
 *
 * The log has only host names and numbers (not even fingerprints).
 */
import { createHash } from 'node:crypto'
import {
  MAX_TRUSTED_CERTIFICATES,
  UNTRUSTABLE_CERTIFICATE,
  certificateHostOf,
  isTrustableCertError,
  sanitizeTrustedCertificates,
  type TrustedCertificate,
  type WebCertificateStatus
} from '@shared/web-certs.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { log } from '../../common/logger.js'

/** The reply for `setCertificateVerifyProc`: 0 = accept, -3 = leave it to Chromium's decision. */
export const CERT_ACCEPT = 0
export const CERT_USE_CHROMIUM = -3

/**
 * electron's `certificate-error` `error` (Chromium's name) -> number (598-2). Only the 3 that may become exceptions.
 * Anything else is null (not made an exception — the caller refuses).
 */
const CERT_ERROR_CODES: Readonly<Record<string, number>> = {
  'net::ERR_CERT_COMMON_NAME_INVALID': -200,
  'net::ERR_CERT_DATE_INVALID': -201,
  'net::ERR_CERT_AUTHORITY_INVALID': -202
}

export function certErrorCodeOf(name: unknown): number | null {
  return typeof name === 'string' ? (CERT_ERROR_CODES[name] ?? null) : null
}

/** How many candidates to ask about are remembered (per host). */
const MAX_PENDING = 32

/** The SHA-256 (lowercase hex) of the DER of a PEM (`-----BEGIN CERTIFICATE-----`). Null if unreadable. */
export function fingerprintOfPem(pem: unknown): string | null {
  if (typeof pem !== 'string') return null
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)
  const body = match?.[1]?.replace(/\s+/g, '')
  if (body === undefined || body === '' || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null
  const der = Buffer.from(body, 'base64')
  if (der.length === 0) return null
  return createHash('sha256').update(der).digest('hex')
}

/** The part of a verification query used here (a portion of electron's `Request`). */
export interface CertificateCheck {
  readonly hostname: string
  /** Chromium's decision (0 = passed, negative = an error from `net_error_list.h`). */
  readonly errorCode: number
  /** The PEM of the leaf certificate. */
  readonly certificatePem: string
}

export interface WebCertificateTrustDeps {
  read(): readonly TrustedCertificate[]
  write(list: readonly TrustedCertificate[]): void
  now?(): number
  /** The remembered exceptions changed (drop the network service's cache of verification results, `extras.ts`). */
  changed?(): void
}

export class WebCertificateTrust {
  private list: readonly TrustedCertificate[] | null = null
  /** Host -> the certificate refused most recently (only for errors that may become exceptions). */
  private readonly pending = new Map<string, { readonly fingerprint: string; readonly changed: boolean }>()

  constructor(private readonly deps: WebCertificateTrustDeps) {}

  /** The remembered exceptions (read only the first time). */
  trusted(): readonly TrustedCertificate[] {
    if (this.list === null) {
      try {
        this.list = sanitizeTrustedCertificates(this.deps.read())
      } catch {
        this.list = []
      }
    }
    return this.list
  }

  /** Certificate verification (the body of `setCertificateVerifyProc`). */
  verify(check: CertificateCheck): number {
    if (check.errorCode === 0 || !isTrustableCertError(check.errorCode)) return CERT_USE_CHROMIUM
    const host = certificateHostOf(check.hostname)
    const fingerprint = fingerprintOfPem(check.certificatePem)
    if (host === null || fingerprint === null) return CERT_USE_CHROMIUM
    const known = this.trusted().find((entry) => entry.host === host)
    if (known !== undefined && known.fingerprint === fingerprint) return CERT_ACCEPT
    if (this.pending.size >= MAX_PENDING && !this.pending.has(host)) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(host, { fingerprint, changed: known !== undefined })
    log.warn('web.cert.rejected', { host, code: check.errorCode, changed: known !== undefined })
    return CERT_USE_CHROMIUM
  }

  /** Whether the certificate of a `url` that failed to load can be made an exception. */
  status(url: unknown): WebCertificateStatus {
    const host = hostOfUrl(url)
    const seen = host === null ? undefined : this.pending.get(host)
    return seen === undefined ? UNTRUSTABLE_CERTIFICATE : { trustable: true, changed: seen.changed }
  }

  /** Trust the certificate most recently refused for the host of `url`. False if none is remembered. */
  trust(url: unknown): boolean {
    const host = hostOfUrl(url)
    const seen = host === null ? undefined : this.pending.get(host)
    if (host === null || seen === undefined) return false
    const entry: TrustedCertificate = { host, fingerprint: seen.fingerprint, addedAt: this.now() }
    const next = [...this.trusted().filter((item) => item.host !== host), entry].slice(-MAX_TRUSTED_CERTIFICATES)
    this.pending.delete(host)
    this.save(next)
    log.info('web.cert.trusted', { host, changed: seen.changed })
    return true
  }

  /** Revoke an exception (the list in settings). Nothing happens if there is none. */
  revoke(host: unknown): readonly TrustedCertificate[] {
    const key = certificateHostOf(host)
    const current = this.trusted()
    if (key === null || !current.some((item) => item.host === key)) return current
    this.save(current.filter((item) => item.host !== key))
    log.info('web.cert.revoked', { host: key })
    return this.trusted()
  }

  private save(next: readonly TrustedCertificate[]): void {
    this.list = sanitizeTrustedCertificates(next)
    try {
      this.deps.write(this.list)
    } catch (err) {
      log.warn('web.cert.saveFailed', { message: err instanceof Error ? err.message : String(err) })
    }
    this.deps.changed?.()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function hostOfUrl(url: unknown): string | null {
  if (!isWebViewerUrl(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? certificateHostOf(parsed.hostname) : null
  } catch {
    return null
  }
}
