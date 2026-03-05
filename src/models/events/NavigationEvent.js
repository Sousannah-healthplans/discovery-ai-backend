import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Navigation Events Collection
 * Stores: page views, URL changes, navigation performance
 * Types: page_view, navigation, performance_navigation, page_load, page_event, route_change, pageview
 */
const navigationSchema = createEventSchema()

export default mongoose.model('NavigationEvent', navigationSchema, 'navigation_events')

