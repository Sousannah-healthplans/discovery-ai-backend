/**
 * Organized Event Models
 * 
 * Events are split into 6 separate MongoDB collections for better organization:
 * 
 *   screenshot_events   – Screenshot captures + OCR data
 *   interaction_events  – Clicks, inputs, form submissions, keypresses
 *   navigation_events   – Page views, URL navigations, performance
 *   tab_events          – Browser tab lifecycle (create, activate, close)
 *   activity_events     – Heartbeats, focus/blur, scroll, idle detection
 *   system_events       – Session start, custom events, unknown types
 */

import ScreenshotEvent from './ScreenshotEvent.js'
import InteractionEvent from './InteractionEvent.js'
import NavigationEvent from './NavigationEvent.js'
import TabEvent from './TabEvent.js'
import ActivityEvent from './ActivityEvent.js'
import SystemEvent from './SystemEvent.js'

// ── Category → types mapping ──────────────────────────────────────────
export const EVENT_CATEGORIES = {
  screenshot: ['screenshot'],
  interaction: ['click', 'button_click', 'input', 'change', 'blur', 'form_submit', 'key_down', 'key_up', 'media_play', 'media_pause', 'input_polled', 'field_focus', 'field_blur', 'clipboard_paste', 'clipboard_copy', 'context_menu', 'dblclick', 'form_snapshot'],
  navigation: ['page_view', 'navigation', 'performance_navigation', 'page_load', 'page_event', 'route_change', 'pageview'],
  tab: ['tab_created', 'tab_updated', 'tab_activated', 'tab_deactivated', 'tab_removed'],
  activity: ['heartbeat', 'page_heartbeat', 'window_blur', 'window_focus', 'inactive_start', 'inactive_end', 'visibility_change', 'scroll'],
  system: ['session_start', 'session_end', 'session_pause', 'session_resume', 'event', 'unknown']
}

// ── Category → Model mapping ──────────────────────────────────────────
export const CATEGORY_MODELS = {
  screenshot: ScreenshotEvent,
  interaction: InteractionEvent,
  navigation: NavigationEvent,
  tab: TabEvent,
  activity: ActivityEvent,
  system: SystemEvent
}

// Build a reverse lookup: type → category
const _typeToCategory = {}
for (const [category, types] of Object.entries(EVENT_CATEGORIES)) {
  for (const t of types) {
    _typeToCategory[t] = category
  }
}

/**
 * Get the category name for a given event type.
 * Falls back to 'system' for any unrecognized type.
 */
export function getCategoryForType(type) {
  return _typeToCategory[type] || 'system'
}

/**
 * Get the Mongoose model for a given event type.
 */
export function getModelForType(type) {
  const category = getCategoryForType(type)
  return CATEGORY_MODELS[category]
}

/**
 * Get all category models as an array (useful for cross-collection queries).
 */
export function getAllModels() {
  return Object.values(CATEGORY_MODELS)
}

export {
  ScreenshotEvent,
  InteractionEvent,
  NavigationEvent,
  TabEvent,
  ActivityEvent,
  SystemEvent
}

