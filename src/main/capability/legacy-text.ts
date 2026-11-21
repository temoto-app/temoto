/**
 * Reads non-UTF-8 text as an old Japanese encoding (EUC-JP / Shift_JIS) (TODO 1215).
 *
 * **For display only**: used by the Broker's `fs.read` (`encoding: 'utf8'`, after the binary check) only for text that is invalid as UTF-8.
 * The read-only rule (`invalidUtf8` of TODO 851) is unchanged, so write-back round trips are not affected. It applies to the text of every plugin's
 * `fs.read`, so if the result is not plausible it returns null and the caller replaces with U+FFFD as before
 * (being able to tell "this was not read" is better than plausible wrong characters).
 *
 * How the choice is made (code-review, wave 83):
 * 1. Try to read as both encodings without errors (`fatal`).
 * 2. EUC-JP is not taken if the decoded text has not a single kana (hiragana or full-width katakana): Japanese text normally contains some.
 *    Text that is half-width-kana-only Shift_JIS, GBK, or EUC-KR passes as EUC-JP without errors and becomes a run of kanji with no kana.
 * 3. If both read, the one with the larger kana share (kana / non-ASCII characters). If equal, Shift_JIS: CSV written by Excel in Japan
 *    is almost always Shift_JIS, and with nothing decisive it is the likelier hit.
 *
 * Remaining limits:
 * - EUC-JP text with no kana (kanji only) is not read (stays U+FFFD). EUC-JP is rare now, and avoiding turning GBK / EUC-KR into kanji
 *   nonsense was preferred.
 * - If GBK / EUC-KR / Latin-1 text happens to pass as Shift_JIS without errors, nonsense mixing half-width kana and kanji comes out
 *   (for example, Latin-1 `Français` becomes `Fran` followed by a kanji and then `is`). To read kanji-only Shift_JIS text (CSVs of names and addresses),
 *   no kana condition is imposed on the Shift_JIS side.
 * - When both readings pass with nothing decisive it falls back to Shift_JIS, so rare EUC-JP text (kana share not above the Shift_JIS side's) is misread.
 */

const C1_CONTROL = /[\u0080-\u009f]/
/** Hiragana and full-width katakana (including the long-vowel mark and the middle dot). */
const KANA = /[ぁ-ゟ゠-ヿ]/gu
const NON_ASCII = /[^\p{ASCII}]/gu

type Label = 'euc-jp' | 'shift_jis'

/**
 * Text if it reads without errors as `label`, otherwise null. If `truncated`, a character cut off at the end (up to 2 bytes, in the middle of EUC-JP's
 * 3-byte character) is dropped (the same leaning as `isValidUtf8`. `decode`'s `stream` is not used, because ICU's implementation sometimes
 * returned empty without reporting an error). null if this runtime does not know the encoding (Node without ICU).
 */
function tryDecode(label: Label, buffer: Uint8Array, truncated: boolean): string | null {
  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(label, { fatal: true })
  } catch {
    return null // This runtime does not know the encoding
  }
  const maxCut = truncated ? Math.min(2, buffer.byteLength - 1) : 0
  for (let cut = 0; cut <= maxCut; cut += 1) {
    let text: string
    try {
      text = decoder.decode(buffer.subarray(0, buffer.byteLength - cut))
    } catch {
      continue // Invalid byte sequence: try again with one byte shaved off the end.
    }
    // ICU's EUC-JP turns a lone byte 0x80 to 0x9F into a C1 control character (U+0080 to U+009F) instead of an error, and Shift_JIS also maps 0x80 to
    // U+0080 (confirmed with ICU 76 in Node 22). Text has no C1 control characters, so if one appears it is treated as unreadable.
    if (!C1_CONTROL.test(text)) return text
  }
  return null
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

/** Kana share (kana / non-ASCII characters). 0 if there is no non-ASCII. */
function kanaShare(text: string): number {
  const nonAscii = count(text, NON_ASCII)
  return nonAscii === 0 ? 0 : count(text, KANA) / nonAscii
}

/**
 * Reads a byte sequence that is invalid as UTF-8 as an old Japanese encoding. null if it does not read plausibly
 * (for how it chooses and the limits, see the top of the file).
 */
export function decodeLegacyJapanese(buffer: Uint8Array, truncated: boolean): string | null {
  const sjis = tryDecode('shift_jis', buffer, truncated)
  const eucRaw = tryDecode('euc-jp', buffer, truncated)
  const euc = eucRaw !== null && count(eucRaw, KANA) > 0 ? eucRaw : null
  if (euc === null) return sjis
  if (sjis === null) return euc
  return kanaShare(euc) > kanaShare(sjis) ? euc : sjis
}
