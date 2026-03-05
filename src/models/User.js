import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  name: { type: String },
  // Legacy field - kept for backward compatibility
  isAdmin: { type: Boolean, default: false, index: true },
  // New role system: 'admin', 'project_manager', 'client'
  role: { 
    type: String, 
    enum: ['admin', 'project_manager', 'client'], 
    default: 'client',
    index: true 
  },
  // Project/Company ID - project managers can only see users in their project
  projectId: { type: String, index: true }
}, { timestamps: true })

// Virtual to get effective role (for backward compatibility)
userSchema.virtual('effectiveRole').get(function() {
  if (this.role) return this.role
  if (this.isAdmin) return 'admin'
  return 'client'
})

export default mongoose.model('User', userSchema)


