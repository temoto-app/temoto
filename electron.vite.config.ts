import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { tightenConnectSrc } from './src/common/renderer-csp.js'
import { readBuildStamp } from './src/common/build-stamp.js'
import { PRODUCT_NAME } from './src/shared/product.js'

const root = import.meta.dirname

/** Drops the woff / ttf alternatives of each KaTeX `@font-face` (TODO 1342). */
function stripNonWoff2(css: string): string {
  return css.replace(/,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g, '')
}

/**
 * The app version and build identity (TODO 316). Git is called once, when building (and when starting the dev
 * server), and the result is embedded in main as `__AIOS_BUILD__` (read by `src/main/build-info.ts`).
 * It does not fail when git is missing or the working tree is dirty (`unknown` / `dirty: true`).
 */
const buildStamp = readBuildStamp(root)

/**
 * The third-party notices in About (TODO 438). The source of truth is one place, `THIRD_PARTY_NOTICES.md`.
 * Its text is embedded here as a string in the renderer's `__AIOS_THIRD_PARTY_NOTICES_MD__`, and
 * `src/renderer/src/third-party-notices.ts` splits it by heading (`## `). main does not read it (no new IPC).
 */
const thirdPartyNoticesMd = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
    define: { __AIOS_BUILD__: JSON.stringify(buildStamp) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // aios-mcp-gateway (7.6). A separate process from main; the CLI starts it.
          // Its output goes to out/main/gateway.js so that main can point at it with a relative path.
          gateway: resolve(root, 'src/gateway/index.ts'),
          // plugin-host (7.8). The entry point of the utility process. **Plugin code is dynamically imported
          // here. main never imports a plugin** (constraint 8).
          'plugin-host': resolve(root, 'src/plugin-host/index.ts'),
          // index-host (P1, chapter 3). The entry point of the index process (`aios-index`).
          // **Code that touches `documents` / `chunks` / `chunk_fts` goes in here, and not a single
          // statement of it remains in out/main/index.js** (`test/index-bundle.test.ts`).
          'index-host': resolve(root, 'src/index-host/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
    build: {
      // A preload with sandbox: true is not loaded unless it is CommonJS.
      // package.json has "type": "module", so the file extension is .cjs.
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@renderer': resolve(root, 'src/renderer/src')
      }
    },
    plugins: [
      react(),
      {
        // TODO 1342: KaTeX's stylesheet lists each font three times (woff2 / woff / ttf). Chromium reads woff2, so only that one is kept
        // (20 files instead of 60 in the bundle).
        name: 'aios-katex-woff2-only',
        enforce: 'pre',
        transform(code: string, id: string) {
          if (!/katex[\\/]dist[\\/]katex\.min\.css$/.test(id.split('?')[0] ?? '')) return null
          return { code: stripNonWoff2(code), map: null }
        },
        // The conversation export (PDF / HTML) is a document of its own with `default-src 'none'`, and a `file:` page cannot `fetch` the font files,
        // so it gets the stylesheet with the fonts as `data:` URLs. A virtual module, imported lazily only when an answer has math.
        resolveId: (id: string) => (id === 'virtual:katex-export-css' ? '\0virtual:katex-export-css' : null),
        load(id: string) {
          if (id !== '\0virtual:katex-export-css') return null
          const dist = resolve(root, 'node_modules/katex/dist')
          const css = stripNonWoff2(readFileSync(resolve(dist, 'katex.min.css'), 'utf8')).replace(
            /url\((fonts\/[^)]+\.woff2)\)/g,
            (_m, file: string) => `url(data:font/woff2;base64,${readFileSync(resolve(dist, file)).toString('base64')})`
          )
          return `export default ${JSON.stringify(css)}`
        }
      },
      {
        // TODO 856: at build time only, restrict connect-src to 'self'. dev (serve) keeps it as it is, for HMR.
        name: 'aios-build-csp',
        apply: 'build',
        transformIndexHtml: (html: string) => tightenConnectSrc(html)
      },
      {
        // TODO 807: the app is a chunk of its own, imported by the boot entry once main is ready (3.1 "launch order"). A modulepreload
        // lets the renderer fetch and compile it (without running it) while main opens the DB, so the split does not delay the launch.
        name: 'aios-preload-app-chunk',
        apply: 'build',
        transformIndexHtml: {
          order: 'post',
          handler: (html: string, ctx: { bundle?: Record<string, { type: string; fileName: string; name?: string }> }) => {
            // The chunk of a dynamic import is named after its module (`app-main`); the bundle here does not carry its module id.
            const chunk = Object.values(ctx.bundle ?? {}).find((item) => item.type === 'chunk' && item.name === 'app-main')
            if (chunk === undefined) throw new Error('aios-preload-app-chunk: the app-main chunk is missing from the renderer bundle')
            return {
              html,
              tags: [{ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `./${chunk.fileName}` }, injectTo: 'head' }]
            }
          }
        }
      },
      {
        // TODO 1254: the product name in the window title (`<title>`) is filled in from `src/shared/product.json` (both dev and build).
        name: 'aios-product-name',
        // `pre`: fill it in before Vite's `%ENV%` replacement (which warns about names it does not know).
        transformIndexHtml: { order: 'pre', handler: (html: string) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME) }
      }
    ],
    define: { __AIOS_THIRD_PARTY_NOTICES_MD__: JSON.stringify(thirdPartyNoticesMd) },
    build: {
      // TODO 1342: the CSP's `font-src` falls back to `default-src 'self'`, so a small font must not become a `data:` URL.
      assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined),
      rollupOptions: { input: { index: resolve(root, 'src/renderer/index.html') } }
    }
  }
})
