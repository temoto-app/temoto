/**
 * OS layer (TODO 986 stage 2): the IPC endpoint between main and the gateway (the entry point for approval and search, constraint 7).
 *
 * On macOS it is a Unix socket (`<runtimeDir>/gw.sock`, readable and writable only by the owner). The Windows version (TODO 899) will switch to a named pipe
 * (`\\\\.\\pipe\\…`) - building the endpoint path and narrowing its permissions are known only here.
 */
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

const SOCKET_FILE = 'gw.sock'

/** The path of the gateway's endpoint under `runtimeDir`. */
export function gatewayEndpointPath(runtimeDir: string): string {
  return join(runtimeDir, SOCKET_FILE)
}

/** Narrows the endpoint that was listened on to the owner only (7.6). */
export function restrictEndpointToOwner(endpoint: string): void {
  chmodSync(endpoint, 0o600)
}
