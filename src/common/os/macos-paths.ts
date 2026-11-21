/**
 * OS layer (TODO 986 stage 2, ARCHITECTURE 3.4): the table of macOS paths. The exclusion rules (`../exclusions.ts`) draw on it.
 *
 * "OS areas", "how ~/Library is treated" and "places protected by TCC (privacy protection)" are the shape of the macOS file system itself.
 * The Windows version (TODO 899) adds a different table (`C:\\Windows` etc.) - the construction of the exclusion rules (`exclusions.ts`) just draws on this table.
 * The contents are the same as before they were moved here (behavior unchanged). It does not import electron (also used from the index process; constraint 8.1).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The user's Library (`~/Library`, the apps' internal data. The base of the exclusion rules). */
export const USER_LIBRARY_DIR = '~/Library'
/** Where users install apps (the "Applications" shortcut and the default reference target). */
export const APPLICATIONS_DIR = '/Applications'
/** Where iCloud Drive lives (relative to home). */
export const ICLOUD_DRIVE_REL = 'Library/Mobile Documents/com~apple~CloudDocs'

/** `PATH` of a GUI launch (Finder / Dock / Spotlight) - the default launchd passes. If it is "only" this, it is treated as a GUI launch (`src/main/path-env.ts`). */
export const GUI_LAUNCH_DEFAULT_PATH: readonly string[] = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** Candidates added to `PATH` when the login shell does not answer (Homebrew etc.). Only those that exist are used (`src/main/path-env.ts`). */
export const GUI_LAUNCH_FALLBACK_BIN_DIRS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin')
]

/** 4.4.1 the macOS app cache location (added to the package-cache table). */
export const MACOS_CACHE_DIR = '~/Library/Caches'

/** 4.4.2 macOS: OS areas. What is excluded, and what is included within it. */
export const SYSTEM_EXCLUDE = [
  '/System',
  '/Library',
  '/private',
  '/usr',
  '/bin',
  '/sbin',
  '/cores',
  '/dev',
  '/tmp',
  '/var',
  // Since Phase 3 the scan starts from `/`, so the "OS areas" directly under the root
  // (the intent of 4.4.2) are added explicitly. `/etc` is a symlink to `/private/etc`,
  // so the `/private` rule does not catch it. `/net` and `/home` are autofs, and
  // touching them triggers a mount and stalls the scan.
  '/etc',
  '/net',
  '/home',
  '/Network',
  '/.vol',
  '/.Spotlight-V100',
  '/.fseventsd',
  '/.DocumentRevisions-V100',
  '/.TemporaryItems',
  '/.Trashes'
]
export const SYSTEM_INCLUDE = ['/Applications', '/opt', '/usr/local']

/** 4.4.2 macOS: `~/Library` is excluded and only iCloud Drive is included. */
export const LIBRARY_INCLUDE = [`~/${ICLOUD_DRIVE_REL}`]

/** Places protected by TCC (always excluded, reason `tcc-protected`. Notes are at `TCC_REASON` in `../exclusions.ts`). */
export const TCC_DIRS = [
  '~/Library/Mail', // Mail (Full Disk Access)
  '~/Library/Messages', // Messages (Full Disk Access)
  '~/Library/Safari', // Safari history and tabs (Full Disk Access)
  '~/Library/Cookies', // Safari / system cookies
  // The contents of other apps' sandboxes (TCC for "access to other apps' data" since macOS 14. The Containers / Group Containers of Mail, Safari, Notes,
  // Reminders, Calendar and Contacts also fall in here). In the wave 45 code review the individual
  // rows (`com.apple.mail` / `com.apple.Safari` / `group.com.apple.notes` ...) were merged into these two rows.
  '~/Library/Containers',
  '~/Library/Group Containers',
  '~/Library/Calendars',
  '~/Library/Reminders',
  '~/Library/Application Support/AddressBook', // Contacts
  '~/Library/Application Support/CallHistoryDB', // Call history
  '~/Library/Application Support/CallHistoryTransactions',
  '~/Library/Application Support/com.apple.TCC', // The privacy settings themselves
  '~/Library/Application Support/Knowledge', // Usage history (KnowledgeC)
  '~/Library/Application Support/FaceTime',
  '~/Library/Suggestions',
  '~/Library/HomeKit', // Home (HomeKit)
  '~/Library/IdentityServices', // iMessage / FaceTime identity
  '~/Library/Photos',
  '~/Pictures/Photos Library.photoslibrary' // Photos library (outside ~/Library but under the same TCC)
]

/** Places for the user's documents protected by TCC (not excluded, but scan and watch do not touch them for the first 3 days after they are added. TODO 805, `../exclusions.ts`). */
export const TCC_DEFERRED_DIRS = ['~/Desktop', '~/Documents', '~/Downloads'] as const
