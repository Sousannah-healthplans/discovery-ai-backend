import { Router } from 'express'
import User from '../models/User.js'
import ExtensionUser from '../models/ExtensionUser.js'
import { hashPassword, comparePassword, signToken } from '../utils/auth.js'

const router = Router()

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' })
    const exists = await User.findOne({ email })
    if (exists) return res.status(409).json({ error: 'Email already registered' })
    const passwordHash = await hashPassword(password)
    const user = await User.create({ email, passwordHash, name })
    const token = signToken(user)
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/login', async (req, res) => {
  try {
    const { email, password, username } = req.body
    console.log('[auth/login] Login attempt:', { email, username, hasPassword: !!password })
    
    // Try email login first (regular users)
    if (email) {
      const user = await User.findOne({ email })
      console.log('[auth/login] User lookup:', { email, found: !!user })
      if (user) {
        const ok = await comparePassword(password, user.passwordHash)
        console.log('[auth/login] Password check:', { email, ok })
        if (ok) {
          const token = signToken(user)
          // Determine role: use new role field, fallback to isAdmin for backward compatibility
          let role = user.role
          if (!role) {
            role = (user.isAdmin === true || user.isAdmin === 'true' || user.isAdmin === 1) ? 'admin' : 'client'
          }
          console.log('[auth/login] Login successful:', { 
            email, 
            userId: user._id, 
            role,
            projectId: user.projectId,
            isAdmin: user.isAdmin,
            userDoc: JSON.stringify(user.toObject ? user.toObject() : user)
          })
          return res.json({ 
            token, 
            user: { 
              id: user._id, 
              email: user.email, 
              name: user.name, 
              role,
              projectId: user.projectId || null,
              // Keep isAdmin for backward compatibility
              isAdmin: role === 'admin'
            } 
          })
        }
      }
    }
    
    // Try username login (extension users)
    const loginIdentifier = username || email // Support both username and email for extension users
    if (loginIdentifier) {
      const extUser = await ExtensionUser.findOne({ username: loginIdentifier })
      console.log('[auth/login] ExtensionUser lookup:', { loginIdentifier, found: !!extUser })
      if (extUser) {
        const ok = await comparePassword(password, extUser.passwordHash)
        console.log('[auth/login] ExtensionUser password check:', { loginIdentifier, ok })
        if (ok) {
          // Create a token compatible with regular auth system
          // Format it so frontend treats it as a client user
          const token = signToken({ _id: extUser._id, email: `${extUser.username}@ext`, isExtension: true })
          console.log('[auth/login] ExtensionUser login successful:', { loginIdentifier, userId: extUser._id })
          return res.json({ 
            token, 
            user: { 
              id: extUser._id, 
              email: `${extUser.username}@ext`, 
              name: extUser.name || extUser.username,
              username: extUser.username,
              trackerUserId: extUser.trackerUserId,
              projectId: extUser.projectId || null,
              isExtension: true,
              role: 'client'
            } 
          })
        }
      }
    }
    
    console.log('[auth/login] Login failed: Invalid credentials')
    return res.status(401).json({ error: 'Invalid credentials' })
  } catch (e) {
    console.error('[auth/login] Login error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

router.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    const { verifyToken } = await import('../utils/auth.js')
    const payload = verifyToken(token)
    const user = await User.findById(payload.sub).select('_id email name')
    res.json({ user })
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' })
  }
})

export default router


