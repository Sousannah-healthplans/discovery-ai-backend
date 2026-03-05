/**
 * EventStore — unified service for inserting and querying events
 * across the organized category collections.
 *
 * ┌──────────────────────┐
 * │     EventStore        │   single API for all routes
 * ├──────────────────────┤
 * │  screenshot_events    │
 * │  interaction_events   │
 * │  navigation_events    │
 * │  tab_events           │
 * │  activity_events      │
 * │  system_events        │
 * └──────────────────────┘
 */

import {
  getModelForType,
  getCategoryForType,
  getAllModels,
  CATEGORY_MODELS,
  EVENT_CATEGORIES,
  ScreenshotEvent,
  InteractionEvent,
  NavigationEvent,
  TabEvent,
  ActivityEvent,
  SystemEvent
} from '../models/events/index.js'

// ── INSERT HELPERS ────────────────────────────────────────────────────

/**
 * Insert an array of event documents, routing each to its correct collection.
 * Returns a flat array of inserted docs (same order as input).
 *
 * @param {Object[]} docs – array of plain event objects (must include `type`)
 * @returns {Object[]} inserted Mongoose documents (ordered same as input)
 */
export async function insertEvents(docs) {
  if (!docs || docs.length === 0) return []

  // Group docs by category while preserving original index
  const buckets = {} // category → [{ doc, originalIndex }]
  docs.forEach((doc, idx) => {
    const category = getCategoryForType(doc.type)
    if (!buckets[category]) buckets[category] = []
    buckets[category].push({ doc, originalIndex: idx })
  })

  // Insert each bucket in parallel
  const insertPromises = Object.entries(buckets).map(async ([category, items]) => {
    const Model = CATEGORY_MODELS[category]
    const docsToInsert = items.map(i => i.doc)
    const inserted = await Model.insertMany(docsToInsert)
    // Zip back with original indexes
    return items.map((item, i) => ({
      originalIndex: item.originalIndex,
      doc: inserted[i]
    }))
  })

  const results = await Promise.all(insertPromises)

  // Flatten and re-sort to original order
  const flat = results.flat()
  flat.sort((a, b) => a.originalIndex - b.originalIndex)
  return flat.map(r => r.doc)
}

/**
 * Insert a single event document into the correct collection.
 */
export async function insertEvent(doc) {
  const Model = getModelForType(doc.type)
  return Model.create(doc)
}

// ── QUERY HELPERS ─────────────────────────────────────────────────────

/**
 * Find events across ALL collections matching a query.
 * Supports filtering by type, which will automatically target the right collection(s).
 *
 * @param {Object} query – Mongoose filter (may include `type`)
 * @param {Object} options
 * @param {string}  options.select  – fields to select
 * @param {Object}  options.sort    – sort specification (default: { ts: -1 })
 * @param {number}  options.limit   – max results (default: 200)
 * @param {boolean} options.lean    – use .lean() (default: true)
 * @returns {Object[]}
 */
export async function findEvents(query = {}, options = {}) {
  const { select, sort = { ts: -1 }, limit = 200, lean = true } = options

  // Determine which models to query
  const models = getTargetModels(query)

  // Query each model in parallel
  const promises = models.map(Model => {
    let q = Model.find(query)
    if (select) q = q.select(select)
    q = q.sort(sort).limit(limit).setOptions({ allowDiskUse: true })
    if (lean) q = q.lean()
    return q
  })

  const results = await Promise.all(promises)

  // Merge and re-sort
  let merged = results.flat()

  // Sort merged results
  const sortKey = Object.keys(sort)[0] || 'ts'
  const sortDir = sort[sortKey] === -1 ? -1 : 1
  merged.sort((a, b) => {
    const va = a[sortKey] ?? 0
    const vb = b[sortKey] ?? 0
    return sortDir * (va > vb ? 1 : va < vb ? -1 : 0)
  })

  // Apply global limit
  if (limit && merged.length > limit) {
    merged = merged.slice(0, limit)
  }

  return merged
}

/**
 * Count events across all (or targeted) collections.
 */
export async function countEvents(query = {}) {
  const models = getTargetModels(query)
  const counts = await Promise.all(models.map(M => M.countDocuments(query)))
  return counts.reduce((sum, c) => sum + c, 0)
}

/**
 * Get distinct values for a field across all (or targeted) collections.
 */
export async function distinctEvents(field, query = {}) {
  const models = getTargetModels(query)
  const results = await Promise.all(models.map(M => M.distinct(field, query)))
  return [...new Set(results.flat())]
}

/**
 * Run an aggregation pipeline across all (or targeted) collections and merge results.
 * NOTE: For complex aggregations (facets, grouping), use aggregateAll() which
 * returns raw per-collection results so the caller can merge as needed.
 */
export async function aggregateAll(pipeline, query = {}) {
  const models = getTargetModels(query)
  const promises = models.map(M => M.aggregate(pipeline).allowDiskUse(true))
  const results = await Promise.all(promises)
  return results // Array of arrays — one per collection
}

/**
 * Run an aggregation on ALL collections and merge into a single result set.
 * The pipeline should start with a $match stage; additional stages follow.
 */
export async function aggregateMerged(pipeline) {
  const models = getAllModels()
  const promises = models.map(M => M.aggregate(pipeline).allowDiskUse(true))
  const results = await Promise.all(promises)
  return results.flat()
}

// ── SINGLE-COLLECTION SHORTCUTS ───────────────────────────────────────

/**
 * Find events from a specific category collection only.
 */
export async function findByCategory(category, query = {}, options = {}) {
  const Model = CATEGORY_MODELS[category]
  if (!Model) throw new Error(`Unknown category: ${category}`)

  const { select, sort = { ts: -1 }, limit = 200, lean = true } = options
  let q = Model.find(query)
  if (select) q = q.select(select)
  q = q.sort(sort).limit(limit).setOptions({ allowDiskUse: true })
  if (lean) q = q.lean()
  return q
}

/**
 * Find one event by id — checks all collections.
 */
export async function findEventById(id) {
  const models = getAllModels()
  const promises = models.map(M => M.findById(id).lean())
  const results = await Promise.all(promises)
  return results.find(r => r !== null) || null
}

/**
 * Update an event by id — checks all collections.
 */
export async function findEventByIdAndUpdate(id, update, options = {}) {
  const models = getAllModels()
  for (const Model of models) {
    const result = await Model.findByIdAndUpdate(id, update, options)
    if (result) return result
  }
  return null
}

/**
 * Find one event matching query — checks targeted collections.
 * Supports sort to find latest/earliest across collections.
 */
export async function findOneEvent(query = {}, options = {}) {
  const { select, sort, lean = true } = options
  const models = getTargetModels(query)

  if (sort) {
    // When sorting, we need to check all models and pick the best match
    const promises = models.map(M => {
      let q = M.findOne(query)
      if (select) q = q.select(select)
      q = q.sort(sort)
      if (lean) q = q.lean()
      return q
    })
    const results = (await Promise.all(promises)).filter(Boolean)
    if (results.length === 0) return null
    
    // Pick the best result based on sort direction
    const sortKey = Object.keys(sort)[0]
    const sortDir = sort[sortKey]
    results.sort((a, b) => {
      const va = a[sortKey] ?? 0
      const vb = b[sortKey] ?? 0
      return sortDir === -1 ? (vb > va ? 1 : vb < va ? -1 : 0) : (va > vb ? 1 : va < vb ? -1 : 0)
    })
    return results[0]
  }

  // Without sort, just return first match from any collection
  for (const Model of models) {
    let q = Model.findOne(query)
    if (select) q = q.select(select)
    if (lean) q = q.lean()
    const result = await q
    if (result) return result
  }
  return null
}

// ── DIRECT MODEL ACCESS ───────────────────────────────────────────────

export {
  ScreenshotEvent,
  InteractionEvent,
  NavigationEvent,
  TabEvent,
  ActivityEvent,
  SystemEvent,
  getModelForType,
  getCategoryForType,
  getAllModels,
  CATEGORY_MODELS,
  EVENT_CATEGORIES
}

// ── INTERNAL HELPERS ──────────────────────────────────────────────────

/**
 * Determine which models to query based on the query filter.
 * If query.type is specified, we only need the relevant collection(s).
 * If query.type uses $in, we target all matching collections.
 */
function getTargetModels(query) {
  if (!query.type) return getAllModels()

  if (typeof query.type === 'string') {
    return [getModelForType(query.type)]
  }

  if (query.type?.$in && Array.isArray(query.type.$in)) {
    const categories = new Set(query.type.$in.map(t => getCategoryForType(t)))
    return [...categories].map(cat => CATEGORY_MODELS[cat])
  }

  // For complex type queries ($regex, etc.), query all collections
  return getAllModels()
}

