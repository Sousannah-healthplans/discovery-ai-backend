/**
 * Script to reprocess existing OCR'd screenshots for claim extraction
 * Run with: node scripts/reprocess-claims.js
 */

import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { ScreenshotEvent } from '../src/services/eventStore.js'
import { extractClaimFromScreenshotEvent } from '../src/services/tagsEngine/claimExtractionService.js'

dotenv.config()

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo'

async function reprocessClaims() {
  try {
    console.log('Connecting to MongoDB...')
    await mongoose.connect(MONGO_URI, { dbName: 'claims_demo' })
    console.log('✅ Connected to MongoDB')

    // Find all screenshots that have OCR data but may not have claims extracted yet
    const screenshots = await ScreenshotEvent.find({
      ocrProcessed: true,
      ocrText: { $exists: true, $ne: '' }
    })
      .limit(1000) // Process up to 1000 at a time
      .lean()

    console.log(`Found ${screenshots.length} screenshots with OCR data to process for claims`)

    if (screenshots.length === 0) {
      console.log('✅ No screenshots found with OCR data')
      await mongoose.disconnect()
      return
    }

    let processed = 0
    let created = 0
    let updated = 0
    let skipped = 0
    let failed = 0

    for (const screenshot of screenshots) {
      try {
        const result = await extractClaimFromScreenshotEvent(screenshot._id)
        if (result) {
          // Check if it was newly created or updated by checking if it has firstSeenTs === lastSeenTs
          if (result.firstSeenTs && result.lastSeenTs && 
              result.firstSeenTs.getTime() === result.lastSeenTs.getTime() &&
              result.processingDurationSec === 0) {
            created++
          } else {
            updated++
          }
          processed++
        } else {
          skipped++
        }
      } catch (err) {
        console.error(`❌ Failed to process screenshot ${screenshot._id}:`, err.message)
        failed++
      }
    }

    console.log('\n📊 Summary:')
    console.log(`  ✅ Processed: ${processed}`)
    console.log(`  🆕 Created: ${created}`)
    console.log(`  🔄 Updated: ${updated}`)
    console.log(`  ⏭️  Skipped (no claim ID): ${skipped}`)
    console.log(`  ❌ Failed: ${failed}`)

    await mongoose.disconnect()
    console.log('\n✅ Done!')
  } catch (error) {
    console.error('❌ Error:', error)
    await mongoose.disconnect()
    process.exit(1)
  }
}

reprocessClaims()

