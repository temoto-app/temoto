/**
 * The configuration for contract tests (ARCHITECTURE.md 4.6 / 12.6).
 *
 * **Not included in `npm test`.** A test here starts the installed backend CLI for real, so it uses subscription usage
 * (about 21k cache-creation tokens per session). Run it explicitly with `npm run test:contract`.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['test/contract/**/*.test.ts'],
    // Makes a temporary folder `~/.aios-test/<run>/` for the tests, and deletes it whole when they finish (TODO 262).
    globalSetup: ['test/setup/tmp-global.ts'],
    // TODO 1263: the same as vitest.config.ts. The adapter's spawn builds the gateway instructions from the data name
    // (`appIdentity()`), which throws until it is fixed (test/vitest-configs.test.ts checks that both configs carry it).
    setupFiles: ['test/setup/app-identity.ts'],
    // Allows for the startup (CLI 0.7 seconds + gateway 1.35 seconds) and the init round trip.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
