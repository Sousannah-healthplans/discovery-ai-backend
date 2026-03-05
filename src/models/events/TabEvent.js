import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Tab Events Collection
 * Stores: browser tab lifecycle events
 * Types: tab_created, tab_updated, tab_activated, tab_deactivated, tab_removed
 */
const tabSchema = createEventSchema()

export default mongoose.model('TabEvent', tabSchema, 'tab_events')

