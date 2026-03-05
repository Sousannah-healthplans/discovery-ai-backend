import dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'
import User from '../src/models/User.js'
import { hashPassword } from '../src/utils/auth.js'

const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/claims_demo'
const MONGO_DBNAME = 'claims_demo'

async function main() {
  try {
    await mongoose.connect(MONGO_URI, { dbName: MONGO_DBNAME })
    console.log('✅ Connected to MongoDB')

    const adminEmail = 'admin@discovery.ai'
    const adminPassword = 'admin-discovery'
    const clientEmail = 'client@discovery.ai'
    const clientPassword = 'client-discovery'

    // Create admin user - ALWAYS ensure isAdmin is true for admin@discovery.ai
    let admin = await User.findOne({ email: adminEmail })
    if (!admin) {
      const passwordHash = await hashPassword(adminPassword)
      admin = await User.create({ 
        email: adminEmail, 
        passwordHash, 
        name: 'Admin User', 
        isAdmin: true 
      })
      console.log('✅ Created admin user:', adminEmail)
    } else {
      // FORCE update isAdmin to true (always ensure it's set)
      const wasAdmin = admin.isAdmin
      admin.isAdmin = true
      await admin.save()
      console.log(`✅ ${wasAdmin ? 'Verified' : 'Updated'} admin user: set isAdmin=true`, {
        email: admin.email,
        isAdmin: admin.isAdmin,
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
        isAdmin: false 
      })
      console.log('✅ Created client user:', clientEmail)
    } else {
      console.log('ℹ️  Client user already exists:', clientEmail)
    }

    console.log('\n✅ Seed completed!')
    console.log('\nDefault credentials:')
    console.log('Admin:', adminEmail, '/', adminPassword)
    console.log('Client:', clientEmail, '/', clientPassword)
    
    process.exit(0)
  } catch (e) {
    console.error('❌ Seed error:', e)
    process.exit(1)
  }
}

main()

