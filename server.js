import express from 'express'
import http from 'http'
import cors from 'cors'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { Server as SocketIOServer } from 'socket.io'
import path from 'path'
import fs from 'fs/promises'
import authRouter from './src/routes/auth.js'
import claimsRouter from './src/routes/claims.js'
import collectRouter from './src/routes/collect.js'
import analyticsRouter from './src/routes/analytics.js'
import extAuthRouter from './src/routes/extAuth.js'
import sitesRouter from './src/routes/sites.js'
import projectManagerRouter from './src/routes/projectManager.js'
import { authMiddleware } from './src/utils/auth.js'

dotenv.config()

const app = express()
const server = http.createServer(app)
const io = new SocketIOServer(server, { cors: { origin: '*'} })

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo'
const PORT = Number(process.env.PORT) || 4000

// DB
mongoose.connect(MONGO_URI, { dbName: 'claims_demo', autoIndex: false }).then(()=>{
  console.log('Mongo connected')
}).catch(err=>{
  console.error('Mongo error', err)
})

// Middleware
// CORS: allow frontend origins so browser gets Access-Control-* headers (avoids CORS errors on timeout/errors)
const allowedOrigins = [
  'https://discovery-ai-ssip.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
]

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true)
    if (origin.startsWith('chrome-extension://')) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true)
    callback(null, true)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Accept'],
  optionsSuccessStatus: 204,
  preflightContinue: false
}))
// Allow larger payloads for batched events/screenshots
app.use(express.json({ limit: '10mb' }))

// Serve static screenshot files
const screenshotsDir = path.join(process.cwd(), 'screenshots')
app.get('/screenshots/:filename', async (req, res) => {
  try {
    const filename = req.params.filename
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' })
    }
    const filePath = path.join(screenshotsDir, filename)
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false)
    if (!fileExists) {
      return res.status(404).json({ error: 'Screenshot not found' })
    }
    res.sendFile(filePath)
  } catch (e) {
    console.error('Screenshot serve error:', e)
    res.status(500).json({ error: 'Failed to serve screenshot' })
  }
})

// Routes
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'discovery-ai-backend' })
})
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Drop trackerUserId unique index endpoint (one-time migration)
// Call this once to remove the unique constraint on trackerUserId
app.post('/api/drop-trackerUserId-index', async (req, res) => {
  try {
    const ExtensionUser = (await import('./src/models/ExtensionUser.js')).default
    const collection = ExtensionUser.collection
    
    // List current indexes
    const indexesBefore = await collection.indexes()
    console.log('[drop-index] Current indexes:', indexesBefore.map(idx => ({ name: idx.name, key: idx.key, unique: idx.unique })))
    
    // Find and drop any unique index on trackerUserId
    const trackerUserIdIndexes = indexesBefore.filter(idx => 
      idx.key && idx.key.trackerUserId && idx.unique === true
    )
    
    if (trackerUserIdIndexes.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No unique index on trackerUserId found (already dropped or never existed)',
        indexes: indexesBefore.map(idx => ({ name: idx.name, key: idx.key, unique: idx.unique }))
      })
    }
    
    // Drop all unique indexes on trackerUserId
    const droppedIndexes = []
    for (const index of trackerUserIdIndexes) {
      try {
        await collection.dropIndex(index.name)
        droppedIndexes.push(index.name)
        console.log(`[drop-index] Dropped index: ${index.name}`)
      } catch (e) {
        if (e.code === 27 || e.message?.includes('index not found')) {
          console.log(`[drop-index] Index ${index.name} already dropped`)
        } else {
          throw e
        }
      }
    }
    
    const indexesAfter = await collection.indexes()
    res.json({ 
      success: true, 
      message: `Dropped ${droppedIndexes.length} unique index(es) on trackerUserId: ${droppedIndexes.join(', ')}`,
      droppedIndexes,
      indexesBefore: indexesBefore.map(idx => ({ name: idx.name, key: idx.key, unique: idx.unique })),
      indexesAfter: indexesAfter.map(idx => ({ name: idx.name, key: idx.key, unique: idx.unique }))
    })
  } catch (e) {
    console.error('[drop-index] Error:', e)
    res.status(500).json({ error: 'Failed to drop index', details: e.message })
  }
})

// Auto-drop trackerUserId unique index on startup (one-time migration)
mongoose.connection.once('connected', async () => {
  try {
    const ExtensionUser = (await import('./src/models/ExtensionUser.js')).default
    const collection = ExtensionUser.collection
    const indexes = await collection.indexes()
    const trackerUserIdUniqueIndex = indexes.find(idx => 
      idx.key && idx.key.trackerUserId && idx.unique === true
    )
    
    if (trackerUserIdUniqueIndex) {
      console.log(`[startup] Found unique index on trackerUserId: ${trackerUserIdUniqueIndex.name}, dropping...`)
      try {
        await collection.dropIndex(trackerUserIdUniqueIndex.name)
        console.log(`[startup] ✅ Successfully dropped unique index: ${trackerUserIdUniqueIndex.name}`)
      } catch (e) {
        console.error(`[startup] ⚠️  Failed to auto-drop index: ${e.message}`)
        console.log('[startup] Please call POST /api/drop-trackerUserId-index manually')
      }
    } else {
      console.log('[startup] ✅ No unique index on trackerUserId found (already removed)')
    }
  } catch (e) {
    console.error('[startup] Error checking indexes:', e.message)
  }
})

// Seed endpoint (for initial setup - remove in production or add auth)
app.post('/api/seed-users', async (req, res) => {
  try {
    const User = (await import('./src/models/User.js')).default
    const { hashPassword } = await import('./src/utils/auth.js')
    
    const adminEmail = 'admin@discovery.ai'
    const adminPassword = 'admin-discovery'
    const clientEmail = 'client@discovery.ai'
    const clientPassword = 'client-discovery'
    const pmEmail = 'pm@discovery.ai'
    const pmPassword = 'pm-discovery'

    // Create admin user - ALWAYS ensure isAdmin is true for admin@discovery.ai
    let admin = await User.findOne({ email: adminEmail })
    if (!admin) {
      const passwordHash = await hashPassword(adminPassword)
      admin = await User.create({ 
        email: adminEmail, 
        passwordHash, 
        name: 'Admin User', 
        isAdmin: true,
        role: 'admin'
      })
      console.log('✅ Created admin user with role=admin')
    } else {
      // FORCE update isAdmin and role for admin@discovery.ai (always)
      const wasAdmin = admin.isAdmin
      admin.isAdmin = true
      admin.role = 'admin'
      await admin.save()
      console.log(`✅ ${wasAdmin ? 'Verified' : 'Updated'} admin user: set role=admin`)
      console.log('Admin user details:', { 
        email: admin.email, 
        isAdmin: admin.isAdmin, 
        role: admin.role,
        _id: admin._id
      })
    }

    // Create client user
    let client = await User.findOne({ email: clientEmail })
    if (!client) {
      const passwordHash = await hashPassword(clientPassword)
      client = await User.create({ 
        email: clientEmail, 
        passwordHash, 
        name: 'Client User', 
        isAdmin: false,
        role: 'client'
      })
      console.log('✅ Created client user')
    } else {
      client.role = 'client'
      await client.save()
    }

    // Create project manager user
    let pm = await User.findOne({ email: pmEmail })
    if (!pm) {
      const passwordHash = await hashPassword(pmPassword)
      pm = await User.create({ 
        email: pmEmail, 
        passwordHash, 
        name: 'Project Manager', 
        isAdmin: false,
        role: 'project_manager',
        projectId: 'discovery-ai' // Default project
      })
      console.log('✅ Created project manager user with role=project_manager')
    } else {
      pm.role = 'project_manager'
      pm.projectId = pm.projectId || 'discovery-ai'
      await pm.save()
      console.log('✅ Updated project manager user: set role=project_manager')
    }

    res.json({ 
      success: true, 
      message: 'Users seeded successfully',
      admin: { email: adminEmail, exists: !!admin, role: 'admin' },
      client: { email: clientEmail, exists: !!client, role: 'client' },
      projectManager: { email: pmEmail, exists: !!pm, role: 'project_manager', projectId: pm?.projectId }
    })
  } catch (e) {
    console.error('Seed error:', e)
    res.status(500).json({ error: 'Seed failed', details: e.message })
  }
})
app.use('/api/auth', authRouter)
app.use('/api/ext-auth', extAuthRouter)
app.use('/api/claims', authMiddleware, claimsRouter)
app.use('/api/collect', collectRouter)
app.use('/api/sites', sitesRouter)
// Public analytics endpoints (work with extension user tokens)
app.use('/api/analytics', analyticsRouter)
// Admin analytics endpoints (require admin auth)
app.use('/api/admin/analytics', authMiddleware, analyticsRouter)
// Project Manager endpoints (require project_manager or admin role)
app.use('/api/pm', projectManagerRouter)

// Socket auth
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token
  if (!token) return next(new Error('no token'))
  try {
    const { verifyToken } = await import('./src/utils/auth.js')
    const payload = verifyToken(token)
    socket.userId = payload.sub
    next()
  } catch (e) {
    next(new Error('invalid token'))
  }
})

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`)
})

app.set('io', io)

server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})


