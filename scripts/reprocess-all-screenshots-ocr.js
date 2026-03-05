/**
 * Local reprocess: run OCR on ALL screenshots with image data, save to Mongo,
 * then extract claims (including Claim ID from URL). Results appear in the frontend.
 *
 * Run locally (no server needed). Uses MONGO_URI from .env or default.
 *
 * Usage (from discovery-ai-backend):
 *   npm run reprocess-local
 *
 * Or with env:
 *   set MONGO_URI=mongodb://127.0.0.1:27017/your_db
 *   set REPROCESS_LIMIT=500
 *   node scripts/reprocess-all-screenshots-ocr.js
 *
 * Optional env:
 *   MONGO_URI / DATABASE_URL   MongoDB connection (default: mongodb://127.0.0.1:27017/claims_demo)
 *   REPROCESS_LIMIT=500        max screenshots to process (default 2000)
 *   REPROCESS_OUTPUT=path      summary JSON path (default: ./reprocess-summary.json)
 */

import dotenv from 'dotenv'
import mongoose from 'mongoose'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ScreenshotEvent from '../src/models/events/ScreenshotEvent.js'
import OcrClaim from '../src/models/OcrClaim.js'
import { extractTextAndStructuredFromImage, extractTextAndStructuredFromImageUrl } from '../src/services/ocrService.js'
import { extractTags, extractPhrases } from '../src/utils/tagExtractor.js'
import { extractClaimFromScreenshotEvent } from '../src/services/tagsEngine/claimExtractionService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo'
const LIMIT = Math.min(Number(process.env.REPROCESS_LIMIT) || 2000, 10000)
const OUTPUT_FILE = process.env.REPROCESS_OUTPUT || path.join(__dirname, 'reprocess-summary.json')

async function run() {
  const startTime = Date.now()
  const summary = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    mongoUri: MONGO_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@'),
    limit: LIMIT,
    total: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    claimIds: []
  }

  const dbName = process.env.MONGO_DBNAME || 'claims_demo'
  console.log('Connecting to MongoDB...')
  await mongoose.connect(MONGO_URI, { dbName })
  console.log(`Connected (db: ${dbName}). Fetching screenshots with image data...`)

  // Clear existing claims for a fresh reprocess (avoids stale data from prior extractions)
  const existingClaims = await OcrClaim.countDocuments({})
  if (existingClaims > 0) {
    console.log(`  Clearing ${existingClaims} existing OcrClaim documents for clean reprocess...`)
    await OcrClaim.deleteMany({})
    console.log(`  Cleared.`)
  }

  const totalInCollection = await ScreenshotEvent.countDocuments({})
  console.log(`  Total documents in screenshot_events: ${totalInCollection}`)

  // Fetch docs with image data — no sort needed (order doesn't matter for reprocessing,
  // and sorting full documents with base64 image data exceeds MongoDB's 32MB sort limit on shared clusters)
  let screenshots = await ScreenshotEvent.find({
    $or: [
      { 'data.dataUrl': { $exists: true, $ne: null, $ne: '' } },
      { 'data.cloudinaryUrl': { $exists: true, $ne: null, $ne: '' } },
      { 'data.url': { $exists: true, $regex: /^data:image\//i } }
    ]
  })
    .limit(LIMIT)
    .lean()

  // If no docs match, try all screenshot events (extension may use different data shape)
  if (screenshots.length === 0 && totalInCollection > 0) {
    console.log(`  No docs with data.dataUrl/cloudinaryUrl/url; fetching all ${Math.min(LIMIT, totalInCollection)} events to try...`)
    screenshots = await ScreenshotEvent.find({})
      .limit(LIMIT)
      .lean()
  }

  summary.total = screenshots.length
  if (screenshots.length === 0) {
    console.log(`Found 0 screenshots to process.`)
    if (totalInCollection === 0) {
      console.log(`  Collection is empty. Use the same MONGO_URI as your running app (check .env).`)
    } else {
      console.log(`  Tip: Screenshots need image in event.data (dataUrl, cloudinaryUrl, or url as data:image/...).`)
    }
  } else {
    console.log(`Found ${screenshots.length} screenshots. Processing (OCR + structured HTML + claim extraction)...\n`)
  }

  for (let i = 0; i < screenshots.length; i++) {
    const screenshot = screenshots[i]
    const num = i + 1
    let imageBuffer = null

    try {
      const dataUrl = screenshot.data?.dataUrl ?? (typeof screenshot.data?.url === 'string' && screenshot.data.url.startsWith('data:image/') ? screenshot.data.url : null)
      const cloudinaryUrl = screenshot.data?.cloudinaryUrl

      if (dataUrl && typeof dataUrl === 'string' && dataUrl.includes(',')) {
        const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
        if (b64 && b64 !== dataUrl) imageBuffer = Buffer.from(b64, 'base64')
      }
      if (!imageBuffer && cloudinaryUrl) {
        const imgRes = await fetch(cloudinaryUrl)
        if (imgRes.ok) imageBuffer = Buffer.from(await imgRes.arrayBuffer())
      }

      if (!imageBuffer) {
        summary.skipped++
        continue
      }

      process.stdout.write(`  [${num}/${screenshots.length}] OCR + claim... `)
      const result = await extractTextAndStructuredFromImage(imageBuffer)
      if (!result || !result.text || result.text.trim().length < 10) {
        summary.skipped++
        console.log('no text')
        continue
      }

      const tags = extractTags(result.text)
      const phrases = extractPhrases(result.text)
      const allTags = [...new Set([...tags, ...phrases])]

      await ScreenshotEvent.findByIdAndUpdate(screenshot._id, {
        ocrText: result.text,
        ocrStructured: result.structured || undefined,
        ocrEngine: result.engine || 'tesseract',
        ocrTags: allTags,
        ocrProcessed: true
      })

      const claimResult = await extractClaimFromScreenshotEvent(screenshot._id)
      if (claimResult) {
        if (
          claimResult.firstSeenTs &&
          claimResult.lastSeenTs &&
          claimResult.firstSeenTs.getTime() === claimResult.lastSeenTs.getTime() &&
          claimResult.processingDurationSec === 0
        ) {
          summary.created++
        } else {
          summary.updated++
        }
        summary.processed++
        if (claimResult.claimId) summary.claimIds.push(claimResult.claimId)
        console.log(`claim ${claimResult.claimId || '(id)'} (${result.text.length} chars, zones: ${result.structured?.zones ? Object.keys(result.structured.zones).join(',') : 'n/a'})`)
      } else {
        summary.skipped++
        console.log(`no claim (${result.text.length} chars)`)
      }
    } catch (err) {
      summary.failed++
      summary.errors.push({ screenshotId: String(screenshot._id), message: err.message })
      console.log(`FAILED: ${err.message}`)
    }
  }

  summary.finishedAt = new Date().toISOString()
  summary.durationMs = Date.now() - startTime

  console.log('\n────────── Summary ──────────')
  console.log(`  Processed (with claim): ${summary.processed}`)
  console.log(`  Created:               ${summary.created}`)
  console.log(`  Updated:               ${summary.updated}`)
  console.log(`  Skipped:               ${summary.skipped}`)
  console.log(`  Failed:                ${summary.failed}`)
  console.log(`  Total screenshots:     ${summary.total}`)
  console.log(`  Duration:              ${(summary.durationMs / 1000).toFixed(1)}s`)
  console.log('─────────────────────────────')

  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2), 'utf8')
    console.log(`\nSummary written to: ${path.resolve(OUTPUT_FILE)}`)
  } catch (e) {
    console.warn('Could not write summary file:', e.message)
  }

  await mongoose.disconnect()
  console.log('Disconnected from MongoDB.')
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
