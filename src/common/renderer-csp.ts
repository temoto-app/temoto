/**
 * The renderer CSP of distributed builds (TODO 856). The dev server's `index.html` has
 * `connect-src 'self' ws: http://localhost:*` for Vite's HMR, but in build output it is only `'self'`
 * (`ws:` allows any host, so it would be a place to exfiltrate to if a script ever ran in the renderer).
 */
const DEV_CONNECT = "connect-src 'self' ws: http://localhost:*"
const BUILD_CONNECT = "connect-src 'self'"

export function tightenConnectSrc(html: string): string {
  return html.replace(DEV_CONNECT, BUILD_CONNECT)
}
