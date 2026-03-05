import mongoose from 'mongoose'

/**
 * StructuredClaim
 * Denormalized claim data matching the Excel export structure.
 * One document per screenshot event — captures the claim state at each
 * point in time so field changes (status, assignedTo, etc.) are preserved.
 */

const serviceLineSchema = new mongoose.Schema({
  seq: Number,
  fromDate: String,
  toDate: String,
  cptCode: String,
  mod: String,
  qty: Number,
  billed: Number,
  contract: Number,
  netPay: Number,
  deductible: Number,
  copay: Number,
  coinsurance: Number,
  adjustment: Number,
  prevPaid: Number,
  prevPatResp: Number
}, { _id: false })

const structuredClaimSchema = new mongoose.Schema({
  // Linkage (one doc per screenshot; screenshotEventId is unique key)
  ocrClaimId: { type: mongoose.Schema.Types.ObjectId, ref: 'OcrClaim', index: true },
  screenshotEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScreenshotEvent', unique: true },
  projectId: { type: String, index: true },

  // Per-screenshot timing
  screenshotTs: { type: Date, index: true },
  captureReason: { type: String },

  // User info (from Excel: User_Id, User_email)
  userId: { type: String },
  userEmail: { type: String },

  // Core identifiers (from Excel: Claim ID, Claim EDI)
  claimId: { type: String, index: true },
  ediClaimId: { type: String, index: true },

  // Status & workflow (from Excel: status, Status History, Auth/Ref Status, assigned_to)
  status: { type: String, index: true },
  statusHistory: { type: String },
  authRefStatus: { type: String },
  assignedTo: { type: String },

  // Claim metadata (from Excel: claim_type, received_date)
  claimType: { type: String },
  receivedDate: { type: String },
  companyId: { type: String },
  priority: { type: String },
  serviceDateFrom: { type: String },

  // Auth/Referral
  authReferralNums: [{ type: String }],

  // Patient info (from Excel: patient_name, member_id)
  patientName: { type: String },
  memberId: { type: String },
  dob: { type: String },
  gender: { type: String },

  // Provider info (from Excel: Provider)
  providerName: { type: String },
  providerId: { type: String },

  // Clinical
  primaryDiagnosis: { type: String },
  placeOfService: { type: String },
  facility: { type: String },
  outcome: { type: String },
  payerResp: { type: String },
  ediBatchId: { type: String },

  // Totals
  totalBilled: { type: Number },
  totalNetPay: { type: Number },

  // Service lines
  serviceLines: [serviceLineSchema],

  // Adjudication
  adjudication: {
    billedAmount: Number,
    allowedAmount: Number,
    deductible: Number,
    payableAmount: Number,
    totalBilled: Number,
    totalNetPay: Number
  },

  // From Excel: Reopened, Processing Time
  isReopened: { type: Boolean, default: false },
  reopenSequence: { type: Number },
  processingTime: { type: String },

  // Source metadata (from Excel: website_url, Software/App, image_source_file, OCR engine, quality)
  websiteUrl: { type: String },
  softwareApp: { type: String },
  imageSourceFile: { type: String },
  ocrEngine: { type: String },
  qualityScore: { type: Number },

  // Categorization (from Excel: Category, Operation, Details)
  category: { type: String },
  operation: { type: String },
  details: { type: String },
  docType: { type: String }
}, {
  timestamps: true,
  collection: 'structured_claims'
})

structuredClaimSchema.index({ projectId: 1, claimId: 1, screenshotTs: 1 })
structuredClaimSchema.index({ projectId: 1, status: 1 })
structuredClaimSchema.index({ claimId: 1, screenshotTs: 1 })

export default mongoose.model('StructuredClaim', structuredClaimSchema, 'structured_claims')
