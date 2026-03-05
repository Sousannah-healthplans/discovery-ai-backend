import mongoose from 'mongoose'

const extensionUserSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    trackerUserId: { type: String, required: true, index: true }, // NOT unique - allows multiple accounts per device
    lastIp: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
    // Project/Company ID - associates user with a project for project manager visibility
    projectId: { type: String, index: true },
    // Email for extension users (optional)
    email: { type: String, index: true },
    // Full name
    name: { type: String },
    // Active status
    isActive: { type: Boolean, default: true, index: true },
    // Stealth tracking: whether this user is currently being tracked remotely
    stealthTracking: { type: Boolean, default: false },
    // Current stealth session name (set by admin/PM)
    stealthSessionName: { type: String, default: '' },
    // When stealth tracking was started
    stealthStartedAt: { type: Date }
  },
  { timestamps: true }
)

export default mongoose.model('ExtensionUser', extensionUserSchema)



