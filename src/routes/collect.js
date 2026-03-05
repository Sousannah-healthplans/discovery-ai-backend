import { Router } from 'express'
import Event from '../models/Event.js'
import ExtensionUser from '../models/ExtensionUser.js'
import RemoteCommand from '../models/RemoteCommand.js'
import { v2 as cloudinary } from 'cloudinary'
import { extractTextAndStructuredFromImage, extractTextAndStructuredFromImageUrl } from '../services/ocrService.js'
import { extractTags, extractPhrases } from '../utils/tagExtractor.js'
import { insertEvents, ScreenshotEvent } from '../services/eventStore.js'
import { extractClaimFromScreenshotEvent } from '../services/tagsEngine/claimExtractionService.js'

const router = Router()

// Configure Cloudinary
// Note: You need to set CLOUDINARY_CLOUD_NAME in your .env file
// Get it from your Cloudinary dashboard: https://cloudinary.com/console
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY || '641859996985859',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'IqpjHL0B7vnXy0gdfG5R07NVGBs'
})

const cloudNameEnv = (process.env.CLOUDINARY_CLOUD_NAME || '').trim()
if (!cloudNameEnv || cloudNameEnv.length < 3 || /IntelliTracker|your_cloud|placeholder/i.test(cloudNameEnv)) {
  console.warn('⚠️  [Cloudinary] Screenshot uploads disabled: set CLOUDINARY_CLOUD_NAME to your cloud name from https://cloudinary.com/console (screenshots will use dataUrl only).')
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string') return xf.split(',')[0].trim()
  return req.ip || req.connection?.remoteAddress || ''
}

router.post('/', async (req, res) => {
  try {
    // Simple API key guard so only the browser extension can send data
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      console.log('Invalid API key:', { received: apiKeyHeader?.substring(0, 10), expected: expected?.substring(0, 10) })
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const batch = Array.isArray(req.body) ? req.body : [req.body]
    const toInsert = []
    const ocrProcessingQueue = [] // Store OCR processing tasks separately
    const ip = clientIp(req)

    console.log(`Received batch of ${batch.length} events from IP: ${ip}`)

    // Preload any extension user linked to this tracker user id
    let extUser = null
    const sample = batch[0]
    if (sample && sample.userId) {
      extUser = await ExtensionUser.findOne({ trackerUserId: sample.userId }).select('_id trackerUserId')
      if (extUser) {
        console.log(`Found extension user for trackerUserId: ${sample.userId}`)
      } else {
        console.log(`No extension user found for trackerUserId: ${sample.userId}`)
      }
    }

    for (const item of batch) {
      const ev = item.event || {}

      // If this is a screenshot, upload to Cloudinary (when configured) and prepare for OCR
      if (ev.type === 'screenshot' && ev.data && ev.data.dataUrl) {
        let imageBuffer = null; // Store buffer for OCR processing
        const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim()
        // Cloudinary cloud names are from dashboard (e.g. "dxyz123"); skip upload if missing or placeholder
        const skipCloudinary = !cloudName || cloudName.length < 3 || /IntelliTracker|your_cloud|placeholder/i.test(cloudName)

        try {
          const dataUrl = ev.data.dataUrl
          if (!skipCloudinary) {
            console.log(`[Cloudinary] Processing screenshot from extension (dataUrl length: ${dataUrl.length})`)
          }

          // Extract base64 data (handle different data URL formats)
          const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
          if (!b64 || b64 === dataUrl) {
            if (!skipCloudinary) console.warn('[Cloudinary] Invalid screenshot dataUrl format, skipping upload')
          } else {
            imageBuffer = Buffer.from(b64, 'base64')
            if (skipCloudinary) {
              // Keep dataUrl for frontend; OCR will use imageBuffer
              ev.data = { ...ev.data, fileSizeKB: Math.round(imageBuffer.length / 1024) }
            } else {
              console.log(`[Cloudinary] Uploading screenshot to Cloudinary (${Math.round(imageBuffer.length / 1024)}KB)...`)
            }

            if (!skipCloudinary) {
            // Upload to Cloudinary using upload_stream for better performance
            // Use invalidate: false to prevent auto-cleanup and ensure permanent storage
            const uploadResult = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                {
                  folder: 'discovery-ai/screenshots',
                  resource_type: 'image',
                  overwrite: false,
                  format: 'jpg',
                  quality: 'auto',
                  fetch_format: 'auto',
                  invalidate: false, // Prevent auto-cleanup
                  use_filename: false, // Use Cloudinary's generated IDs for better reliability
                  unique_filename: true, // Ensure unique filenames
                },
                (error, result) => {
                  if (error) {
                    console.error('Cloudinary upload error:', error)
                    reject(error)
                  } else {
                    resolve(result)
                  }
                }
              )
              uploadStream.end(imageBuffer)
            })

            const fileSizeKB = Math.round(imageBuffer.length / 1024);
            console.log(`[Cloudinary] ✅ Screenshot uploaded successfully!`)
            console.log(`[Cloudinary]   Public ID: ${uploadResult.public_id}`)
            console.log(`[Cloudinary]   URL: ${uploadResult.secure_url}`)
            console.log(`[Cloudinary]   Size: ${fileSizeKB}KB`)

            // Store Cloudinary URL and public_id (keep public_id for URL regeneration if needed)
            // Note: We remove dataUrl to save database space, but keep public_id to regenerate URLs if they break
            ev.data = {
              ...ev.data,
              dataUrl: undefined, // Remove base64 data to save database space
              cloudinaryUrl: uploadResult.secure_url,
              cloudinaryPublicId: uploadResult.public_id, // Keep this for URL regeneration
              cloudinaryVersion: uploadResult.version, // Keep version for URL regeneration
              width: ev.data.width,
              height: ev.data.height,
              fileSizeKB: fileSizeKB // Store file size for display in frontend
            }
            }
          }
        } catch (screenshotError) {
          console.error('[Cloudinary] ❌ Screenshot upload failed:', screenshotError.message || screenshotError)
          if (screenshotError.http_code) {
            console.error(`[Cloudinary]   HTTP Code: ${screenshotError.http_code}`)
          }
          // If Cloudinary upload fails, keep the dataUrl as fallback
          // Don't remove dataUrl so frontend can still display it
          // Calculate file size from dataUrl as fallback
          try {
            const dataUrl = ev.data.dataUrl || ''
            const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
            if (base64Part && !imageBuffer) {
              // Create buffer from dataUrl if we don't have one yet
              imageBuffer = Buffer.from(base64Part, 'base64')
            }
            if (imageBuffer) {
              const approxSizeKB = Math.round(imageBuffer.length / 1024)
              ev.data.fileSizeKB = approxSizeKB
              console.log(`[Cloudinary]   Calculated approximate size: ${approxSizeKB}KB`)
            }
          } catch (sizeCalcError) {
            console.warn('[Cloudinary]   Could not calculate file size from dataUrl')
          }
          console.log('[Cloudinary]   Keeping dataUrl as fallback for frontend display')
        }
        
        // IMPORTANT: Always process OCR for screenshots, even if Cloudinary fails
        // We need the image buffer for OCR processing
        if (ev.type === 'screenshot' && imageBuffer) {
          ev._needsOCR = true
          ev._imageBuffer = imageBuffer
          console.log(`[OCR] Screenshot queued for OCR processing (buffer size: ${imageBuffer.length} bytes)`)
        } else if (ev.type === 'screenshot' && ev.data?.dataUrl) {
          // Fallback: if we don't have buffer but have dataUrl, we'll process from dataUrl later
          ev._needsOCR = true
          ev._hasDataUrl = true
          console.log(`[OCR] Screenshot queued for OCR processing (will use dataUrl)`)
        }
      }

      // Ensure we have required fields
      if (!item.ts) {
        console.warn('Event missing ts, skipping:', item)
        continue
      }

      let storedData = ev.data || null
      let captureReason = undefined
      if (ev.type === 'screenshot' && storedData) {
        captureReason = storedData.reason || 'unknown'
        // Only strip the huge base64 dataUrl if we have a cloudinaryUrl to replace it
        if (storedData.dataUrl && storedData.cloudinaryUrl) {
          const { dataUrl: _strip, ...rest } = storedData
          storedData = rest
        } else if (storedData.dataUrl && !storedData.cloudinaryUrl) {
          // No Cloudinary URL — keep dataUrl so the screenshot is still viewable
          console.log(`[Collect] ⚠️ Screenshot kept with dataUrl (no Cloudinary URL). Size: ~${Math.round(storedData.dataUrl.length / 1024)}KB`)
        }
      }

      const eventDoc = {
        ts: item.ts,
        sessionId: item.sessionId || `session_${item.userId}_${Math.floor(item.ts / 86400000)}`,
        pageId: item.pageId || `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        userId: item.userId,
        projectId: item.projectId || 'discovery-ai',
        type: ev.type || 'unknown',
        data: storedData,
        ip,
        extensionUserId: extUser ? extUser._id : undefined,
        ocrProcessed: false,
        ...(captureReason ? { captureReason } : {}),
        ...(storedData?.cloudinaryUrl ? { url: storedData.cloudinaryUrl } : {})
      }
      
      // Store OCR processing info separately (don't save buffer to MongoDB)
      if (ev._needsOCR) {
        ocrProcessingQueue.push({
          imageBuffer: ev._imageBuffer || null,
          dataUrl: ev._hasDataUrl ? ev.data?.dataUrl : null,
          cloudinaryUrl: ev.data?.cloudinaryUrl,
          eventIndex: toInsert.length // Track which event this belongs to
        })
        console.log(`[OCR] Added to OCR queue: eventIndex=${toInsert.length}, hasBuffer=${!!ev._imageBuffer}, hasDataUrl=${!!ev._hasDataUrl}`)
      }
      
      toInsert.push(eventDoc)
    }

    if (toInsert.length) {
      // Route events to the correct category collections (screenshot_events, interaction_events, etc.)
      const inserted = await insertEvents(toInsert)
      console.log(`Inserted ${toInsert.length} events into organized collections for userId: ${sample?.userId || 'unknown'}`)
      
      // Process OCR for screenshots asynchronously
      console.log(`[OCR] Processing ${ocrProcessingQueue.length} screenshots for OCR...`)
      for (const ocrTask of ocrProcessingQueue) {
        const eventDoc = inserted[ocrTask.eventIndex]
        if (eventDoc && eventDoc.type === 'screenshot') {
          // Process OCR in background (don't await to avoid blocking response)
          processOCRForEvent(
            eventDoc._id, 
            ocrTask.imageBuffer, 
            ocrTask.cloudinaryUrl || eventDoc.data?.cloudinaryUrl,
            ocrTask.dataUrl // Pass dataUrl as fallback
          )
            .catch(err => {
              console.error(`[OCR] Failed to process OCR for event ${eventDoc._id}:`, err.message)
              console.error(`[OCR] Error stack:`, err.stack)
            })
        } else {
          console.warn(`[OCR] Skipping OCR for event at index ${ocrTask.eventIndex}: not a screenshot or event not found`)
        }
      }
    } else {
      console.log('No events to insert')
    }

    res.json({ success: true, received: toInsert.length })
  } catch (e) {
    console.error('collector error:', e)
    res.status(500).json({ error: 'collector error', details: e.message })
  }
})

/**
 * Process OCR for a screenshot event
 * This runs asynchronously after the event is saved
 */
async function processOCRForEvent(eventId, imageBuffer, cloudinaryUrl, dataUrl) {
  try {
    console.log(`[OCR] Starting OCR processing for event ${eventId}`)
    console.log(`[OCR]   Has buffer: ${!!imageBuffer}, Has Cloudinary URL: ${!!cloudinaryUrl}, Has dataUrl: ${!!dataUrl}`)
    
    let ocrText = ''
    let ocrStructured = null
    let ocrEngine = null

    // Try to extract text and structured layout from image
    try {
      if (imageBuffer) {
        console.log(`[OCR]   Using image buffer (${imageBuffer.length} bytes)`)
        const result = await extractTextAndStructuredFromImage(imageBuffer)
        ocrText = result.text
        ocrStructured = result.structured
        ocrEngine = result.engine || null
      } else if (cloudinaryUrl) {
        console.log(`[OCR]   Downloading from Cloudinary: ${cloudinaryUrl}`)
        const result = await extractTextAndStructuredFromImageUrl(cloudinaryUrl)
        ocrText = result.text
        ocrStructured = result.structured
        ocrEngine = result.engine || null
      } else if (dataUrl) {
        console.log(`[OCR]   Using dataUrl (${dataUrl.length} chars)`)
        const { extractTextAndStructuredFromImage } = await import('../services/ocrService.js')
        const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
        if (base64 && base64 !== dataUrl) {
          const buffer = Buffer.from(base64, 'base64')
          const result = await extractTextAndStructuredFromImage(buffer)
          ocrText = result.text
          ocrStructured = result.structured
          ocrEngine = result.engine || null
        } else {
          throw new Error('Invalid dataUrl format')
        }
      } else {
        console.warn(`[OCR] No image source available for event ${eventId}`)
        await ScreenshotEvent.findByIdAndUpdate(eventId, {
          ocrProcessed: true,
          ocrText: '',
          ocrStructured: null,
          ocrTags: []
        })
        return
      }
    } catch (ocrError) {
      console.error(`[OCR] ❌ OCR extraction failed for event ${eventId}:`, ocrError.message)
      console.error(`[OCR]   Error stack:`, ocrError.stack)
      await ScreenshotEvent.findByIdAndUpdate(eventId, {
        ocrProcessed: true,
        ocrText: '',
        ocrStructured: null,
        ocrTags: []
      })
      return
    }

    if (!ocrText || ocrText.trim().length === 0) {
      console.log(`[OCR] ⚠️  No text extracted from event ${eventId}`)
      await ScreenshotEvent.findByIdAndUpdate(eventId, {
        ocrProcessed: true,
        ocrText: '',
        ocrStructured: null,
        ocrTags: []
      })
      return
    }

    console.log(`[OCR]   Extracted ${ocrText.length} characters, ${(ocrStructured && ocrStructured.lines) ? ocrStructured.lines.length : 0} structured lines`)

    // Extract tags from OCR text
    const tags = extractTags(ocrText)
    const phrases = extractPhrases(ocrText)
    const allTags = [...new Set([...tags, ...phrases])]

    console.log(`[OCR] ✅ Processed OCR for event ${eventId}`)
    console.log(`[OCR]   Text length: ${ocrText.length} chars, structured lines: ${(ocrStructured && ocrStructured.lines) ? ocrStructured.lines.length : 0}`)
    console.log(`[OCR]   Tags extracted: ${allTags.length}`)
    if (allTags.length > 0) {
      console.log(`[OCR]   Top tags: ${allTags.slice(0, 5).join(', ')}`)
    }

    // Update event with OCR results (text + structured + engine for accurate claim extraction)
    const updateResult = await ScreenshotEvent.findByIdAndUpdate(eventId, {
      ocrText,
      ocrStructured: ocrStructured || undefined,
      ocrEngine: ocrEngine || undefined,
      ocrTags: allTags,
      ocrProcessed: true
    }, { new: true })
    
    if (!updateResult) {
      console.error(`[OCR] ⚠️  Failed to update event ${eventId} with OCR results`)
    } else {
      console.log(`[OCR] ✅ Successfully saved OCR data to event ${eventId}`)
      // Extract structured claim data from this screenshot using tags engine (async best-effort)
      try {
        await extractClaimFromScreenshotEvent(eventId)
      } catch (claimErr) {
        console.error(`[TagsEngine] ❌ Failed to extract claim for event ${eventId}:`, claimErr.message)
        console.error(`[TagsEngine] Error stack:`, claimErr.stack)
      }
    }
    
  } catch (error) {
    console.error(`[OCR] ❌ Error processing OCR for event ${eventId}:`, error.message)
    console.error(`[OCR]   Error stack:`, error.stack)
    // Mark as processed even on error to avoid infinite retries
    await ScreenshotEvent.findByIdAndUpdate(eventId, {
      ocrProcessed: true
    }).catch((updateError) => {
      console.error(`[OCR]   Failed to mark event as processed:`, updateError.message)
    })
  }
}

// ===== REMOTE COMMAND POLLING =====
// Extension polls this endpoint to check for pending remote commands
router.get('/remote-commands', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const trackerUserId = req.query.trackerUserId
    if (!trackerUserId) {
      return res.status(400).json({ error: 'trackerUserId is required' })
    }

    // Find pending commands that haven't expired
    const commands = await RemoteCommand.find({
      trackerUserId,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    })
      .sort({ createdAt: -1 })
      .limit(1) // Only return the latest pending command
      .lean()

    if (commands.length === 0) {
      return res.json({ commands: [] })
    }

    // Mark commands as delivered
    const commandIds = commands.map(c => c._id)
    await RemoteCommand.updateMany(
      { _id: { $in: commandIds } },
      { status: 'delivered', deliveredAt: new Date() }
    )

    res.json({
      commands: commands.map(c => ({
        _id: c._id,
        command: c.command,
        sessionName: c.sessionName || '',
        createdAt: c.createdAt
      }))
    })
  } catch (e) {
    console.error('[collect/remote-commands] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// Extension confirms command execution
router.post('/remote-commands/ack', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { commandId, trackerUserId } = req.body
    if (!commandId) {
      return res.status(400).json({ error: 'commandId is required' })
    }

    await RemoteCommand.findByIdAndUpdate(commandId, {
      status: 'executed',
      executedAt: new Date()
    })

    res.json({ success: true })
  } catch (e) {
    console.error('[collect/remote-commands/ack] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
