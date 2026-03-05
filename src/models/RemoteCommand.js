import mongoose from 'mongoose'

const remoteCommandSchema = new mongoose.Schema(
  {
    // Target extension user (by trackerUserId for quick lookup)
    trackerUserId: { type: String, required: true, index: true },
    // The extension user document ID
    extensionUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExtensionUser', index: true },
    // Who issued the command (admin/PM user ID)
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Command type: start_session, end_session, pause_session, resume_session
    command: {
      type: String,
      required: true,
      enum: ['start_session', 'end_session', 'pause_session', 'resume_session']
    },
    // Optional session name (for start_session)
    sessionName: { type: String, default: '' },
    // Command status
    status: {
      type: String,
      default: 'pending',
      enum: ['pending', 'delivered', 'executed', 'expired', 'cancelled'],
      index: true
    },
    // When the command was delivered to the extension
    deliveredAt: { type: Date },
    // When the command was executed by the extension
    executedAt: { type: Date },
    // Expiry - commands older than 5 minutes are auto-expired
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      index: true
    }
  },
  { timestamps: true }
)

// TTL index to auto-delete old commands after 24 hours
remoteCommandSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 })

export default mongoose.model('RemoteCommand', remoteCommandSchema)

