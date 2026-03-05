import mongoose from 'mongoose'

const teamInvitationSchema = new mongoose.Schema(
  {
    // The extension user being invited
    extensionUserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'ExtensionUser', 
      required: true,
      index: true 
    },
    // The email used to find them
    email: { type: String, required: true, index: true },
    // The project/team they're being invited to
    projectId: { type: String, required: true, index: true },
    // The PM/admin who sent the invitation
    invitedBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: true 
    },
    invitedByName: { type: String },
    invitedByEmail: { type: String },
    // Status: pending, accepted, rejected, cancelled
    status: { 
      type: String, 
      enum: ['pending', 'accepted', 'rejected', 'cancelled'], 
      default: 'pending',
      index: true 
    },
    // Optional message from PM
    message: { type: String },
    // When the user responded
    respondedAt: { type: Date }
  },
  { timestamps: true }
)

// Compound index for checking existing invitations
teamInvitationSchema.index({ extensionUserId: 1, projectId: 1, status: 1 })

export default mongoose.model('TeamInvitation', teamInvitationSchema)

