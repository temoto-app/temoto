/** Vite's `?raw` (read a file's contents as a string). The conversation PDF (TODO 818) uses it to include `styles.css`. */
declare module '*.css?raw' {
  const content: string
  export default content
}

/** KaTeX's stylesheet with its fonts inlined as `data:` URLs, built by the `aios-katex-woff2-only` plugin in `electron.vite.config.ts` (TODO 1342). */
declare module 'virtual:katex-export-css' {
  const content: string
  export default content
}
