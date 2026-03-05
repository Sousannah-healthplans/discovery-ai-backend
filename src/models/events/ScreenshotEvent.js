import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Screenshot Events Collection
 * Stores: screenshot captures with OCR data
 * Types: screenshot
 */
const screenshotSchema = createEventSchema({
  /** Why this screenshot was captured: click, input, key_down, periodic_15s, window_focused, page_complete, etc. */
  captureReason: { type: String, index: true },
  /** Cloudinary image URL — the actual screenshot image viewable in the browser */
  url: { type: String },
  // OCR fields specific to screenshots
  ocrText: { type: String, index: 'text' },
  /** Structured OCR: { blocks, lines, zones: { HEADER, SIDEBAR, BODY, FOOTER }, htmlStructure } — saved here; used for zone-aware claim extraction */
  ocrStructured: { type: mongoose.Schema.Types.Mixed },
  /** Engine that produced ocrText/ocrStructured: 'tesseract' */
  ocrEngine: { type: String, index: true },
  ocrTags: [{ type: String, index: true }],
  ocrProcessed: { type: Boolean, default: false, index: true },
  /** Claim ID extracted from this screenshot (for export: one row per screenshot, same claim can repeat) */
  extractedClaimId: { type: String, index: true }
})

// Screenshot-specific indexes
screenshotSchema.index({ ocrProcessed: 1, type: 1 }) // For OCR reprocessing queries
screenshotSchema.index({ userId: 1, sessionId: 1, ocrProcessed: 1 }) // OCR status per session

export default mongoose.model('ScreenshotEvent', screenshotSchema, 'screenshot_events')

