import type { AiosApi } from '@shared/ipc.js'

declare global {
  interface Window {
    /** The only entry point that the preload's contextBridge exposes. */
    readonly aios: AiosApi
  }
}

export {}
