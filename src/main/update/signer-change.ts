/**
 * TODO 1090: whether an update changes the signer (= whether a keychain prompt appears on the first launch after the restart).
 *
 * The ACL of a keychain item is per signer (designated requirement). If the signer changes, it is treated as a different app and macOS shows a prompt
 * (`docs/notes/app-shell.md`, "Keychain and launch pitfalls"). This check is used only to decide whether to show an explanation — it does not stop the update.
 *
 * The pure comparison (`keychainPromptExpected`) is separated from the read that calls `codesign` (`readBundleSigner`).
 * Unreadable, ad-hoc, and other signers fall to the "show" side.
 */
import { OS_TOOLS } from '../../common/os/tools.js'
import type { CommandRunner } from './release-source.js'
import { signerOf, type BundleSigner } from './stage.js'

/** Whether it is the same signer. Developer ID is compared by Team ID, self-signed by certificate name. Ad-hoc and "other" cannot be called the same (different on every build). */
export function sameSigner(a: BundleSigner, b: BundleSigner): boolean {
  if (a.kind === 'developer-id' && b.kind === 'developer-id') return a.teamId === b.teamId
  if (a.kind === 'self-signed' && b.kind === 'self-signed') return a.name === b.name
  return false
}

/** Whether updating from the running version `current` to `next` may bring up a prompt. True if either is unreadable (null). */
export function keychainPromptExpected(current: BundleSigner | null, next: BundleSigner | null): boolean {
  if (current === null || next === null) return true
  return !sameSigner(current, next)
}

/** The signer of `bundle`. Null if `codesign` fails, times out, or the command is missing. */
export async function readBundleSigner(bundle: string, run: CommandRunner): Promise<BundleSigner | null> {
  try {
    const detail = await run(OS_TOOLS.codesign, ['-dv', '--verbose=2', bundle], { timeoutMs: 15_000 })
    if (detail.code !== 0) return null
    return signerOf(`${detail.stdout}\n${detail.stderr}`)
  } catch {
    return null
  }
}

/** Read and compare the signers of two .app bundles. */
export async function detectKeychainPrompt(currentBundle: string, nextBundle: string, run: CommandRunner): Promise<boolean> {
  const [current, next] = await Promise.all([readBundleSigner(currentBundle, run), readBundleSigner(nextBundle, run)])
  return keychainPromptExpected(current, next)
}
