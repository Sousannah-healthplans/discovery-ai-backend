import { Router } from 'express'
import Event from '../models/Event.js'
import ExtensionUser from '../models/ExtensionUser.js'
import { verifyToken } from '../utils/auth.js'
import {
  findEvents,
  countEvents,
  ScreenshotEvent,
  TabEvent,
  getAllModels
} from '../services/eventStore.js'

const router = Router()

// Simple in-memory cache for expensive queries
const cache = new Map()
const CACHE_TTL = 30 * 1000 // 30 seconds

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() })
  // Clean old entries periodically
  if (cache.size > 100) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k)
    }
  }
}

// Helper to extract extension user id from normal auth token
async function getExtUserFromAuth(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return { user: null, hasToken: false, tokenError: null }
  
  try {
    const payload = verifyToken(token)
    if (!payload || !payload.sub) {
      return { user: null, hasToken: true, tokenError: new Error('Invalid token payload') }
    }
    const extUser = await ExtensionUser.findById(payload.sub).select('_id trackerUserId username').lean()
    if (!extUser) {
      return { user: null, hasToken: true, tokenError: new Error('User not found') }
    }
    return { user: extUser, hasToken: true, tokenError: null }
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      console.log('[getExtUserFromAuth] Token expired')
    } else if (e.name === 'JsonWebTokenError') {
      console.log('[getExtUserFromAuth] Invalid token format/signature:', e.message)
    } else {
      console.error('[getExtUserFromAuth] Token error:', e.name, e.message)
    }
    return { user: null, hasToken: true, tokenError: e }
  }
}

// ----- OPTIMIZED Overview endpoint - Single aggregation for all metrics -----
router.get('/overview', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { projectId } = req.query
    
    const match = {}
    if (extUser) {
      match.userId = extUser.trackerUserId
    }
    if (projectId) match.projectId = projectId

    // Check cache first
    const cacheKey = `overview_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    // Aggregate across all organized event collections
    const allModels = getAllModels()
    const facetPipeline = [
      { $match: match },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
          sessions: [
            {
              $group: {
                _id: { $ifNull: ['$sessionId', '$pageId'] },
                start: { $min: '$ts' },
                end: { $max: '$ts' }
              }
            }
          ]
        }
      }
    ]

    // Run aggregation on all collections in parallel
    const collectionResults = await Promise.all(
      allModels.map(M => M.aggregate(facetPipeline).allowDiskUse(true))
    )

    // Also get screenshot-specific counts from the screenshots collection
    const [screenshotAgg] = await ScreenshotEvent.aggregate([
      { $match: match },
      {
        $facet: {
          count: [{ $count: 'count' }],
          sessionsWithScreenshots: [
            { $group: { _id: '$sessionId' } },
            { $count: 'count' }
          ]
        }
      }
    ]).allowDiskUse(true)

    // Merge results from all collections
    let totalEvents = 0
    const byType = {}
    const sessionMap = new Map() // Merge sessions across collections

    for (const [result] of collectionResults) {
      if (!result) continue
      totalEvents += result.totalEvents?.[0]?.count || 0
      ;(result.eventTypes || []).forEach(et => {
        if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count
      })
      ;(result.sessions || []).forEach(s => {
        const existing = sessionMap.get(s._id)
        if (existing) {
          existing.start = Math.min(existing.start, s.start)
          existing.end = Math.max(existing.end, s.end)
        } else {
          sessionMap.set(s._id, { ...s })
        }
      })
    }

    const sessions = [...sessionMap.values()].filter(s => s.end > s.start)
    const totalSessions = sessions.length
    const screenshots = screenshotAgg?.count?.[0]?.count || 0
    const sessionsWithScreenshots = screenshotAgg?.sessionsWithScreenshots?.[0]?.count || 0

    // Calculate average duration from sessions
    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => {
          const duration = s.end && s.start ? (s.end - s.start) / 1000 : 0
          return sum + duration
        }, 0) / sessions.length
      : 0

    console.log(`[overview] Query completed in ${Date.now() - startTime}ms`)

    const response = {
      metrics: {
        totalSessions,
        totalEvents,
        screenshots,
        sessionsWithScreenshots,
        avgTimeSec: Math.round(avgDuration),
        byType
      },
      charts: {
        sessionsOverTime: []
      }
    }

    setCache(cacheKey, response)
    res.json(response)
  } catch (e) {
    console.error('overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Sessions endpoint -----
router.get('/sessions', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        const errorMsg = tokenError.name === 'TokenExpiredError' 
          ? 'Token expired' 
          : tokenError.name === 'JsonWebTokenError'
          ? 'Invalid token - please log in again'
          : 'Invalid token'
        return res.status(401).json({ error: 'Unauthorized', details: errorMsg })
      }
      return res.json([])
    }

    const { limit = 100, projectId } = req.query
    const match = { userId: extUser.trackerUserId }
    if (projectId) match.projectId = projectId

    // Check cache
    const cacheKey = `sessions_${extUser.trackerUserId}_${projectId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    // Aggregate sessions across all event collections
    const sessionPipeline = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$sessionId', '$pageId'] },
          start: { $min: '$ts' },
          end: { $max: '$ts' },
          count: { $sum: 1 },
          userId: { $first: '$userId' }
        }
      }
    ]

    const allResults = await Promise.all(
      getAllModels().map(M => M.aggregate(sessionPipeline).allowDiskUse(true))
    )

    // Merge sessions from all collections
    const sessionMap = new Map()
    for (const results of allResults) {
      for (const s of results) {
        const existing = sessionMap.get(s._id)
        if (existing) {
          existing.start = Math.min(existing.start, s.start)
          existing.end = Math.max(existing.end, s.end)
          existing.count += s.count
          if (!existing.userId) existing.userId = s.userId
        } else {
          sessionMap.set(s._id, { ...s })
        }
      }
    }

    const sessions = [...sessionMap.values()]
      .filter(s => s.end > s.start)
      .sort((a, b) => b.end - a.end)
      .slice(0, Math.min(Number(limit) || 100, 500))

    console.log(`[sessions] Query completed in ${Date.now() - startTime}ms, found ${sessions.length} sessions`)

    const formattedSessions = sessions.map(s => {
      const startMs = s.start ? new Date(s.start).getTime() : null
      const endMs = s.end ? new Date(s.end).getTime() : null
      const durationSec = startMs && endMs ? Math.round((endMs - startMs) / 1000) : 0
      
      return {
        sessionId: s._id || `session_${s.start}`,
        start: s.start,
        end: s.end,
        durationSec: durationSec,
        count: s.count,
        userId: s.userId
      }
    })

    setCache(cacheKey, formattedSessions)
    res.json(formattedSessions)
  } catch (e) {
    console.error('sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Events endpoint -----
router.get('/events', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { type, limit = 200, projectId, sessionId } = req.query
    
    const q = {}
    if (extUser) {
      q.userId = extUser.trackerUserId
    }
    if (type) q.type = type
    if (projectId) q.projectId = projectId
    if (sessionId) q.sessionId = sessionId // Filter by session for detail page!

    // Check cache - include sessionId in key
    const cacheKey = `events_${extUser?.trackerUserId || 'all'}_${type || 'all'}_${projectId || 'all'}_${sessionId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    // Query across organized event collections
    const items = await findEvents(q, {
      select: 'ts sessionId pageId userId projectId type data ip tabId url title',
      sort: { ts: -1 },
      limit: Math.min(Number(limit), 2000),
      lean: true
    })

    console.log(`[events] Query completed in ${Date.now() - startTime}ms, found ${items.length} events`)

    setCache(cacheKey, items)
    res.json(items)
  } catch (e) {
    console.error('events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Screenshots endpoint -----
router.get('/screenshots', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { limit = 50, projectId, sessionId } = req.query
    
    const q = { type: 'screenshot' }
    if (extUser) {
      q.userId = extUser.trackerUserId
    }
    if (projectId) q.projectId = projectId
    if (sessionId) q.sessionId = sessionId // Filter by session!

    // Check cache
    const cacheKey = `screenshots_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}_${sessionId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    // Query directly from the screenshot_events collection for better performance
    const screenshotQuery = { ...q }
    delete screenshotQuery.type // No need — we're querying the screenshots collection directly
    const items = await ScreenshotEvent.find(screenshotQuery)
      .select('ts sessionId pageId userId projectId type captureReason url data ip extensionUserId ocrText ocrTags ocrProcessed')
      .sort({ ts: -1 })
      .limit(Math.min(Number(limit), 100))
      .setOptions({ allowDiskUse: true })
      .lean()

    console.log(`[screenshots] Query completed in ${Date.now() - startTime}ms, found ${items.length} screenshots`)

    setCache(cacheKey, items)
    res.json(items)
  } catch (e) {
    console.error('screenshots error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- TABS endpoint - aggregates all tabs from all sessions -----
router.get('/tabs', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { projectId } = req.query
    
    // Match ALL events that might have tab info (not just tab_* events)
    const match = {
      $or: [
        { type: { $in: ['tab_activated', 'tab_deactivated', 'tab_created', 'tab_updated', 'tab_removed'] } },
        { 'data.tabId': { $exists: true, $ne: null } },
        { type: { $in: ['page_load', 'page_view', 'page_event'] }, 'data.url': { $exists: true } }
      ]
    }
    if (extUser) {
      match.userId = extUser.trackerUserId
    }
    if (projectId) match.projectId = projectId

    // Check cache
    const cacheKey = `tabs_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) {
      console.log('[tabs] Returning cached data')
      return res.json(cached)
    }

    const startTime = Date.now()

    // Query tab events from the dedicated tab_events collection
    const tabs = await TabEvent.aggregate([
      { $match: match },
      { $sort: { ts: 1 } },
      {
        $group: {
          _id: { $ifNull: ['$data.tabId', '$data.url'] },
          url: { $last: { $ifNull: ['$data.url', '$url'] } },
          title: { $last: { $ifNull: ['$data.title', '$title'] } },
          created: { $min: '$ts' },
          lastUpdated: { $max: '$ts' },
          activations: { 
            $sum: { $cond: [{ $eq: ['$type', 'tab_activated'] }, 1, 0] } 
          },
          events: {
            $push: {
              type: '$type',
              ts: '$ts'
            }
          },
          sessionIds: { $addToSet: '$sessionId' }
        }
      },
      { $match: { _id: { $ne: null } } },
      { $sort: { lastUpdated: -1 } },
      { $limit: 500 }
    ]).allowDiskUse(true)

    // Calculate duration for each tab
    const processedTabs = tabs.map(tab => {
      let totalActiveMs = 0
      let activeStart = null
      
      const sortedEvents = tab.events.sort((a, b) => a.ts - b.ts)
      
      for (const event of sortedEvents) {
        if (event.type === 'tab_activated') {
          if (activeStart === null) {
            activeStart = event.ts
          }
        } else if (event.type === 'tab_deactivated' || event.type === 'tab_removed') {
          if (activeStart !== null) {
            totalActiveMs += event.ts - activeStart
            activeStart = null
          }
        }
      }
      
      // If still active, cap at 5 minutes
      if (activeStart !== null && sortedEvents.length > 0) {
        const lastEvent = sortedEvents[sortedEvents.length - 1]
        const duration = lastEvent.ts - activeStart
        totalActiveMs += Math.min(duration, 5 * 60 * 1000)
      }
      
      // If has activations but 0 duration, give minimal duration
      if (tab.activations > 0 && totalActiveMs === 0) {
        totalActiveMs = tab.activations * 1000
      }
      
      // Filter out invalid URLs
      const url = tab.url || ''
      if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
        return null
      }
      
      return {
        tabId: tab._id,
        url: tab.url,
        title: tab.title || 'Untitled',
        created: tab.created,
        lastUpdated: tab.lastUpdated,
        activations: tab.activations,
        totalActiveMs: totalActiveMs,
        sessionCount: tab.sessionIds ? tab.sessionIds.length : 1,
        eventCount: tab.events.length
      }
    }).filter(Boolean)

    console.log(`[tabs] Query completed in ${Date.now() - startTime}ms, found ${processedTabs.length} tabs`)

    setCache(cacheKey, processedTabs, 60000)
    res.json(processedTabs)
  } catch (e) {
    console.error('tabs error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- Extension user "my data" endpoints -----
router.get('/me/sessions', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { limit = 100 } = req.query
    const match = { userId: extUser.trackerUserId }

    // Aggregate sessions across all event collections
    const sessionPipe = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$sessionId', '$pageId'] },
          start: { $min: '$ts' },
          end: { $max: '$ts' },
          count: { $sum: 1 },
          userId: { $first: '$userId' }
        }
      }
    ]
    const allRes = await Promise.all(getAllModels().map(M => M.aggregate(sessionPipe).allowDiskUse(true)))
    const sMap = new Map()
    for (const arr of allRes) {
      for (const s of arr) {
        const ex = sMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end); ex.count += s.count; if (!ex.userId) ex.userId = s.userId }
        else sMap.set(s._id, { ...s })
      }
    }
    const sessions = [...sMap.values()].sort((a, b) => b.end - a.end).slice(0, Number(limit))

    res.json(sessions)
  } catch (e) {
    console.error('me/sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/me/events', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { type, limit = 200 } = req.query
    const q = { userId: extUser.trackerUserId }
    if (type) q.type = type

    const items = await findEvents(q, { sort: { ts: -1 }, limit: Number(limit), lean: true })
    res.json(items)
  } catch (e) {
    console.error('me/events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// Manual OCR trigger endpoint
router.post('/screenshots/:eventId/process-ocr', async (req, res) => {
  try {
    const { eventId } = req.params
    const { user: extUser } = await getExtUserFromAuth(req)
    
    const q = { _id: eventId }
    if (extUser) {
      q.userId = extUser.trackerUserId
    }
    
    // Query directly from screenshot_events collection
    const event = await ScreenshotEvent.findOne(q)
    if (!event) {
      return res.status(404).json({ error: 'Screenshot not found' })
    }
    
    if (event.ocrProcessed && event.ocrTags && event.ocrTags.length > 0) {
      return res.json({ 
        success: true, 
        message: 'OCR already processed',
        ocrText: event.ocrText,
        ocrTags: event.ocrTags
      })
    }
    
    const { extractTextAndStructuredFromImage, extractTextAndStructuredFromImageUrl } = await import('../services/ocrService.js')
    const { extractTags, extractPhrases } = await import('../utils/tagExtractor.js')
    const { extractClaimFromScreenshotEvent } = await import('../services/tagsEngine/claimExtractionService.js')

    const imageUrl = event.data?.cloudinaryUrl || event.data?.dataUrl
    if (!imageUrl) {
      return res.status(400).json({ error: 'No image URL available', eventData: event.data })
    }

    let ocrText = ''
    let ocrStructured = null
    let ocrEngine = null
    try {
      if (imageUrl.startsWith('data:')) {
        const base64 = imageUrl.split(',')[1]
        if (!base64) throw new Error('Invalid data URL format')
        const buffer = Buffer.from(base64, 'base64')
        const result = await extractTextAndStructuredFromImage(buffer)
        ocrText = result.text
        ocrStructured = result.structured
        ocrEngine = result.engine || null
      } else {
        const result = await extractTextAndStructuredFromImageUrl(imageUrl)
        ocrText = result.text
        ocrStructured = result.structured
        ocrEngine = result.engine || null
      }
    } catch (ocrError) {
      console.error(`[OCR Manual] ❌ OCR failed:`, ocrError)
      return res.status(500).json({
        error: 'OCR processing failed',
        details: ocrError.message
      })
    }

    if (!ocrText || ocrText.trim().length === 0) {
      await ScreenshotEvent.findByIdAndUpdate(eventId, {
        ocrProcessed: true,
        ocrText: '',
        ocrStructured: null,
        ocrTags: []
      })
      return res.json({ success: true, message: 'No text found in image', ocrText: '', ocrTags: [] })
    }

    const tags = extractTags(ocrText)
    const phrases = extractPhrases(ocrText)
    const allTags = [...new Set([...tags, ...phrases])]

    await ScreenshotEvent.findByIdAndUpdate(eventId, {
      ocrText,
      ocrStructured: ocrStructured || undefined,
      ocrEngine: ocrEngine || undefined,
      ocrTags: allTags,
      ocrProcessed: true
    })

    try {
      await extractClaimFromScreenshotEvent(eventId)
    } catch (claimErr) {
      console.error('[OCR Manual] Claim extraction failed:', claimErr.message)
    }

    cache.clear()

    res.json({
      success: true,
      ocrText,
      ocrStructured: ocrStructured ? { linesCount: ocrStructured.lines?.length || 0, blocksCount: ocrStructured.blocks?.length || 0 } : null,
      ocrTags: allTags,
      ocrProcessed: true,
      message: `Extracted ${allTags.length} tags from ${ocrText.length} characters (${ocrStructured?.lines?.length || 0} structured lines)`
    })
    
  } catch (e) {
    console.error('Manual OCR error:', e)
    res.status(500).json({ error: 'OCR processing error', details: e.message })
  }
})

// Debug endpoint
router.get('/me/debug', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const eventCount = await countEvents({ userId: extUser.trackerUserId })
    const sampleEvents = await findEvents({ userId: extUser.trackerUserId }, { limit: 5, select: 'ts type sessionId pageId userId', lean: true })
    
    res.json({
      extUser: {
        id: extUser._id,
        username: extUser.username,
        trackerUserId: extUser.trackerUserId
      },
      eventCount,
      sampleEvents
    })
  } catch (e) {
    console.error('me/debug error:', e)
    res.status(500).json({ error: 'debug error', details: e.message })
  }
})

// ----- Admin endpoints -----

router.get('/users', async (req, res) => {
  try {
    const cacheKey = 'admin_users'
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    // Aggregate users across all event collections
    const userPipeline = [
      { $match: { userId: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$userId',
          events: { $sum: 1 },
          firstTs: { $min: '$ts' },
          lastTs: { $max: '$ts' }
        }
      }
    ]
    const allUserResults = await Promise.all(getAllModels().map(M => M.aggregate(userPipeline).allowDiskUse(true)))
    
    // Merge user stats from all collections
    const userMap = new Map()
    for (const results of allUserResults) {
      for (const u of results) {
        const existing = userMap.get(u._id)
        if (existing) {
          existing.events += u.events
          existing.firstTs = Math.min(existing.firstTs || Infinity, u.firstTs || Infinity)
          existing.lastTs = Math.max(existing.lastTs || 0, u.lastTs || 0)
        } else {
          userMap.set(u._id, { ...u })
        }
      }
    }
    const users = [...userMap.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 200)

    const userIds = users.map(u => u._id)
    const extensionUsers = await ExtensionUser.find({ trackerUserId: { $in: userIds } })
      .select('trackerUserId username')
      .lean()
    
    const extUserMap = new Map()
    extensionUsers.forEach(u => {
      extUserMap.set(u.trackerUserId, u)
    })

    const result = users.map((u) => {
      const extUser = extUserMap.get(u._id)
      return {
        userId: u._id,
        username: extUser?.username || null,
        email: extUser?.username ? `${extUser.username}@ext` : null,
        events: u.events,
        firstTs: u.firstTs,
        lastTs: u.lastTs
      }
    })

    setCache(cacheKey, result)
    res.json(result)
  } catch (e) {
    console.error('analytics users error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/sessions', async (req, res) => {
  try {
    const { limit = 100 } = req.query
    const { userId } = req.params

    // Aggregate sessions across all event collections
    const sPipe = [
      { $match: { userId } },
      { $group: { _id: { $ifNull: ['$sessionId', '$pageId'] }, start: { $min: '$ts' }, end: { $max: '$ts' }, count: { $sum: 1 }, userId: { $first: '$userId' } } }
    ]
    const allSRes = await Promise.all(getAllModels().map(M => M.aggregate(sPipe).allowDiskUse(true)))
    const sMap = new Map()
    for (const arr of allSRes) {
      for (const s of arr) {
        const ex = sMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end); ex.count += s.count; if (!ex.userId) ex.userId = s.userId }
        else sMap.set(s._id, { ...s })
      }
    }
    const sessions = [...sMap.values()].filter(s => s.end > s.start).sort((a, b) => b.end - a.end).slice(0, Math.min(Number(limit) || 100, 500))

    const formattedSessions = sessions.map(s => ({
      sessionId: s._id || `session_${s.start}`,
      start: s.start,
      end: s.end,
      durationSec: s.start && s.end ? Math.round((s.end - s.start) / 1000) : 0,
      count: s.count,
      userId: s.userId
    }))

    res.json(formattedSessions)
  } catch (e) {
    console.error('analytics sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/events', async (req, res) => {
  try {
    const { type, limit = 200 } = req.query
    const { userId } = req.params
    
    const q = { userId }
    if (type) q.type = type

    const items = await findEvents(q, { sort: { ts: -1 }, limit: Math.min(Number(limit), 500), lean: true })
    res.json(items)
  } catch (e) {
    console.error('analytics events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/overview', async (req, res) => {
  try {
    const { userId } = req.params
    const match = { userId }

    // Aggregate overview across all event collections
    const overviewPipe = [
      { $match: match },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
          sessions: [{ $group: { _id: { $ifNull: ['$sessionId', '$pageId'] }, start: { $min: '$ts' }, end: { $max: '$ts' } } }]
        }
      }
    ]
    const allOvRes = await Promise.all(getAllModels().map(M => M.aggregate(overviewPipe).allowDiskUse(true)))

    let totalEvents = 0
    const byType = {}
    const sessMap = new Map()
    for (const [r] of allOvRes) {
      if (!r) continue
      totalEvents += r.totalEvents?.[0]?.count || 0
      ;(r.eventTypes || []).forEach(et => { if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count })
      ;(r.sessions || []).forEach(s => {
        const ex = sessMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end) }
        else sessMap.set(s._id, { ...s })
      })
    }

    const screenshots = await ScreenshotEvent.countDocuments(match)
    const sessions = [...sessMap.values()]
    const totalSessions = sessions.filter(s => s.end > s.start).length

    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + ((s.end && s.start ? (s.end - s.start) / 1000 : 0)), 0) / sessions.length
      : 0

    res.json({
      totalSessions,
      totalEvents,
      screenshots,
      avgTimeSec: Math.round(avgDuration),
      byType
    })
  } catch (e) {
    console.error('analytics overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// Admin global overview
router.get('/admin/overview', async (req, res) => {
  try {
    const cacheKey = 'admin_overview'
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    const matchExtensionEvents = { 
      $or: [
        { userId: { $exists: true, $ne: null } },
        { extensionUserId: { $exists: true, $ne: null } }
      ]
    }

    // Aggregate admin overview across all event collections
    const adminPipe = [
      { $match: matchExtensionEvents },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
          sessions: [
            { $group: { _id: { $ifNull: ['$sessionId', '$pageId'] }, start: { $min: '$ts' }, end: { $max: '$ts' } } }
          ]
        }
      }
    ]

    const [allAdminResults, totalUsers] = await Promise.all([
      Promise.all(getAllModels().map(M => M.aggregate(adminPipe).allowDiskUse(true))),
      ExtensionUser.countDocuments()
    ])

    let totalEvents = 0
    const byType = {}
    const sessMap = new Map()
    for (const [r] of allAdminResults) {
      if (!r) continue
      totalEvents += r.totalEvents?.[0]?.count || 0
      ;(r.eventTypes || []).forEach(et => { if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count })
      ;(r.sessions || []).forEach(s => {
        const ex = sessMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end) }
        else sessMap.set(s._id, { ...s })
      })
    }

    // Sort byType by count descending and take top 10
    const sortedByType = {}
    Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => { sortedByType[k] = v })

    const sessions = [...sessMap.values()].filter(s => s.end > s.start)
    const totalSessions = sessions.length

    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + ((s.end - s.start) / 1000 || 0), 0) / sessions.length
      : 0

    const response = {
      totalUsers,
      totalSessions,
      totalEvents,
      avgSessionDurationSec: Math.round(avgDuration),
      byType: sortedByType,
      sessionsOverTime: [] // TODO: implement cross-collection sessionsOverTime if needed
    }

    setCache(cacheKey, response)
    res.json(response)
  } catch (e) {
    console.error('admin overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

export default router
