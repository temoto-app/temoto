/**
 * A minimal Chrome DevTools Protocol client for the smoke test (TODO 1307). Uses Node's built-in `WebSocket` (Node 22), so no
 * dependency is added (owner decision 2026-11-22: no Playwright). It only talks to the loopback port of the app this run started.
 */

const WebSocketImpl = globalThis.WebSocket

/** Fetch the DevTools target list (`/json/list`) of the app on `port`. */
export async function listTargets(port) {
  const res = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`/json/list: HTTP ${res.status}`)
  return res.json()
}

export class CdpSession {
  /** Open a session on a target's `webSocketDebuggerUrl`. */
  static connect(wsUrl, { timeoutMs = 10_000 } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('この Node には WebSocket が無い (Node 22 以降が要る)')
    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(wsUrl)
      const timer = globalThis.setTimeout(() => {
        ws.close()
        reject(new Error(`CDP の接続が ${timeoutMs} ms で開かない: ${wsUrl}`))
      }, timeoutMs)
      ws.addEventListener('open', () => {
        globalThis.clearTimeout(timer)
        resolve(new CdpSession(ws))
      })
      ws.addEventListener('error', () => {
        globalThis.clearTimeout(timer)
        reject(new Error(`CDP の接続に失敗: ${wsUrl}`))
      })
    })
  }

  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => this.onMessage(event.data))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('CDP の接続が閉じた'))
      this.pending.clear()
    })
  }

  onMessage(data) {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const waiter = this.pending.get(msg.id)
    if (waiter === undefined) return
    this.pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`))
    else waiter.resolve(msg.result)
  }

  /** Send one command and wait for its result (bounded by `timeoutMs`). */
  send(method, params = {}, { timeoutMs = 15_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP の接続が閉じている'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: ${timeoutMs} ms で応答なし`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          globalThis.clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          globalThis.clearTimeout(timer)
          reject(err)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate an expression in the page and return its value. The expression is wrapped in an IIFE by the caller's convention:
   * `Runtime.evaluate` keeps top-level `const` between calls, and a second declaration of the same name fails silently.
   */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
      throw new Error(`評価が例外: ${detail}`)
    }
    return res.result?.value
  }

  /** A PNG screenshot of the page, as a Buffer-ready base64 string. */
  async screenshot() {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    return res.data
  }

  close() {
    if (!this.closed) this.ws.close()
    this.closed = true
  }
}
