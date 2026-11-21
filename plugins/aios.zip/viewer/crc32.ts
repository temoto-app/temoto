/** CRC-32 (IEEE, same as zip). Shared by `zip.ts` and `zip-crypto.ts` (a leaf so they do not import each other). */

let crcTable: Uint32Array | null = null

function table(): Uint32Array {
  if (crcTable !== null) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  crcTable = t
  return t
}

/** The update for one byte (takes and returns the intermediate value `crc` before inversion). */
export function crc32Byte(crc: number, byte: number): number {
  return ((table()[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0
}

export function crc32(bytes: Uint8Array, previous = 0): number {
  const t = table()
  let c = (previous ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
