import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Activity Events Collection
 * Stores: user presence / activity signals
 * Types: heartbeat, page_heartbeat, window_blur, window_focus, inactive_start, inactive_end,
 *        visibility_change, scroll
 */
const activitySchema = createEventSchema()

export default mongoose.model('ActivityEvent', activitySchema, 'activity_events')

