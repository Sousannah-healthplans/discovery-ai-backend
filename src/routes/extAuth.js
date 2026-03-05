import { Router } from 'express'
import ExtensionUser from '../models/ExtensionUser.js'
import TeamInvitation from '../models/TeamInvitation.js'
import { hashPassword, comparePassword, signToken, verifyToken } from '../utils/auth.js'

const router = Router()

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string') return xf.split(',')[0].trim()
  return req.ip || req.connection?.remoteAddress || ''
}

// Called by the extension the first time it runs in a browser.
// Body: { username, password, trackerUserId }
router.post('/register', async (req, res) => {
  try {
    const { username, password, trackerUserId, meta, name, email } = req.body || {}
    console.log('[ext-auth/register] Registration attempt:', { username, hasPassword: !!password, trackerUserId, name, email })
    
    if (!username || !password || !trackerUserId) {
      return res.status(400).json({ error: 'Missing fields' })
    }

    // Only check username uniqueness - allow multiple accounts per device (same trackerUserId)
    const existing = await ExtensionUser.findOne({ username })
    if (existing) {
      console.log('[ext-auth/register] Username already exists:', username)
      return res.status(409).json({ error: 'Username already exists' })
    }
    
    // Check how many accounts exist for this trackerUserId (for logging)
    const accountsForDevice = await ExtensionUser.countDocuments({ trackerUserId })
    console.log('[ext-auth/register] Accounts for trackerUserId:', { trackerUserId, count: accountsForDevice })

    const passwordHash = await hashPassword(password)
    
    try {
      const doc = await ExtensionUser.create({
        username,
        passwordHash,
        trackerUserId,
        lastIp: clientIp(req),
        meta: meta || {},
        email: (email || username || '').toLowerCase(),
        name: name || username || ''
      })

      // Reuse the same JWT helper; frontend will treat this like a "user"
      const token = signToken({ _id: doc._id, email: `${doc.username}@ext`, isExtension: true })

      console.log('[ext-auth/register] Created new extension user:', {
        username,
        trackerUserId,
        userId: doc._id
      })

      res.json({
        token,
        user: {
          id: doc._id,
          username: doc.username,
          trackerUserId: doc.trackerUserId,
          isExtension: true
        }
      })
    } catch (createError) {
      // Handle MongoDB duplicate key error (in case unique index still exists)
      if (createError.code === 11000 || createError.name === 'MongoServerError') {
        const field = createError.keyPattern ? Object.keys(createError.keyPattern)[0] : 'unknown'
        console.error('[ext-auth/register] Duplicate key error:', {
          field,
          username,
          trackerUserId,
          error: createError.message
        })
        if (field === 'username') {
          return res.status(409).json({ error: 'Username already exists' })
        } else if (field === 'trackerUserId') {
          // This shouldn't happen anymore, but handle gracefully
          console.warn('[ext-auth/register] trackerUserId unique constraint still exists - allowing registration anyway')
          // Try to find existing user with same trackerUserId and username
          const existing = await ExtensionUser.findOne({ username })
          if (existing) {
            return res.status(409).json({ error: 'Username already exists' })
          }
          // If username is unique, allow it even if trackerUserId index exists
          // The index will be dropped eventually, but don't block registration
          return res.status(500).json({ 
            error: 'Registration failed due to database constraint. Please contact support.' 
          })
        }
      }
      throw createError // Re-throw other errors
    }
  } catch (e) {
    console.error('[ext-auth/register] Registration error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Normal login from Discovery AI UI for extension users.
// Body: { username, password, trackerUserId? }
router.post('/login', async (req, res) => {
  try {
    const { username, password, trackerUserId } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' })

    const user = await ExtensionUser.findOne({ username })
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const ok = await comparePassword(password, user.passwordHash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

    user.lastIp = clientIp(req)
    
    // Do NOT overwrite the account's trackerUserId when the extension sends a different one
    // (e.g. after reinstall the extension gets a new random id). Return the account's
    // existing id so the extension can adopt it and stay linked to the same user/claims.
    // The extension will write the returned trackerUserId to storage and use it for events.
    await user.save()

    const token = signToken({ _id: user._id, email: `${user.username}@ext`, isExtension: true })
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        trackerUserId: user.trackerUserId,
        isExtension: true
      }
    })
  } catch (e) {
    console.error('[ext-auth/login] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// Middleware to verify extension user token
async function requireExtensionUser(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  
  try {
    const payload = verifyToken(token)
    const user = await ExtensionUser.findById(payload.sub)
    if (!user) return res.status(401).json({ error: 'User not found' })
    
    req.extUser = user
    req.extUserId = user._id
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// Get pending invitations for the logged-in extension user
router.get('/invitations', requireExtensionUser, async (req, res) => {
  try {
    const { extUser } = req
    
    const invitations = await TeamInvitation.find({
      extensionUserId: extUser._id,
      status: 'pending'
    })
      .sort({ createdAt: -1 })
      .lean()
    
    res.json(invitations)
  } catch (e) {
    console.error('[ext-auth/invitations] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Accept invitation
router.post('/invitations/:invitationId/accept', requireExtensionUser, async (req, res) => {
  try {
    const { extUser } = req
    const { invitationId } = req.params
    
    const invitation = await TeamInvitation.findById(invitationId)
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' })
    }
    
    // Verify this invitation is for this user
    if (invitation.extensionUserId.toString() !== extUser._id.toString()) {
      return res.status(403).json({ error: 'This invitation is not for you' })
    }
    
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Invitation is no longer pending' })
    }
    
    // Check if user is already in a team
    if (extUser.projectId) {
      return res.status(400).json({ error: 'You are already in a team' })
    }
    
    // Accept the invitation - add user to the project
    extUser.projectId = invitation.projectId
    await extUser.save()
    
    // Update invitation status
    invitation.status = 'accepted'
    invitation.respondedAt = new Date()
    await invitation.save()
    
    // Cancel any other pending invitations for this user
    await TeamInvitation.updateMany(
      { extensionUserId: extUser._id, status: 'pending', _id: { $ne: invitationId } },
      { status: 'cancelled' }
    )
    
    res.json({ 
      success: true, 
      message: 'Invitation accepted',
      projectId: invitation.projectId
    })
  } catch (e) {
    console.error('[ext-auth/invitations/accept] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Reject invitation
router.post('/invitations/:invitationId/reject', requireExtensionUser, async (req, res) => {
  try {
    const { extUser } = req
    const { invitationId } = req.params
    
    const invitation = await TeamInvitation.findById(invitationId)
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' })
    }
    
    // Verify this invitation is for this user
    if (invitation.extensionUserId.toString() !== extUser._id.toString()) {
      return res.status(403).json({ error: 'This invitation is not for you' })
    }
    
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Invitation is no longer pending' })
    }
    
    // Reject the invitation
    invitation.status = 'rejected'
    invitation.respondedAt = new Date()
    await invitation.save()
    
    res.json({ success: true, message: 'Invitation rejected' })
  } catch (e) {
    console.error('[ext-auth/invitations/reject] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Leave team (extension user leaves their current team)
router.post('/leave-team', requireExtensionUser, async (req, res) => {
  try {
    const { extUser } = req
    
    if (!extUser.projectId) {
      return res.status(400).json({ error: 'You are not in any team' })
    }
    
    const oldProjectId = extUser.projectId
    extUser.projectId = undefined
    await extUser.save()
    
    res.json({ success: true, message: 'You have left the team', oldProjectId })
  } catch (e) {
    console.error('[ext-auth/leave-team] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

export default router
