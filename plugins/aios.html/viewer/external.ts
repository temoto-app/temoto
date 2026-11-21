/**
 * Statically find external resources (script / stylesheet / images, etc.) that Preview does not load (TODO 1074, ARCHITECTURE 7.4.10).
 *
 * No I/O. The HTML string is read with DOMParser (the HTML structure is not read with regular expressions, so strings inside comments or attributes do not mislead it).
 * The targets are external resources blocked by Preview's CSP (`default-src 'none'; img-src data:`):
 * `<script src>` / `<link rel=stylesheet>` / `<img>` / `<iframe>` / `<video>` / `<audio>` / `<source>` / `<embed>` / `<object>` /
 * `@import` and `url(…)` inside `<style>` and `style=""` / static imports in the body of `<script type=module>`. It also descends into `<template>`.
 * Only references that are http(s) or protocol-relative (`//host/…`). Relative paths and `data:` are out of scope.
 * `main.ts` cannot be loaded from vitest, so only the decision is split out here.
 */

/** Whether a reference counts as external. Only `http:` / `https:` / `//…`. Surrounding whitespace is ignored (same as HTML URL attributes). */
export function isExternalUrl(value: string | null): boolean {
  if (value === null) return false
  return /^(?:https?:)?\/\//i.test(value.trim())
}

/** srcset is "URL descriptor, URL descriptor". Take out just the URLs and return true if even one is external. */
function srcsetHasExternal(value: string | null): boolean {
  if (value === null) return false
  return value.split(',').some((part) => isExternalUrl(part.trim().split(/\s+/)[0] ?? ''))
}

/** `@import "http…"` / `@import url(http…)` / `url(http…)` inside CSS. */
const CSS_EXTERNAL = /(?:@import\s*|url\(\s*)['"]?\s*(?:https?:)?\/\//i

/** The targets of a module script's static import / dynamic import / re-export. */
const MODULE_EXTERNAL = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]\s*(?:https?:)?\/\//i

const SRC_SELECTOR = 'script[src], img[src], iframe[src], video[src], audio[src], source[src], embed[src]'

function scan(root: ParentNode): boolean {
  for (const el of root.querySelectorAll(SRC_SELECTOR)) {
    if (isExternalUrl(el.getAttribute('src'))) return true
  }
  for (const el of root.querySelectorAll('object[data]')) {
    if (isExternalUrl(el.getAttribute('data'))) return true
  }
  for (const el of root.querySelectorAll('img[srcset], source[srcset]')) {
    if (srcsetHasExternal(el.getAttribute('srcset'))) return true
  }
  for (const el of root.querySelectorAll('video[poster]')) {
    if (isExternalUrl(el.getAttribute('poster'))) return true
  }
  for (const el of root.querySelectorAll('link[href]')) {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    if (rel.includes('stylesheet') && isExternalUrl(el.getAttribute('href'))) return true
  }
  for (const el of root.querySelectorAll('style')) {
    if (CSS_EXTERNAL.test(el.textContent ?? '')) return true
  }
  for (const el of root.querySelectorAll('[style]')) {
    if (CSS_EXTERNAL.test(el.getAttribute('style') ?? '')) return true
  }
  for (const el of root.querySelectorAll('script[type]')) {
    if ((el.getAttribute('type') ?? '').trim().toLowerCase() === 'module' && MODULE_EXTERNAL.test(el.textContent ?? '')) {
      return true
    }
  }
  // querySelectorAll does not descend into the contents of a <template> (a separate DocumentFragment).
  for (const tpl of root.querySelectorAll('template')) {
    if (scan((tpl as HTMLTemplateElement).content)) return true
  }
  return false
}

export function hasExternalReferences(source: string): boolean {
  return scan(new DOMParser().parseFromString(source, 'text/html'))
}
