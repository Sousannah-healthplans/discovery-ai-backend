import mongoose from 'mongoose'

/**
 * Base schema fields shared by ALL event types.
 * Each category-specific model extends this with additional fields.
 */
export const baseEventFields = {
  ts: { type: Number, index: true },
  sessionId: { type: String, index: true },
  pageId: { type: String },
  userId: { type: String, index: true },
  projectId: { type: String, index: true },
  type: { type: String, index: true },
  data: { type: mongoose.Schema.Types.Mixed },
  ip: { type: String, index: true },
  extensionUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExtensionUser', index: true }
}

/**
 * Base indexes shared by all event collections.
 * Each model can add category-specific indexes on top of these.
 */
export function applyBaseIndexes(schema) {
  schema.index({ userId: 1, projectId: 1, ts: -1 }) // Main query pattern
  schema.index({ userId: 1, sessionId: 1, ts: -1 }) // Session queries
  schema.index({ userId: 1, projectId: 1, type: 1 }) // Type counts per project
}

/**
 * Create a base schema with shared fields + timestamps.
 * @param {Object} extraFields - Additional fields specific to this event category
 * @returns {mongoose.Schema}
 */
export function createEventSchema(extraFields = {}) {
  const schema = new mongoose.Schema(
    { ...baseEventFields, ...extraFields },
    { timestamps: true }
  )
  applyBaseIndexes(schema)
  return schema
}

