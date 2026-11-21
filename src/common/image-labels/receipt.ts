/**
 * Telling receipts from documents (TODO 998 stage 2, findings of spike 39). **Pure functions only** (OS-independent).
 *
 * The classification label `receipt` is also put, at 0.32-0.56, on photographed A4 documents (genuine receipts overlap at 0.2-0.9).
 * A lower bound on the label's confidence cannot separate them, so it is paired with words in the OCR text (total, subtotal, tax included, TOTAL ...):
 *
 * - If 2 or more of the 5 cues match, it is a `receipt` (a total / tax / payment / heading / 3 or more amount lines).
 * - If fewer than 2 match and there is plenty of text (`DOCUMENT_MIN_CHARS` or more), it is a `document` - a document, not a photographed receipt.
 *   In that case the label `receipt` is dropped and replaced with the Japanese word for "document".
 * - Otherwise null (little text, or unreadable; the label is left as it is).
 *
 * When the word table changes, bump `IMAGE_OCR_VERSION` (`src/index-kernel/image.ts`) (so the stored verdicts are redone).
 * The OCR text itself is not stored (constraint 9); this only returns a verdict from the text.
 */

export type ImageDocKind = 'receipt' | 'document'

/** If there are at least this many characters and the receipt cues are insufficient, it is treated as a document (character count). */
export const DOCUMENT_MIN_CHARS = 120
/** If there are at least this many amount lines, the "amount" cue matches. */
export const AMOUNT_LINES_MIN = 3
/** A receipt if at least this many cues match. */
export const RECEIPT_MIN_SCORE = 2

const TOTAL = /合計|小計|総額|お会計|お買上|お買い上げ|ご請求|\b(?:sub\s?total|total|amount\s+due|balance\s+due)\b/i
const TAX = /税込|税抜|消費税|内税|外税|税率|軽減税率|\b(?:tax|vat|gst)\b/i
const PAYMENT = /お預り|お預かり|お釣り|おつり|釣銭|現金|クレジット|支払|\b(?:cash|change|visa|mastercard|credit)\b/i
const HEADER = /レシート|領収書|領収証|領収|伝票|レジ|\b(?:receipt|invoice)\b/i
/** Lines that look like amounts: with a yen sign, with the yen character after a number, numbers with digit separators, numbers with `*`. */
const AMOUNT = /[¥￥]\s?\d|\d[\d,]*\s?円|\d{1,3}(?:,\d{3})+(?:\s|$)|\*\s?\d/

/** Judges the kind from the OCR text. null if there is no text, or too little to decide. */
export function imageDocKind(ocrText: string): ImageDocKind | null {
  if (ocrText.trim() === '') return null
  let score = 0
  if (TOTAL.test(ocrText)) score += 1
  if (TAX.test(ocrText)) score += 1
  if (PAYMENT.test(ocrText)) score += 1
  if (HEADER.test(ocrText)) score += 1
  let amounts = 0
  for (const line of ocrText.split('\n')) {
    if (AMOUNT.test(line)) amounts += 1
    if (amounts >= AMOUNT_LINES_MIN) break
  }
  if (amounts >= AMOUNT_LINES_MIN) score += 1
  if (score >= RECEIPT_MIN_SCORE) return 'receipt'
  if (ocrText.length >= DOCUMENT_MIN_CHARS) return 'document'
  return null
}

export function sanitizeDocKind(value: unknown): ImageDocKind | null {
  return value === 'receipt' || value === 'document' ? value : null
}
