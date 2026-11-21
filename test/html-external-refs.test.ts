// @vitest-environment jsdom
/** Static detection of external scripts and stylesheets that the Preview of aios.html does not run (TODO 1074). */
import { describe, expect, it } from 'vitest'
import { hasExternalReferences, isExternalUrl } from '../plugins/aios.html/viewer/external.js'
import { isOpenDefaultAllowed } from '../src/shared/open-default.js'

describe('hasExternalReferences', () => {
  it('外部 script (https / http)', () => {
    expect(hasExternalReferences('<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>')).toBe(true)
    expect(hasExternalReferences('<html><head><script async src="http://a.example/x.js"></script></head></html>')).toBe(true)
  })
  it('外部 stylesheet', () => {
    expect(hasExternalReferences('<link rel="stylesheet" href="https://a.example/x.css">')).toBe(true)
    expect(hasExternalReferences('<link rel="preload stylesheet" href="https://a.example/x.css">')).toBe(true)
  })
  it('// 始まり (プロトコル相対)', () => {
    expect(hasExternalReferences('<script src="//cdn.example/x.js"></script>')).toBe(true)
    expect(hasExternalReferences('<link rel="stylesheet" href="//cdn.example/x.css">')).toBe(true)
  })
  it('相対パス・インライン・data: は対象外', () => {
    expect(hasExternalReferences('<script src="./app.js"></script><script src="/abs.js"></script>')).toBe(false)
    expect(hasExternalReferences('<link rel="stylesheet" href="style.css">')).toBe(false)
    expect(hasExternalReferences('<script>var u = "https://a.example/x.js"</script>')).toBe(false)
    expect(hasExternalReferences('<script src="data:text/javascript,1"></script>')).toBe(false)
  })
  it('stylesheet 以外の link・リンク・コメントの中は対象外', () => {
    expect(hasExternalReferences('<link rel="icon" href="https://a.example/f.ico">')).toBe(false)
    expect(hasExternalReferences('<a href="https://a.example/">x</a>')).toBe(false)
    expect(hasExternalReferences('<!-- <script src="https://a.example/x.js"></script> -->')).toBe(false)
  })
  it('画像だけ・iframe・video・srcset (CSP が止める資源)', () => {
    expect(hasExternalReferences('<img src="https://a.example/i.png">')).toBe(true)
    expect(hasExternalReferences('<img srcset="a.png 1x, //a.example/b.png 2x">')).toBe(true)
    expect(hasExternalReferences('<iframe src="https://a.example/"></iframe>')).toBe(true)
    expect(hasExternalReferences('<video poster="https://a.example/p.jpg"></video>')).toBe(true)
    expect(hasExternalReferences('<audio><source src="http://a.example/a.mp3"></audio>')).toBe(true)
    expect(hasExternalReferences('<img src="data:image/png;base64,AAAA"><img src="a.png">')).toBe(false)
  })
  it('<style> の @import / url() と style 属性', () => {
    expect(hasExternalReferences('<style>@import url(https://a.example/x.css);</style>')).toBe(true)
    expect(hasExternalReferences('<style>@import "https://a.example/x.css";</style>')).toBe(true)
    expect(hasExternalReferences('<style>@font-face{src:url("//a.example/f.woff2")}</style>')).toBe(true)
    expect(hasExternalReferences('<div style="background:url(https://a.example/b.png)"></div>')).toBe(true)
    expect(hasExternalReferences('<style>a{color:red}@import url(local.css);</style>')).toBe(false)
  })
  it('<template> の中の link / module script の静的 import', () => {
    expect(hasExternalReferences('<template><link rel="stylesheet" href="https://a.example/x.css"></template>')).toBe(true)
    expect(hasExternalReferences('<script type="module">import x from "https://a.example/m.js"</script>')).toBe(true)
    expect(hasExternalReferences('<script type="module">import("https://a.example/m.js")</script>')).toBe(true)
    expect(hasExternalReferences('<script type="module">import x from "./m.js"</script>')).toBe(false)
  })
  it('空・外部参照なし', () => {
    expect(hasExternalReferences('')).toBe(false)
    expect(hasExternalReferences('<p>hello</p>')).toBe(false)
  })
  it('isExternalUrl: 前後の空白と大文字', () => {
    expect(isExternalUrl('  HTTPS://a.example/x.js ')).toBe(true)
    expect(isExternalUrl(null)).toBe(false)
  })
})

describe('open-default の表 (TODO 1074)', () => {
  it('aios.html は html / htm だけ、他の plugin の拡張子では頼めない', () => {
    expect(isOpenDefaultAllowed('aios.html', 'file:///a/b.html')).toBe(true)
    expect(isOpenDefaultAllowed('aios.html', 'file:///a/b.HTM')).toBe(true)
    expect(isOpenDefaultAllowed('aios.html', 'file:///a/b.mp4')).toBe(false)
    expect(isOpenDefaultAllowed('aios.video', 'file:///a/b.html')).toBe(false)
  })
})
