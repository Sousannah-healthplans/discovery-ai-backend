/**
 * Script to reprocess OCR for existing screenshots that don't have OCR data
 * Run with: node scripts/reprocess-ocr.js
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Event from '../src/models/Event.js';
import ScreenshotEvent from '../src/models/events/ScreenshotEvent.js';
import { extractTextAndStructuredFromImage, extractTextAndStructuredFromImageUrl } from '../src/services/ocrService.js';
import { extractTags, extractPhrases } from '../src/utils/tagExtractor.js';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo';

async function reprocessOCR() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, { dbName: 'claims_demo' });
    console.log('✅ Connected to MongoDB');

    // Find screenshots without OCR data from the organized screenshot_events collection
    const screenshots = await ScreenshotEvent.find({
      $or: [
        { ocrProcessed: { $ne: true } },
        { ocrText: { $exists: false } },
        { ocrTags: { $exists: false } }
      ]
    }).limit(100); // Process 100 at a time

    console.log(`Found ${screenshots.length} screenshots to process`);

    if (screenshots.length === 0) {
      console.log('✅ All screenshots already have OCR data');
      await mongoose.disconnect();
      return;
    }

    let processed = 0;
    let failed = 0;

    for (const screenshot of screenshots) {
      try {
        const imageUrl = screenshot.data?.cloudinaryUrl || screenshot.data?.dataUrl;
        
        if (!imageUrl) {
          console.log(`⚠️  Skipping screenshot ${screenshot._id}: No image URL`);
          // Mark as processed even without URL to avoid retrying
          await ScreenshotEvent.findByIdAndUpdate(screenshot._id, { ocrProcessed: true });
          continue;
        }

        console.log(`Processing screenshot ${screenshot._id}...`);
        
        // Extract text and structured layout
        let ocrText = '';
        let ocrStructured = null;
        try {
          if (imageUrl.startsWith('data:')) {
            const base64 = imageUrl.split(',')[1];
            const buffer = Buffer.from(base64, 'base64');
            const result = await extractTextAndStructuredFromImage(buffer);
            ocrText = result.text;
            ocrStructured = result.structured;
          } else {
            const result = await extractTextAndStructuredFromImageUrl(imageUrl);
            ocrText = result.text;
            ocrStructured = result.structured;
          }
        } catch (ocrError) {
          console.error(`  ❌ OCR extraction failed:`, ocrError.message);
          await ScreenshotEvent.findByIdAndUpdate(screenshot._id, {
            ocrProcessed: true,
            ocrText: '',
            ocrStructured: null,
            ocrTags: []
          });
          failed++;
          continue;
        }

        if (!ocrText || ocrText.trim().length === 0) {
          console.log(`  ℹ️  No text extracted`);
          await ScreenshotEvent.findByIdAndUpdate(screenshot._id, {
            ocrProcessed: true,
            ocrText: '',
            ocrStructured: null,
            ocrTags: []
          });
          processed++;
          continue;
        }

        const tags = extractTags(ocrText);
        const phrases = extractPhrases(ocrText);
        const allTags = [...new Set([...tags, ...phrases])];

        await ScreenshotEvent.findByIdAndUpdate(screenshot._id, {
          ocrText,
          ocrStructured: ocrStructured || undefined,
          ocrTags: allTags,
          ocrProcessed: true
        });

        const lineCount = ocrStructured?.lines?.length ?? 0;
        console.log(`  ✅ Processed: ${ocrText.length} chars, ${lineCount} lines, ${allTags.length} tags`);
        if (allTags.length > 0) {
          console.log(`     Tags: ${allTags.slice(0, 5).join(', ')}${allTags.length > 5 ? '...' : ''}`);
        }
        processed++;

      } catch (error) {
        console.error(`  ❌ Error processing screenshot ${screenshot._id}:`, error.message);
        // Mark as processed to avoid infinite retries
        await ScreenshotEvent.findByIdAndUpdate(screenshot._id, { ocrProcessed: true }).catch(() => {});
        failed++;
      }
    }

    console.log(`\n✅ Processing complete:`);
    console.log(`   Processed: ${processed}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Total: ${screenshots.length}`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

reprocessOCR();

