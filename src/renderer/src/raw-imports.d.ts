/** Vite's `?raw` (read a file's contents as a string). The conversation PDF (TODO 818) uses it to include `styles.css`. */
declare module '*.css?raw' {
  const content: string
  export default content
}
