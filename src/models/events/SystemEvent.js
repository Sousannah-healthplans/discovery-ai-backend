import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * System Events Collection
 * Stores: session lifecycle and custom/unknown events
 * Types: session_start, event, unknown, and any unrecognized type
 */
const systemSchema = createEventSchema()

export default mongoose.model('SystemEvent', systemSchema, 'system_events')

