/**
 * Secret redaction before saving. The implementation is `src/shared/redact.ts` (item 286: moved to shared so it also applies to the renderer's display).
 * A re-export so that existing imports in main / the index side (`common/redact.js`) do not change.
 */
export * from '../shared/redact.js'
