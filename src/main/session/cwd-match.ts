/**
 * A key that treats folders as the same through the real path + folding (item 239).
 *
 * Measurement in 233: the `cwd` in the CLI's transcript is recorded as the real path (`/private/var/…`), but the
 * folder chosen in the create dialog may be spelled through a symlink (`/tmp/…` or a user's symlink). If both are
 * passed through `realpath` and then folded (`foldPath`: case + NFC), the same folder gets the same key. If
 * `realpath` fails (gone, no permission), fold the spelling as given: this errs toward "give up only the symlink
 * resolution" rather than "no key".
 */
import { realpath } from 'node:fs/promises'
import { foldPath } from '../../common/uri.js'

export async function cwdMatchKey(path: string): Promise<string> {
  try {
    return foldPath(await realpath(path))
  } catch {
    return foldPath(path)
  }
}
