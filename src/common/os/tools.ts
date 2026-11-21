/**
 * OS layer (TODO 986): **the table of OS-bundled tools** that aios calls. This is the only place that writes their names and locations
 * (`npm run lint:os` rejects names from this table and strings shaped like `/usr/bin/…` outside the OS layer).
 *
 * Tools are looked up by fixed absolute path (not relying on the PATH of an aios launched from the GUI). Only `open` was already looked up
 * through PATH before the move, so it stays a bare name (behavior unchanged). All are macOS tools, and the Windows version (TODO 899) will
 * provide a replacement for each user of them - the users can be found as the places that import `OS_TOOLS`.
 *
 * The four used by the auto-update of distributed builds (signature check, unpacking, quarantine attribute and Info.plist reading in `src/main/update/`:
 * `codesign` / `ditto` / `xattr` / `plutil`) were also moved into this table in TODO 986 stage 2. As before the move they stay bare names looked up via PATH (a test's fake
 * `CommandRunner` tells them apart by name. Behavior unchanged).
 */
export const OS_TOOLS = {
  /** Signature check of distributed builds (`codesign --verify` / `-dv`, `src/main/update/stage.ts` / `signer-change.ts`). Looked up via PATH. */
  codesign: 'codesign',
  /** Unpacking the zip of a distributed build (`ditto -x -k`, `stage.ts`). Preserves Framework symlinks. Looked up via PATH. */
  ditto: 'ditto',
  /** Removing the quarantine attribute (`xattr -dr com.apple.quarantine`, `stage.ts`). Looked up via PATH. */
  xattr: 'xattr',
  /** Reading the version from `Info.plist` (`plutil -extract`, `stage.ts`). Looked up via PATH. */
  plutil: 'plutil',
  /** Reads Low Power Mode (`pmset -g`, `src/main/os/power.ts`). */
  pmset: '/usr/bin/pmset',
  /** The UUID of an external volume (`diskutil info -plist`, `src/index-kernel/volumes.ts`). */
  diskutil: '/usr/sbin/diskutil',
  /** Converts HEIC etc. to JPEG (`src/main/image/display.ts`). */
  sips: '/usr/bin/sips',
  /** Captures part of the screen (`src/main/paste/screen-capture.ts`). */
  screencapture: '/usr/sbin/screencapture',
  /** Reads only the attributes of keychain items (for auth diagnostics; secrets are not read). */
  security: '/usr/bin/security',
  /** Opens an app by name (`open -a <App> <path>`, the external-editor alternative and open in terminal). Looked up via PATH. */
  open: 'open',
  /** The default for the `!` shell and the login shell (when the user has no `$SHELL`). */
  zsh: '/bin/zsh',
  /** The limit of what can go to the GPU (`sysctl -n iogpu.wired_limit_mb`, `src/main/os/hardware.ts`, TODO 1066). */
  sysctl: '/usr/sbin/sysctl',
  /**
   * The NVIDIA GPU's name and VRAM (`src/main/os/hardware.ts`, TODO 1066). A tool installed by Windows / Linux drivers whose
   * location is not fixed, so it is looked up via PATH. If absent it is treated as "no NVIDIA".
   */
  nvidiaSmi: 'nvidia-smi'
} as const

/** The minimal `PATH` passed to child processes (used where the caller's PATH and DYLD_* must not be passed). */
export const OS_MINIMAL_PATH = '/usr/bin:/bin'

/** Line 1 of the "open in terminal" `.command` (a login shell. `-il` so that the user's PATH is searched rather than the GUI launch's PATH, `src/main/editor/terminal.ts`). */
export const OS_TERMINAL_SCRIPT_SHEBANG = '#!/bin/zsh -il'
/** The name of the terminal app passed to `open -a` (`src/main/editor/terminal.ts`). */
export const OS_TERMINAL_APP = 'Terminal'
