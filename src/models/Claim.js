import mongoose from 'mongoose'

const claimSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  claimId: { type: String, required: true, index: true },
  status: { type: String, default: 'Open' },
  amount: { type: Number, default: 0 },
  description: { type: String, default: '' },
  notes: { type: String, default: '' },
  attachments: [{ filename: String, size: Number, type: String }]
}, { timestamps: true })

export default mongoose.model('Claim', claimSchema)


