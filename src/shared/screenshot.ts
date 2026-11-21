/**
 * The image limit of `getViewerScreenshot` (TODO 1061, ARCHITECTURE 7.6.2). main (`encodeScreenshot`) and the gateway
 * (`screenshotResponse`) look at **the same single value** (so the gateway never drops what main let through, 58-8).
 */

/** Byte limit of one image (before converting to base64). PNG is kept within this, JPEG within `MAX_SCREENSHOT_JPEG_BYTES`, which is at most this. */
export const MAX_SCREENSHOT_IMAGE_BYTES = 1024 * 1024

/** The number of characters when the bytes above are made base64 (4 characters = 3 bytes, rounded up). The gateway drops images over this. */
export const MAX_SCREENSHOT_BASE64_CHARS = Math.ceil(MAX_SCREENSHOT_IMAGE_BYTES / 3) * 4
