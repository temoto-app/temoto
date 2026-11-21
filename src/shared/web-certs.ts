/**
 * Certificate exceptions for the Web view (TODO 547, wave 27 bundle B, ARCHITECTURE 5.2.1). For internal https servers (self-signed, internal CA), remember per
 * host "trust this certificate (SHA-256 fingerprint)". **It takes effect only in the Web view's session
 * (`persist:aios-web`)**; it has no effect on the network entry points of main, plugins or the CapabilityBroker.
 *
 * Types and pure functions only. Decision and storage are in main (`src/main/web/certificates.ts`).
 */

/** One remembered exception (`web.trustedCertificates` in `app_settings`). */
export interface TrustedCertificate {
  /** Host name (lowercase, no port). */
  readonly host: string
  /** SHA-256 of the certificate (DER), 64 lowercase hex digits. */
  readonly fingerprint: string
  /** Time it was trusted (ms). */
  readonly addedAt: number
}

/** State of the certificate of a page that failed to load (decides which button the renderer shows in the error band). */
export interface WebCertificateStatus {
  /** This host's certificate can be made an exception (main remembers the certificate it just refused). */
  readonly trustable: boolean
  /** It changed from the previously trusted certificate (the fingerprint differs). */
  readonly changed: boolean
}

export const UNTRUSTABLE_CERTIFICATE: WebCertificateStatus = { trustable: false, changed: false }

/**
 * Chromium certificate errors that may be made exceptions (`net_error_list.h`). The equivalent of Chrome's "Advanced -> Proceed":
 * -200 `ERR_CERT_COMMON_NAME_INVALID` (opened with a short internal name) / -201 `ERR_CERT_DATE_INVALID` (an expired
 * self-signed one) / -202 `ERR_CERT_AUTHORITY_INVALID` (self-signed, internal CA). Revocation (-206) and the like are not made exceptions.
 */
export const TRUSTABLE_CERT_ERRORS: readonly number[] = [-200, -201, -202]

/** The range of Chromium certificate errors (-200 to -299). */
export function isCertificateError(code: number): boolean {
  return Number.isInteger(code) && code <= -200 && code > -300
}

export function isTrustableCertError(code: number): boolean {
  return TRUSTABLE_CERT_ERRORS.includes(code)
}

/** Upper bound on the number remembered (the oldest are dropped first). */
export const MAX_TRUSTED_CERTIFICATES = 100

const HOST_RE = /^[a-z0-9.-]{1,253}$|^\[[0-9a-f:.]+\]$/
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

/** Put a host name into the exception key form (lowercase). null if the shape does not fit. */
export function certificateHostOf(host: unknown): string | null {
  if (typeof host !== 'string') return null
  const lower = host.toLowerCase()
  return HOST_RE.test(lower) ? lower : null
}

/** Validation of the stored `web.trustedCertificates`. Broken entries are dropped, for the same host the later one is kept, and the oldest are dropped when over the limit. */
export function sanitizeTrustedCertificates(raw: unknown): readonly TrustedCertificate[] {
  if (!Array.isArray(raw)) return []
  const byHost = new Map<string, TrustedCertificate>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    const host = certificateHostOf(r['host'])
    const fingerprint = typeof r['fingerprint'] === 'string' ? r['fingerprint'].toLowerCase() : ''
    const addedAt = r['addedAt']
    if (host === null || !FINGERPRINT_RE.test(fingerprint)) continue
    if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) continue
    byHost.delete(host)
    byHost.set(host, { host, fingerprint, addedAt })
  }
  return [...byHost.values()].slice(-MAX_TRUSTED_CERTIFICATES)
}

/** Put a fingerprint into a form a person can read (the first 8 groups of `AB:CD:…` + `…`). The badge in the settings list. */
export function shortFingerprint(fingerprint: string): string {
  const pairs = fingerprint.toUpperCase().match(/.{2}/g) ?? []
  return pairs.length > 8 ? `${pairs.slice(0, 8).join(':')}…` : pairs.join(':')
}
