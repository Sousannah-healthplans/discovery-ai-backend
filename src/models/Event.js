import mongoose from 'mongoose'

const eventSchema = new mongoose.Schema(
  {
    ts: { type: Number, index: true },
    sessionId: { type: String, index: true },
    pageId: { type: String },
    // Tracker-side stable user id (from IntelliTracker)
    userId: { type: String, index: true },
    projectId: { type: String, index: true },
    type: { type: String, index: true },
    data: { type: mongoose.Schema.Types.Mixed },
    // Server-side enrichment
    ip: { type: String, index: true },
    extensionUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExtensionUser', index: true },
    // OCR fields
    ocrText: { type: String, index: 'text' }, // Full text extracted from screenshot
    ocrTags: [{ type: String, index: true }], // Important keywords/tags extracted from OCR text
    ocrProcessed: { type: Boolean, default: false, index: true } // Flag to track if OCR has been processed
  },
  { timestamps: true }
)

// Compound indexes for common query patterns - CRITICAL for performance
eventSchema.index({ userId: 1, projectId: 1, ts: -1 }) // Main query pattern
eventSchema.index({ userId: 1, sessionId: 1, ts: -1 }) // Session queries
eventSchema.index({ userId: 1, type: 1, ts: -1 }) // Type filtering (screenshots, etc.)
eventSchema.index({ userId: 1, projectId: 1, type: 1 }) // Type counts per project

export default mongoose.model('Event', eventSchema)
