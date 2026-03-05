/**
 * Migration Script: Move events from the single `events` collection
 * into organized category collections.
 *
 * Collections created:
 *   screenshot_events   – Screenshots + OCR data
 *   interaction_events  – Clicks, inputs, form submissions
 *   navigation_events   – Page views, navigations
 *   tab_events          – Browser tab lifecycle
 *   activity_events     – Heartbeats, focus/blur, scroll
 *   system_events       – Session start, custom events, unknown types
 *
 * Run with:
 *   node scripts/migrate-events.js
 *
 * Options:
 *   --dry-run     Show what would be migrated without actually doing it
 *   --batch-size  Number of events to process at a time (default: 1000)
 *   --keep-old    Do NOT drop the old events collection after migration
 */

import dotenv from 'dotenv'
import mongoose from 'mongoose'
import Event from '../src/models/Event.js'
import {
  getCategoryForType,
  CATEGORY_MODELS,
  ScreenshotEvent,
  InteractionEvent,
  NavigationEvent,
  TabEvent,
  ActivityEvent,
  SystemEvent
} from '../src/models/events/index.js'

dotenv.config()

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo'
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1]) || 1000
const DRY_RUN = process.argv.includes('--dry-run')
const KEEP_OLD = process.argv.includes('--keep-old')

async function migrate() {
  try {
    console.log('╔══════════════════════════════════════════════════╗')
    console.log('║   Event Migration: events → organized collections ║')
    console.log('╚══════════════════════════════════════════════════╝')
    console.log()
    console.log(`  MongoDB URI: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@')}`)
    console.log(`  Batch size:  ${BATCH_SIZE}`)
    console.log(`  Dry run:     ${DRY_RUN}`)
    console.log(`  Keep old:    ${KEEP_OLD}`)
    console.log()

    // Connect to MongoDB
    console.log('Connecting to MongoDB...')
    await mongoose.connect(MONGO_URI, { dbName: 'claims_demo' })
    console.log('✅ Connected to MongoDB')
    console.log()

    // Count total events in old collection
    const totalEvents = await Event.countDocuments()
    console.log(`📊 Total events in old "events" collection: ${totalEvents}`)

    if (totalEvents === 0) {
      console.log('✅ No events to migrate. Collection is empty.')
      await mongoose.disconnect()
      return
    }

    // Count by type for preview
    const typeCounts = await Event.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])

    console.log()
    console.log('📋 Events by type:')
    const categoryBuckets = {}
    for (const tc of typeCounts) {
      const category = getCategoryForType(tc._id || 'unknown')
      if (!categoryBuckets[category]) categoryBuckets[category] = { types: [], total: 0 }
      categoryBuckets[category].types.push({ type: tc._id, count: tc.count })
      categoryBuckets[category].total += tc.count
    }

    for (const [category, data] of Object.entries(categoryBuckets)) {
      console.log(`  📁 ${category}_events (${data.total} events):`)
      for (const t of data.types) {
        console.log(`      └─ ${t.type || '(null)'}: ${t.count}`)
      }
    }
    console.log()

    if (DRY_RUN) {
      console.log('🏃 DRY RUN — no changes will be made.')
      await mongoose.disconnect()
      return
    }

    // Check if new collections already have data
    const existingCounts = {}
    for (const [cat, Model] of Object.entries(CATEGORY_MODELS)) {
      const count = await Model.countDocuments()
      if (count > 0) existingCounts[cat] = count
    }

    if (Object.keys(existingCounts).length > 0) {
      console.log('⚠️  Some target collections already have data:')
      for (const [cat, count] of Object.entries(existingCounts)) {
        console.log(`     ${cat}_events: ${count} documents`)
      }
      console.log('   Migration will ADD to these collections (no duplicates if re-run).')
      console.log()
    }

    // Process in batches
    let processed = 0
    let migrated = 0
    let skipped = 0
    let errors = 0

    console.log('🚀 Starting migration...')
    console.log()

    let lastId = null

    while (true) {
      // Fetch next batch using cursor-based pagination (more efficient than skip)
      const query = lastId ? { _id: { $gt: lastId } } : {}
      const batch = await Event.find(query)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .lean()

      if (batch.length === 0) break

      lastId = batch[batch.length - 1]._id

      // Group batch by category
      const buckets = {}
      for (const doc of batch) {
        const category = getCategoryForType(doc.type || 'unknown')
        if (!buckets[category]) buckets[category] = []
        
        // Prepare the document for the new collection
        const newDoc = { ...doc }
        delete newDoc.__v // Remove version key
        
        buckets[category].push(newDoc)
      }

      // Insert each bucket into its collection
      for (const [category, docs] of Object.entries(buckets)) {
        const Model = CATEGORY_MODELS[category]
        try {
          // Use ordered: false to continue on duplicate _id errors (for re-runs)
          await Model.insertMany(docs, { ordered: false })
          migrated += docs.length
        } catch (err) {
          if (err.code === 11000) {
            // Duplicate key — some docs were already migrated (re-run safety)
            const insertedCount = err.result?.nInserted || err.insertedDocs?.length || 0
            migrated += insertedCount
            skipped += docs.length - insertedCount
          } else {
            console.error(`  ❌ Error inserting into ${category}_events:`, err.message)
            errors += docs.length
          }
        }
      }

      processed += batch.length
      const pct = ((processed / totalEvents) * 100).toFixed(1)
      process.stdout.write(`\r  ⏳ Progress: ${processed}/${totalEvents} (${pct}%) — migrated: ${migrated}, skipped: ${skipped}, errors: ${errors}`)
    }

    console.log()
    console.log()
    console.log('═══════════════════════════════════════')
    console.log('✅ Migration complete!')
    console.log(`   Total processed: ${processed}`)
    console.log(`   Migrated:        ${migrated}`)
    console.log(`   Skipped (dupes): ${skipped}`)
    console.log(`   Errors:          ${errors}`)
    console.log()

    // Verify counts
    console.log('📊 Verification — new collection counts:')
    let totalNew = 0
    for (const [cat, Model] of Object.entries(CATEGORY_MODELS)) {
      const count = await Model.countDocuments()
      totalNew += count
      console.log(`   ${cat}_events: ${count}`)
    }
    console.log(`   TOTAL: ${totalNew}`)
    console.log()

    if (!KEEP_OLD && totalNew >= totalEvents) {
      console.log('🗑️  All events migrated successfully. The old "events" collection is preserved.')
      console.log('   You can manually drop it with: db.events.drop()')
      console.log('   Or re-run with --keep-old to explicitly keep it.')
    } else if (KEEP_OLD) {
      console.log('📦 Keeping old "events" collection as requested (--keep-old).')
    } else {
      console.log('⚠️  Not all events were migrated. Old "events" collection is preserved.')
    }

    await mongoose.disconnect()
    console.log()
    console.log('Disconnected from MongoDB. Done!')

  } catch (error) {
    console.error()
    console.error('❌ Fatal error:', error)
    process.exit(1)
  }
}

migrate()

