/**
 * Keeps the IPC subscriptions that the store's `init()` sets up to one set (TODO 571).
 *
 * `main.tsx` renders with `<StrictMode>`, so in a development build `App`'s `useEffect` runs twice: mount -> unmount -> mount.
 * `init()` awaits IPC before subscribing, so the cleanup (= `dispose`) arrives **before** the first subscription
 * - just releasing in the cleanup leaves the first subscription behind. So a generation number is used to check "is that init still the latest":
 *
 * - Call `begin()` at the head of `init()` (before the await) and receive a number.
 * - Just before subscribing, `claim(token)`. False if a later `init()` or `dispose()` has come (do not subscribe).
 *   If true, the previous subscriptions are released before subscribing (only the second `init()` subscribes).
 * - `dispose()` advances the generation and releases all subscriptions in place (from the `useEffect` cleanup).
 */
export interface SubscriptionSlot {
  begin(): number
  claim(token: number): boolean
  /** TODO 1138: check only "is that init still the latest" without releasing (before a write after an await). */
  isCurrent(token: number): boolean
  /** Holds an unsubscribe function. A non-function value (a fake in old tests) is ignored. */
  add(unsubscribe: unknown): void
  dispose(): void
}

export function createSubscriptionSlot(): SubscriptionSlot {
  let generation = 0
  let current: Array<() => void> = []
  const teardown = (): void => {
    const list = current
    current = []
    for (const unsubscribe of list) {
      try {
        unsubscribe()
      } catch {
        // Even if one release fails, release the rest.
      }
    }
  }
  return {
    begin(): number {
      generation += 1
      return generation
    },
    claim(token: number): boolean {
      if (token !== generation) return false
      teardown()
      return true
    },
    isCurrent(token: number): boolean {
      return token === generation
    },
    add(unsubscribe: unknown): void {
      if (typeof unsubscribe === 'function') current.push(unsubscribe as () => void)
    },
    dispose(): void {
      generation += 1
      teardown()
    }
  }
}
