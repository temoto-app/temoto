/** Vite builds `./x.ts?worker&url` as a separate worker file in this plugin's output and gives its URL (TODO 1341 item 4). */
declare module '*?worker&url' {
  const url: string
  export default url
}
