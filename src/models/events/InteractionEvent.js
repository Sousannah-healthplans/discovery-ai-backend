import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Interaction Events Collection
 * Stores: user interaction events (clicks, typing, form submissions, etc.)
 * Types: click, button_click, input, change, blur, form_submit, key_down, key_up, media_play, media_pause
 */
const interactionSchema = createEventSchema()

export default mongoose.model('InteractionEvent', interactionSchema, 'interaction_events')

