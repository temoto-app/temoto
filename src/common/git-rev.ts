/**
 * The rule for strings that may be passed as a git rev (TODO 826, TODO 828). The single definition lives in `src/shared/git-rev.ts`
 * since TODO 834 (the git extension and the Broker's git capability validate revs with it too); this re-export keeps the existing import sites.
 */
export { GIT_REV_PATTERN, MAX_GIT_REV, isGitRev } from '../shared/git-rev.js'
