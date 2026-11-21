/**
 * Hands-on check of TODO 817 stage A: does login with the real Google go through? (It calls no model and does not start the app.)
 *
 *   1. Reads `~/.config/aios/google-oauth-client.json` (the desktop-app type)
 *   2. Opens the consent screen in the default browser, and receives the code on loopback (`google-oauth.ts`)
 *   3. Looks up `users/me/profile` and prints only the count
 *   4. Checks once that an access token can be re-acquired with the refresh token
 *
 * **The tokens are not saved and not printed** (only whether they exist, and their expiry). Mail bodies, subjects and senders are not fetched either.
 * On a consent screen in "testing" mode, Google shows "Google hasn't verified this app": open the details link, then continue.
 *
 *   npx vite-node -c vitest.config.ts scripts/gmail-login-probe.mts
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loginWithLoopback, parseClientConfig, refreshAccessToken, type FetchFn } from '../src/main/capability/google-oauth.js'

const CLIENT_FILE = join(homedir(), '.config', 'aios', 'google-oauth-client.json')
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const fetchFn: FetchFn = async (url, init) => {
  const res = await fetch(url, init)
  return { status: res.status, text: () => res.text() }
}

const client = parseClientConfig(readFileSync(CLIENT_FILE, 'utf8'))
console.log('ブラウザで同意画面を開きます (5 分以内に完了してください)…')

const tokens = await loginWithLoopback({
  client,
  scopes: [SCOPE],
  fetchFn,
  openUrl: (url) => {
    // `open` takes the URL as an argument (it does not go through a shell).
    execFile('open', [url], (err) => {
      if (err !== null) console.error('ブラウザを開けませんでした。次の URL を手で開いてください:\n' + url)
    })
  }
})
console.log(`ログイン OK: scope=${tokens.scope} refreshToken=${tokens.refreshToken !== null ? 'あり' : 'なし'} 期限=${Math.round((tokens.expiresAt - Date.now()) / 60000)} 分後`)

const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
  headers: { authorization: `Bearer ${tokens.accessToken}` }
})
const body = (await profile.json()) as { emailAddress?: string; messagesTotal?: number; threadsTotal?: number; error?: { message?: string } }
if (!profile.ok) {
  console.error(`profile 失敗: http ${profile.status} ${body.error?.message ?? ''}`)
  process.exit(1)
}
console.log(`profile: ${body.emailAddress} / messages=${body.messagesTotal} / threads=${body.threadsTotal}`)

if (tokens.refreshToken !== null) {
  const again = await refreshAccessToken(client, tokens.refreshToken, fetchFn)
  console.log(`refresh OK: 新しい access token 期限=${Math.round((again.expiresAt - Date.now()) / 60000)} 分後`)
} else {
  console.log('refresh token が返らなかったので、更新は試していません')
}
