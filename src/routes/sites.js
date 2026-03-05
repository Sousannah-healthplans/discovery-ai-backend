import { Router } from 'express'
import ExtensionUser from '../models/ExtensionUser.js'
import Event from '../models/Event.js'
import { verifyToken } from '../utils/auth.js'
import { countEvents, distinctEvents } from '../services/eventStore.js'

const router = Router()

// Helper to get extension user from token
async function getExtUserFromAuth(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  try {
    const payload = verifyToken(token)
    if (!payload || !payload.sub) return null
    const extUser = await ExtensionUser.findById(payload.sub).select('_id trackerUserId username')
    return extUser
  } catch (e) {
    return null
  }
}

// For extension users, return their "site" (which is their extension installation)
router.get('/', async (req, res) => {
  try {
    const extUser = await getExtUserFromAuth(req)
    
    if (!extUser) {
      // Return empty array if no auth (for backward compatibility)
      return res.json([])
    }

    // Get stats for this extension user across all organized collections
    const eventCount = await countEvents({ userId: extUser.trackerUserId })
    const sessionIds = await distinctEvents('sessionId', { userId: extUser.trackerUserId })
    const sessionCount = sessionIds.filter(s => s).length

    // Return a "site" object representing this extension user
    const site = {
      _id: extUser._id,
      name: `${extUser.username}'s Extension`,
      domain: 'browser-extension',
      projectId: 'discovery-ai',
      apiKey: 'extension-user',
      userId: extUser.trackerUserId,
      eventCount,
      sessionCount,
      createdAt: extUser.createdAt,
      updatedAt: extUser.updatedAt
    }

    res.json([site])
  } catch (e) {
    console.error('sites error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router

