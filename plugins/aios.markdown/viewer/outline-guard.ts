/**
 * Generation management for `render()` (item 142).
 *
 * The heading list of `aios.markdown` (`showOutline()`) involves a round trip to the plugin-host
 * (`runCommand('outline', …)`, rereading the file through the Broker). If another `resource` event (a theme switch or a reread) arrives in between
 * and `render()` runs again, the result of the old generation's `showOutline()` resolves **later** and
 * appends one more `div.outline` to the DOM the new generation already built.
 *
 * Call `next()` at the start of `render()` and pass the returned number to `showOutline()`.
 * When an asynchronous result arrives, check `isCurrent(number)` and do nothing if it is stale.
 *
 * It does not use `@pluginshared` (relative imports only) — vitest has no alias for `@pluginshared`,
 * so this part is split out so tests can load it (the lesson of item 104).
 */
export class OutlineGuard {
  private gen = 0

  /** Report that a new `render()` has started, and return its generation number. */
  next(): number {
    this.gen += 1
    return this.gen
  }

  /** Whether that generation is still the latest `render()`. If stale, the result may be discarded. */
  isCurrent(gen: number): boolean {
    return gen === this.gen
  }
}
