import { BlockList, isIPv4, isIPv6 } from 'node:net'

/**
 * Policy for the network capability (the `network` row of ARCHITECTURE.md 7.7).
 *
 * There is no I/O here: it is a **pure function that only decides**, so it can be unit tested
 * (IMPLEMENTATION_BRIEF chapter 7: "the Broker's network check requires unit tests
 * including private IP cases"). The actual sending is done by `network.ts`.
 *
 * What it guards:
 * - Matching against the manifest's allowed hosts (`*.example.com` only within the same domain)
 * - **The IP check after name resolution.** Rejects loopback / link-local / RFC 1918 and so on.
 *   Even if the host name is on the allowlist, it is stopped if it resolves to an internal IP
 *   (effective against both DNS rebinding and SSRF)
 * - Redirect targets pass the same check and never leave the allowlist
 * - The credential header is attached **only when it matches the bound host exactly**,
 *   and stripped when the host changes
 */

/** Upper bound received in one response. It is also cut on the gateway side before reaching the LLM, but it is stopped at the entrance too. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Upper bound on redirects followed. */
export const MAX_REDIRECTS = 5
/** Send rate per plugin (requests / minute). */
export const RATE_LIMIT_PER_MINUTE = 60

export type NetDenyReason =
  | 'scheme'
  | 'host-not-allowed'
  | 'private-address'
  | 'no-address'
  | 'too-many-redirects'
  | 'rate-limited'
  | 'credential-host-mismatch'

export class NetDenied extends Error {
  constructor(readonly reason: NetDenyReason) {
    super(reason)
    this.name = 'NetDenied'
  }
}

/**
 * Matching against the allowed hosts.
 *
 * - Exact match
 * - `*.example.com` matches `a.example.com` but not `example.com` itself or
 *   `evil-example.com` ("a wildcard applies only within the same domain", 7.2)
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const target = host.toLowerCase()
  return allowed.some((raw) => {
    const pattern = raw.toLowerCase()
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      return target.endsWith(suffix) && target.length > suffix.length
    }
    return target === pattern
  })
}

/** Turns a dotted-decimal IPv4 into bytes. null if the format is wrong. */
function parseIPv4(value: string): readonly number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/** IPv4 ranges that are rejected: loopback / RFC 1918 / CGNAT / link-local / reserved and multicast, and so on. */
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // unspecified, "this host"
  ['10.0.0.0', 8], // RFC 1918
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes the 169.254.169.254 metadata address)
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['192.0.0.0', 16], // includes 192.0.0/24 (IETF) and 192.0.2/24 (TEST-NET)
  ['198.18.0.0', 15], // for benchmarking
  ['224.0.0.0', 3] // multicast / reserved / 255.255.255.255
]

/** IPv6 ranges that are rejected: loopback / unspecified / ULA / link-local / multicast. */
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['::1', 128], // loopback
  ['::', 128], // unspecified
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, TODO 1135)
  ['::', 96], // IPv4-compatible (::127.0.0.1 / ::7f00:1. TODO 1135)
  // The IPv4-mapped range (::ffff:0:0/96) is not added: BlockList matches v4 as mapped addresses, so it would reject every v4 (the v4 rules already apply).
  ['::ffff:0:0:0', 96], // IPv4-translated (::ffff:0:7f00:1 = 0:0:0:ffff:0:0:7f00:1. TODO 1135)
  ['ff00::', 8] // multicast
]

function buildBlockList(): BlockList {
  const list = new BlockList()
  for (const [net, prefix] of BLOCKED_IPV4_SUBNETS) list.addSubnet(net, prefix, 'ipv4')
  for (const [net, prefix] of BLOCKED_IPV6_SUBNETS) list.addSubnet(net, prefix, 'ipv6')
  return list
}

/**
 * `BlockList` correctly applies the v4 rules to IPv6 in expanded and compressed forms and to both
 * IPv4-mapped forms, `::ffff:a.b.c.d` and `::ffff:7f00:1` (confirmed in node:net's implementation).
 * What it does not apply to is NAT64 / 6to4 / Teredo, so those are stripped by hand and run through the v4 rules.
 */
const blockList = buildBlockList()

/** Expands an IPv6 string into 8 groups (0 to 0xffff). null if the format is wrong. */
function expandIPv6Groups(value: string): readonly number[] | null {
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : null
  let parts: string[]
  if (tail === null) {
    parts = head
    if (parts.length !== 8) return null
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    parts = [...head, ...Array(missing).fill('0'), ...tail]
  }
  const groups: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  return groups.length === 8 ? groups : null
}

function dotted(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/**
 * Extracts every IPv4 embedded in an IPv6 address, in dotted notation (empty if none apply).
 * NAT64 (`64:ff9b::/96`), local NAT64 (`64:ff9b:1::/48`, the low 32 bits), 6to4 (`2002:AABB:CCDD::/16`),
 * and Teredo (`2001::/32`; the server = groups 2 to 3, the client = groups 6 to 7 with bits inverted). TODO 1073.
 */
function extractEmbeddedIPv4(value: string): string[] {
  // If the end is dotted decimal (`64:ff9b::10.0.0.1`), first convert it into 2 hex groups and then expand.
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  const dottedTail = tail.includes('.') ? parseIPv4(tail) : null
  const normalized =
    dottedTail === null
      ? value
      : `${value.slice(0, lastColon + 1)}${(((dottedTail[0] ?? 0) << 8) | (dottedTail[1] ?? 0)).toString(16)}:${(((dottedTail[2] ?? 0) << 8) | (dottedTail[3] ?? 0)).toString(16)}`

  const g = expandIPv6Groups(normalized)
  if (g === null) return []
  const at = (i: number): number => g[i] ?? 0
  if (at(0) === 0x64 && at(1) === 0xff9b) {
    if (at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0) return [dotted(at(6), at(7))]
    if (at(2) === 1) return [dotted(at(6), at(7))]
    return []
  }
  if (at(0) === 0x2002) return [dotted(at(1), at(2))]
  if (at(0) === 0x2001 && at(1) === 0) {
    return [dotted(at(2), at(3)), dotted(at(6) ^ 0xffff, at(7) ^ 0xffff)]
  }
  return []
}

/**
 * Whether it is an address that must not be connected to (7.7).
 *
 * Rejected: loopback (127/8, ::1), link-local (169.254/16, fe80::/10),
 * RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10),
 * unspecified (0.0.0.0, ::), broadcast and multicast, ULA (fc00::/7),
 * and anything that turns into an internal address via IPv4-mapped / NAT64.
 *
 * **The expanded form (`0:0:0:0:0:0:0:1`) and hex IPv4-mapped (`::ffff:7f00:1`) do not get through either**
 * (`BlockList` internally applies the v4 rules correctly to compressed and expanded forms and to both
 * `::ffff:a.b.c.d` / `::ffff:7f00:1` mappings; the earlier implementation, which looked only at the start of the string,
 * missed the expanded form).
 */
export function isBlockedAddress(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? ''

  if (isIPv4(value)) return blockList.check(value, 'ipv4') === true

  if (isIPv6(value)) {
    if (blockList.check(value, 'ipv6') === true) return true
    return extractEmbeddedIPv4(value).some((v4) => blockList.check(v4, 'ipv4') === true)
  }

  return true // The host name should already be resolved by the caller
}

export interface RequestCheck {
  readonly url: URL
  readonly allowedHosts: readonly string[]
  /** The host the credential is bound to (the header is attached only on an exact match). */
  readonly credentialHost?: string | null
}

/** The check before sending. **The result of name resolution is checked separately with `assertAddressAllowed`.** */
export function checkRequest(check: RequestCheck): void {
  if (check.url.protocol !== 'https:') throw new NetDenied('scheme')
  if (!hostAllowed(check.url.hostname, check.allowedHosts)) throw new NetDenied('host-not-allowed')
}

/** Checks the result of name resolution and returns the address that may be pinned for the connection (DNS rebinding defense). */
export function pickAddress(addresses: readonly { address: string; family: number }[]): {
  address: string
  family: number
} {
  if (addresses.length === 0) throw new NetDenied('no-address')
  // **Reject if even one resolves to an internal address.** We take "do not talk to a host that resolves
  // internally" rather than "use only permitted IPs". An attack where just one answer
  // turns internal through rebinding is stopped without relying on how the connection target is chosen.
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) throw new NetDenied('private-address')
  }
  const first = addresses[0]
  if (first === undefined) throw new NetDenied('no-address')
  return { address: first.address, family: first.family }
}

/**
 * The redirect decision.
 *
 * A redirect outside the allowlist is rejected, and **credentials are stripped when the host changes**.
 * Even for the same host, it is rejected if the scheme is not https.
 */
export function checkRedirect(
  from: URL,
  location: string,
  allowedHosts: readonly string[],
  credentialHost: string | null
): { next: URL; keepCredentials: boolean } {
  const next = new URL(location, from)
  if (next.protocol !== 'https:') throw new NetDenied('scheme')
  if (!hostAllowed(next.hostname, allowedHosts)) throw new NetDenied('host-not-allowed')
  const keepCredentials =
    credentialHost !== null && next.hostname.toLowerCase() === credentialHost.toLowerCase()
  return { next, keepCredentials }
}

/** Send rate per plugin. Rejected when exceeded (7.7 "an upper bound on rate"). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number = RATE_LIMIT_PER_MINUTE,
    private readonly windowMs: number = 60_000
  ) {}

  take(key: string, now: number = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) throw new NetDenied('rate-limited')
    recent.push(now)
    this.hits.set(key, recent)
  }
}
