import mongoose from 'mongoose'

/**
 * OcrClaim
 * Structured claim data extracted from screenshot OCR + tags.
 * Kept separate from manual Claim model to avoid breaking existing flows.
 */

const ocrClaimSchema = new mongoose.Schema({
  // Linkage
  screenshotEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScreenshotEvent', index: true, required: true },
  projectId: { type: String, index: true },
  trackerUserId: { type: String, index: true }, // matches ScreenshotEvent.userId

  // De-duplication fingerprint (same logical screenshot/claim); not unique so reopens can share similar OCR
  fingerprint: { type: String, index: true },

  // Core identifiers
  claimId: { type: String, index: true }, // Professional Claim (display as Claim ID)
  ediClaimId: { type: String, index: true }, // EDI Claim # (display as Claim EDI)
  claimType: { type: String, index: true },
  authRefStatus: { type: String }, // Auth/Ref Status from OCR
  status: { type: String, index: true },
  priority: { type: String, index: true },

  // Additional claim metadata
  companyId: { type: String },
  serviceDateFrom: { type: String },
  ediBatchId: { type: String },
  placeOfService: { type: String },
  facility: { type: String },
  outcome: { type: String },
  payerResp: { type: String },
  primaryDiagnosis: { type: String },
  authReferralNums: [{ type: String }],
  gender: { type: String },
  providerId: { type: String },

  // Parties
  providerName: { type: String, index: true },
  patientName: { type: String, index: true },
  memberId: { type: String, index: true },
  userIdLabel: { type: String },

  // Dates
  receivedDate: { type: Date, index: true },
  dob: { type: Date },

  // Source document / page metadata
  sourceUrl: { type: String },
  sourcePath: { type: String },
  docType: { type: String, index: true }, // e.g. claim_detail, dashboard
  origin: { type: String }, // e.g. dashboard_recent, screen_detail

  // OCR engine meta
  engineUsed: { type: String, default: 'tesseract' },
  qualityScore: { type: Number, min: 0, max: 100 }, // heuristic quality 0-100

  // OCR raw data snapshot (for convenience)
  ocrText: { type: String },
  ocrTags: [{ type: String }],

  // Processing timing (per claim across duplicate screenshots)
  firstSeenTs: { type: Date },
  lastSeenTs: { type: Date },
  processingDurationSec: { type: Number, default: 0 }, // derived (last-first)

  // Reopen: when same claim is opened again after a gap, stored as new doc with its own duration
  isReopened: { type: Boolean, default: false, index: true },
  reopenSequence: { type: Number, index: true }, // 1 = original, 2 = first reopen, 3 = second reopen, ...

  // Misc
  assignedTo: { type: String },

  // Status change history (every status transition with timestamp)
  statusHistory: [{
    status: { type: String, required: true },
    timestamp: { type: Date, required: true },
    screenshotEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScreenshotEvent' },
    _id: false
  }],

  // Service details (array of service line items)
  serviceDetails: [{
    serviceDate: String,
    cptCode: String,
    description: String,
    billedAmount: Number,
    allowedAmount: Number,
    contractAmount: Number,
    netPayAmount: Number,
    deductible: Number,
    copay: Number,
    coinsurance: Number,
    adjustment: Number,
    prevPaid: Number,
    prevPatResp: Number,
    _id: false
  }],

  // Adjudication amounts
  adjudication: {
    billedAmount: Number,
    allowedAmount: Number,
    deductible: Number,
    payableAmount: Number,
    totalBilled: Number,
    totalNetPay: Number
  }
}, {
  timestamps: true
})

// Helpful compound indexes
ocrClaimSchema.index({ projectId: 1, claimId: 1 })
ocrClaimSchema.index({ projectId: 1, providerName: 1 })
ocrClaimSchema.index({ projectId: 1, status: 1 })

export default mongoose.model('OcrClaim', ocrClaimSchema, 'ocr_claims')


