/**
 * The font of Gmail draft bodies (TODO 1229, path (a) of the owner decision 2026-11-14).
 *
 * `default` = give no instruction (Gmail's standard stays). `monospace` = tell the AI in the conversation, as an extra instruction, "when making a draft with the connector, wrap the HTML body in a
 * fixed-width element". aios does not build drafts (constraint 7: the CLI reads the connector as is), so
 * whether it works is up to the model, and another instruction in the conversation wins. One for the whole app.
 */
export const GMAIL_DRAFT_FONTS = ['default', 'monospace'] as const

export type GmailDraftFont = (typeof GMAIL_DRAFT_FONTS)[number]

export const DEFAULT_GMAIL_DRAFT_FONT: GmailDraftFont = 'default'

export function isGmailDraftFont(value: unknown): value is GmailDraftFont {
  return value === 'default' || value === 'monospace'
}
