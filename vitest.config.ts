import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
      // The same alias as the plugin bundle in scripts/build-plugins.mjs (TODO 439), for the tests that import a plugin's `viewer/main.ts`
      // (the entry, which uses `@pluginshared/...`) directly. The sub-modules are imported by relative paths, so the tests so far did not
      // need the alias.
      '@pluginshared': resolve(import.meta.dirname, 'plugins/_shared')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Contract tests start the installed CLI for real, so they are not put in `npm test`.
    // `npm run test:contract` runs them with vitest.contract.config.ts (4.6 / 12.6).
    exclude: ['test/contract/**', 'node_modules/**'],
    // Makes a temporary folder `~/.aios-test/<run>/` for the tests, and deletes it whole when they finish (TODO 262).
    globalSetup: ['test/setup/tmp-global.ts'],
    // TODO 1263: fix the data name the way main does at launch (the tests run under the legacy name `aios`).
    setupFiles: ['test/setup/app-identity.ts']
    // Tests that need jsdom say so with `@vitest-environment jsdom` at the top of the file.
  }
})
