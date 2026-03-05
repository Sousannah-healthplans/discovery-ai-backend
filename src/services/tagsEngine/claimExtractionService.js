/**
 * Claim extraction service using intelligent extractor
 * One document per claim session; reopens (same claim after a gap) create a new doc for accurate duration.
 */

const REOPEN_THRESHOLD_MS = 30 * 60 * 1000 // 30 min: if event is this long after last activity, treat as reopen

import crypto from 'crypto'
import OcrClaim from '../../models/OcrClaim.js'
import StructuredClaim from '../../models/StructuredClaim.js'
import { ScreenshotEvent } from '../eventStore.js'
import { IntelligentExtractor } from './intelligentExtractor.js'
import { mergeServiceDetails, mergeAdjudication } from './claimMerger.js'
import { extractClaimWithLlm, mergeLlmIntoClaim } from './llmClaimEnrichment.js'
import { normalizeWorkflowStatus, sanitizeProviderName as sanitizeProviderNamePatterns } from './claimRegexPatterns.js'

const extractor = new IntelligentExtractor()

const NOISE_PATTERN = /Service\s+Details|Service\s+Date|CPT\s+Code|Billed\s+Amount|Allowed\s+Amount|Total\s+Billed/i
function isNoise(value) {
  if (!value || typeof value !== 'string') return true
  return NOISE_PATTERN.test(value) || value.length > 200
}

function sanitizeProviderField(value, kind) {
  if (!value || typeof value !== 'string') return ''
  let v = value.trim()
  if (kind === 'name') {
    v = sanitizeProviderNamePatterns(v)
    if (!v) return ''
    // Reject only when the entire value is exactly a noise label (not "Service Medical Group")
    if (/^(?:Service|CPT|Date|Billed|Allowed|Total|Amount|Code|Claim|Patient|Member|Name|ID|NPI|TIN|Provider|Information|Details)$/i.test(v)) return ''
    if (v.length > 80) return ''
    return v
  }
  if (kind === 'id') {
    const digits = v.replace(/\D/g, '')
    return (digits.length >= 6 && digits.length <= 15) ? digits : ''
  }
  return v
}

function buildFingerprint({ ocrText, ocrTags, url }) {
  const h = crypto.createHash('sha1')
  h.update((ocrText || '').trim().toLowerCase())
  h.update('||')
  h.update((url || '').toLowerCase())
  h.update('||')
  if (Array.isArray(ocrTags)) h.update(ocrTags.join('|').toLowerCase())
  return h.digest('hex')
}

function heuristicQualityScore(ocrText) {
  const len = (ocrText || '').length
  if (!len) return 0
  const base = 50
  const bonus = Math.min(40, Math.floor(len / 200))
  return Math.min(100, base + bonus)
}

function fmtDate(d) {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function formatStatusHistory(statusHistory) {
  if (!Array.isArray(statusHistory) || statusHistory.length === 0) return ''
  return statusHistory.map(h => {
    const ts = h.timestamp ? new Date(h.timestamp).toISOString() : ''
    return ts ? `${h.status} (${ts})` : h.status
  }).join(' → ')
}

function getAppNameFromUrl(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return ''
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    const host = (u.hostname || '').toLowerCase().replace(/^www\./, '')
    if (!host) return ''
    const base = host.split('.')[0]
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : host
  } catch { return '' }
}

function getCategoryOperationDetails(ocrClaim) {
  const dt = (ocrClaim.docType || '').toLowerCase()
  let category = 'Review & Approval'
  if (dt === 'claim_detail') category = 'Claim Detail'
  else if (dt === 'adjudication') category = 'Adjudication'
  else if (dt === 'policy_verification') category = 'Policy Verification'
  else if (dt === 'dashboard') category = 'Dashboard'
  else if (dt === 'claims_queue') category = 'Claims Queue'
  else if (ocrClaim.docType) category = ocrClaim.docType

  let operation = ''
  if (ocrClaim.status && ocrClaim.status !== 'Needs Review') operation = ocrClaim.status
  else if (ocrClaim.origin && ocrClaim.origin.includes('detail')) operation = 'Review'
  else operation = 'Extract doc'

  const details = ocrClaim.claimId
    ? `${category} \u2192 ${operation} for claim ${ocrClaim.claimId}`
    : ''
  return { category, operation, details }
}

/**
 * Save a structured_claims document for this screenshot event.
 * One document per screenshot — mutable fields (status, assignedTo, etc.)
 * come from the CURRENT extraction so changes between screenshots are captured.
 * Stable/identity fields fall back to the accumulated OcrClaim.
 */
async function upsertStructuredClaim(ocrClaimDoc, ev, extractedClaim) {
  const ocrClaim = ocrClaimDoc.toObject ? ocrClaimDoc.toObject() : ocrClaimDoc
  const webUrl = ev?.data?.url && typeof ev.data.url === 'string' && !ev.data.url.startsWith('data:')
    ? ev.data.url : (ocrClaim.sourceUrl || '')

  // Mutable fields: use status normalized to canonical form (e.g. "3 : MANUAL HOLD" → "3 MANUAL HOLD")
  const rawStatus = extractedClaim?.status ?? ocrClaim.status ?? ''
  const currentStatus = rawStatus ? (normalizeWorkflowStatus(rawStatus) || rawStatus) : ''
  const currentAssignedTo = extractedClaim?.assignedTo || ocrClaim.assignedTo || ''
  const currentAuthRefStatus = extractedClaim?.authRefStatus || ocrClaim.authRefStatus || ''
  const currentPriority = extractedClaim?.priority || ocrClaim.priority || ''

  // Build category/operation from the current screenshot's status
  const snapshotForCatOp = { ...ocrClaim, status: currentStatus }
  const { category, operation, details } = getCategoryOperationDetails(snapshotForCatOp)

  let imageFile = ''
  if (ev?.data?.cloudinaryUrl) imageFile = ev.data.cloudinaryUrl
  else if (ev?.data?.screenshotFilename) imageFile = ev.data.screenshotFilename

  const serviceLines = (extractedClaim?.serviceDetails || ocrClaim.serviceDetails || []).map((sd, idx) => ({
    seq: idx + 1,
    fromDate: sd.serviceDate || '',
    toDate: sd.serviceDate || '',
    cptCode: sd.cptCode || '',
    mod: '',
    qty: 1,
    billed: sd.billedAmount ?? null,
    contract: sd.contractAmount ?? sd.allowedAmount ?? null,
    netPay: sd.netPayAmount ?? null,
    deductible: sd.deductible ?? null,
    copay: sd.copay ?? null,
    coinsurance: sd.coinsurance ?? null,
    adjustment: sd.adjustment ?? null,
    prevPaid: sd.prevPaid ?? null,
    prevPatResp: sd.prevPatResp ?? null
  }))

  const currentAdj = extractedClaim?.adjudication || ocrClaim.adjudication || {}

  const data = {
    ocrClaimId: ocrClaim._id,
    screenshotEventId: ev._id,
    screenshotTs: ev.ts ? new Date(ev.ts) : new Date(),
    captureReason: ev.captureReason || ev.data?.reason || '',
    projectId: ocrClaim.projectId,
    userId: ocrClaim.trackerUserId || '',
    userEmail: '',
    claimId: ocrClaim.claimId || '',
    ediClaimId: ocrClaim.ediClaimId || '',
    // Mutable fields from current screenshot
    status: currentStatus,
    statusHistory: formatStatusHistory(ocrClaim.statusHistory),
    authRefStatus: currentAuthRefStatus,
    assignedTo: currentAssignedTo,
    priority: currentPriority,
    // Stable fields: accumulated from OcrClaim (first good value persists)
    claimType: ocrClaim.claimType || extractedClaim?.claimType || '',
    receivedDate: fmtDate(ocrClaim.receivedDate),
    companyId: ocrClaim.companyId || extractedClaim?.companyId || '',
    serviceDateFrom: ocrClaim.serviceDateFrom || extractedClaim?.serviceDateFrom || '',
    authReferralNums: ocrClaim.authReferralNums || extractedClaim?.authReferralNums || [],
    patientName: ocrClaim.patientName || extractedClaim?.patientName || '',
    memberId: ocrClaim.memberId || extractedClaim?.memberId || '',
    dob: fmtDate(ocrClaim.dob),
    gender: ocrClaim.gender || extractedClaim?.gender || '',
    providerName: sanitizeProviderField(ocrClaim.providerName || extractedClaim?.providerName || '', 'name'),
    providerId: sanitizeProviderField(ocrClaim.providerId || extractedClaim?.providerId || '', 'id'),
    primaryDiagnosis: ocrClaim.primaryDiagnosis || extractedClaim?.primaryDiagnosis || '',
    placeOfService: ocrClaim.placeOfService || extractedClaim?.placeOfService || '',
    facility: ocrClaim.facility || extractedClaim?.facility || '',
    outcome: ocrClaim.outcome || extractedClaim?.outcome || '',
    payerResp: ocrClaim.payerResp || extractedClaim?.payerResp || '',
    ediBatchId: ocrClaim.ediBatchId || extractedClaim?.ediBatchId || '',
    totalBilled: currentAdj.totalBilled ?? null,
    totalNetPay: currentAdj.totalNetPay ?? null,
    serviceLines,
    adjudication: currentAdj,
    isReopened: ocrClaim.isReopened || false,
    reopenSequence: ocrClaim.reopenSequence || undefined,
    processingTime: formatDuration(ocrClaim.processingDurationSec ?? 0),
    websiteUrl: webUrl,
    softwareApp: getAppNameFromUrl(webUrl),
    imageSourceFile: imageFile,
    ocrEngine: ocrClaim.engineUsed || '',
    qualityScore: ocrClaim.qualityScore ?? null,
    category,
    operation,
    details,
    docType: ocrClaim.docType || ''
  }

  // One document per screenshot (keyed by screenshotEventId)
  await StructuredClaim.findOneAndUpdate(
    { screenshotEventId: ev._id },
    { $set: data },
    { upsert: true, new: true }
  )
}

/**
 * Extract and save claim from screenshot event
 * Improved deduplication: uses claimId as primary key, fingerprint as secondary
 * @param {string} eventId
 */
export async function extractClaimFromScreenshotEvent(eventId) {
  if (!eventId) return null

  const ev = await ScreenshotEvent.findById(eventId).lean()
  if (!ev || !ev.ocrProcessed) return null

  const ocrText = ev.ocrText || ''
  const ocrStructured = ev.ocrStructured || null
  const engineUsed = ev.ocrEngine || 'tesseract'
  const ocrTags = Array.isArray(ev.ocrTags) ? ev.ocrTags : []
  // Page URL for claim ID extraction (path /claim/ID or query param); fallback to cloudinary for display
  let url = null
  const rawPageUrl = ev.data?.url ?? ev.data?.pageUrl ?? ev.data?.sourceUrl
  if (rawPageUrl && typeof rawPageUrl === 'string' && !rawPageUrl.startsWith('data:')) {
    url = rawPageUrl
  }
  if (!url && ev.data?.cloudinaryUrl) {
    url = typeof ev.data.cloudinaryUrl === 'string' ? ev.data.cloudinaryUrl : String(ev.data.cloudinaryUrl)
  }
  const projectId = ev.projectId || 'discovery-ai'
  const trackerUserId = ev.userId

  if (!ocrText || ocrText.trim().length < 10) {
    console.log(`[TagsEngine] Skipping event ${eventId}: insufficient OCR text`)
    return null
  }

  // Extract structured data using intelligent extractor (ocrStructured = exact line/section data from screenshot)
  const extracted = extractor.extract(ocrText, url, ocrTags, ocrStructured)
  let claim = extractor.buildClaim(extracted, ev)

  const unsetExtractedClaimId = () =>
    ScreenshotEvent.findByIdAndUpdate(eventId, { $unset: { extractedClaimId: 1 } }).catch(() => {})

  // Don't extract or persist claim data when there is no claim ID (e.g. YouTube, Google, non-claim pages)
  if (!claim || (!claim.claimId && !claim.ediClaimId)) {
    await unsetExtractedClaimId()
    return null
  }

  // Don't extract claim data from list/multi-claim pages, unknown pages, or when multiple claim IDs are present
  // (e.g. YouTube, claims dashboard, Google search about claims — no claim data should be stored)
  const docType = (extracted.docType || '').toLowerCase()
  if (docType === 'dashboard' || docType === 'claims_queue' || docType === 'unknown') {
    await unsetExtractedClaimId()
    return null
  }
  const recentCount = extracted.recentClaims?.length ?? 0
  const queueCount = extracted.claimsQueue?.length ?? 0
  if (recentCount > 1 || queueCount > 1) {
    await unsetExtractedClaimId()
    return null
  }

  // Optional: enrich with LLM (Ollama) for smarter extraction across different claim UIs
  try {
    const llmResult = await extractClaimWithLlm(ocrText, { timeoutMs: 15000 })
    if (llmResult) claim = mergeLlmIntoClaim(claim, llmResult)
  } catch (_) {}

  const fingerprint = buildFingerprint({ ocrText, ocrTags, url })
  const qualityScore = heuristicQualityScore(ocrText)
  const ts = ev.ts ? new Date(ev.ts) : new Date()
  const tsMs = ts.getTime()
  const linkId = claim.claimId || claim.ediClaimId

  // Helper: update MUTABLE field (status, assignedTo, etc.) — always overwrites with valid new value
  // Used for fields the user can change on the page
  const updateField = (obj, key, value) => {
    if (value != null && value !== '' && !isNoise(String(value))) {
      obj[key] = value
    }
  }
  // Helper: update IDENTITY field (patientName, memberId, providerName) — only fills gaps
  // These don't change; preserve the first good extraction
  const fillField = (obj, key, value) => {
    if (value != null && value !== '' && !isNoise(String(value))) {
      if (!obj[key] || isNoise(String(obj[key]))) obj[key] = value
    }
  }

  // Find all docs for this claim (by claimId or ediClaimId); most recent first
  const claimQuery = claim.claimId
    ? { claimId: claim.claimId }
    : { ediClaimId: claim.ediClaimId }
  const sameClaimDocs = await OcrClaim.find(claimQuery).sort({ lastSeenTs: -1 }).lean()
  const lastDoc = sameClaimDocs[0] || null
  const lastSeenMs = lastDoc?.lastSeenTs ? new Date(lastDoc.lastSeenTs).getTime() : 0
  const isReopen = lastDoc != null && (tsMs - lastSeenMs > REOPEN_THRESHOLD_MS)
  // Doc to merge into: most recent whose lastSeenTs is within threshold of this event
  const existingSameSession = sameClaimDocs.find(d =>
    d.lastSeenTs && (tsMs - new Date(d.lastSeenTs).getTime() <= REOPEN_THRESHOLD_MS)
  )
  const existing = !isReopen && existingSameSession ? await OcrClaim.findById(existingSameSession._id) : null

  // Status: use extracted, normalized to canonical form (e.g. "1 : APPROVED" → "1 APPROVED")
  const rawStatus = claim.status ?? (sameClaimDocs[0]?.status) ?? ''
  const initialStatus = rawStatus ? (normalizeWorkflowStatus(rawStatus) || rawStatus) : ''

  function createNewClaimDoc(reopen = false, reopenSeq = 1) {
    return OcrClaim.create({
      screenshotEventId: ev._id,
      projectId,
      trackerUserId,
      fingerprint,
      claimId: claim.claimId,
      ediClaimId: claim.ediClaimId || null,
      authRefStatus: claim.authRefStatus || null,
      claimType: isNoise(claim.claimType) ? null : claim.claimType,
      status: initialStatus,
      priority: claim.priority || null,
      companyId: claim.companyId || null,
      serviceDateFrom: claim.serviceDateFrom || null,
      ediBatchId: claim.ediBatchId || null,
      placeOfService: claim.placeOfService || null,
      facility: claim.facility || null,
      outcome: claim.outcome || null,
      payerResp: claim.payerResp || null,
      primaryDiagnosis: claim.primaryDiagnosis || null,
      authReferralNums: claim.authReferralNums || [],
      gender: claim.gender || null,
      providerId: claim.providerId || null,
      providerName: isNoise(claim.providerName) ? null : claim.providerName,
      patientName: isNoise(claim.patientName) ? null : claim.patientName,
      memberId: isNoise(claim.memberId) ? null : claim.memberId,
      receivedDate: claim.receivedDate,
      dob: claim.dob,
      sourceUrl: claim.sourceUrl,
      sourcePath: ev.data?.path || null,
      docType: claim.docType,
      origin: claim.origin,
      assignedTo: claim.assignedTo,
      engineUsed: engineUsed,
      qualityScore,
      ocrText,
      ocrTags,
      serviceDetails: claim.serviceDetails || [],
      adjudication: claim.adjudication || {},
      firstSeenTs: ts,
      lastSeenTs: ts,
      processingDurationSec: 0,
      isReopened: reopen,
      reopenSequence: reopen ? reopenSeq : undefined,
      statusHistory: [{ status: initialStatus, timestamp: ts, screenshotEventId: ev._id }]
    })
  }

  if (isReopen) {
    const reopenSequence = sameClaimDocs.length + 1
    const newClaim = await createNewClaimDoc(true, reopenSequence)
    await ScreenshotEvent.findByIdAndUpdate(ev._id, { extractedClaimId: linkId }).catch(() => {})
    await upsertStructuredClaim(newClaim, ev, claim).catch(e => console.warn('[TagsEngine] structured_claims upsert error:', e.message))
    console.log(`[TagsEngine] Reopen #${reopenSequence} for claim ${claim.claimId || claim.ediClaimId} from event ${eventId}`)
    return newClaim
  }

  if (!existing) {
    const newClaim = await createNewClaimDoc(false)
    await ScreenshotEvent.findByIdAndUpdate(ev._id, { extractedClaimId: linkId }).catch(() => {})
    await upsertStructuredClaim(newClaim, ev, claim).catch(e => console.warn('[TagsEngine] structured_claims upsert error:', e.message))
    console.log(`[TagsEngine] Created new claim ${claim.claimId || claim.ediClaimId} from event ${eventId}`)
    return newClaim
  }

  const firstSeenTs = existing.firstSeenTs && new Date(existing.firstSeenTs) < ts ? existing.firstSeenTs : ts
  const lastSeenTs = existing.lastSeenTs && new Date(existing.lastSeenTs) > ts ? existing.lastSeenTs : ts
  const processingDurationSec = Math.max(0, Math.round((new Date(lastSeenTs).getTime() - new Date(firstSeenTs).getTime()) / 1000))

  // Sanitize provider fields before persisting: name must be alphabetic, ID must be numeric
  let cleanProvName = claim.providerName || null
  let cleanProvId = claim.providerId || null
  if (cleanProvName) {
    cleanProvName = cleanProvName.replace(/\b\d{6,}\b/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (cleanProvId) cleanProvName = cleanProvName.replace(cleanProvId, '').replace(/\s{2,}/g, ' ').trim()
    if (/^\d+$/.test(cleanProvName) || cleanProvName.length < 2) cleanProvName = null
  }
  if (cleanProvId) {
    cleanProvId = cleanProvId.replace(/\D/g, '')
    if (cleanProvId.length < 6) cleanProvId = null
  }

  // If existing providerName contains digits that look like an ID, fix it
  if (existing.providerName && /\b\d{6,}\b/.test(existing.providerName)) {
    let fixed = existing.providerName.replace(/\b\d{6,}\b/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (fixed.length >= 2 && /[A-Za-z]/.test(fixed)) {
      existing.providerName = fixed
    } else {
      existing.providerName = null
    }
  }
  // If existing providerId contains letters, fix it
  if (existing.providerId && /[A-Za-z]/.test(existing.providerId)) {
    const digits = existing.providerId.replace(/\D/g, '')
    existing.providerId = digits.length >= 6 ? digits : null
  }

  // Identity fields: preserve first good value (these don't change on the page)
  fillField(existing, 'providerName', cleanProvName)
  fillField(existing, 'patientName', claim.patientName)
  fillField(existing, 'memberId', claim.memberId)
  fillField(existing, 'providerId', cleanProvId)
  fillField(existing, 'gender', claim.gender)
  fillField(existing, 'companyId', claim.companyId)
  fillField(existing, 'primaryDiagnosis', claim.primaryDiagnosis)
  fillField(existing, 'placeOfService', claim.placeOfService)
  fillField(existing, 'facility', claim.facility)
  fillField(existing, 'outcome', claim.outcome)
  fillField(existing, 'payerResp', claim.payerResp)
  fillField(existing, 'ediBatchId', claim.ediBatchId)
  fillField(existing, 'serviceDateFrom', claim.serviceDateFrom)
  if (!existing.receivedDate && claim.receivedDate) existing.receivedDate = claim.receivedDate
  if (!existing.dob && claim.dob) existing.dob = claim.dob
  if (!existing.ediClaimId && claim.ediClaimId) existing.ediClaimId = claim.ediClaimId
  if (!existing.claimType || isNoise(String(existing.claimType))) {
    fillField(existing, 'claimType', claim.claimType)
  }
  if (claim.authReferralNums?.length > 0 && (!existing.authReferralNums || existing.authReferralNums.length === 0)) {
    existing.authReferralNums = claim.authReferralNums
  }

  // Mutable fields: use extracted status, normalized to canonical form (e.g. "2 : PENDING REVIEW" → "2 PENDING REVIEW")
  if (claim.status != null && claim.status !== '') {
    const normalized = normalizeWorkflowStatus(claim.status) || claim.status
    const prevStatus = existing.status
    existing.status = normalized
    if (normalized !== prevStatus) {
      if (!Array.isArray(existing.statusHistory)) existing.statusHistory = []
      existing.statusHistory.push({ status: normalized, timestamp: ts, screenshotEventId: ev._id })
    }
  }
  updateField(existing, 'authRefStatus', claim.authRefStatus)
  updateField(existing, 'assignedTo', claim.assignedTo)
  if (claim.priority) existing.priority = claim.priority
  if (claim.sourceUrl) existing.sourceUrl = claim.sourceUrl
  if (claim.docType && claim.docType !== 'unknown') existing.docType = claim.docType

  existing.serviceDetails = mergeServiceDetails([
    existing.serviceDetails || [],
    claim.serviceDetails || []
  ])
  existing.adjudication = mergeAdjudication([existing.adjudication || {}, claim.adjudication || {}])

  existing.firstSeenTs = firstSeenTs
  existing.lastSeenTs = lastSeenTs
  existing.processingDurationSec = processingDurationSec

  if (ocrText && ocrText.length > (existing.ocrText || '').length) {
    existing.ocrText = ocrText
  }
  existing.engineUsed = engineUsed
  if (ocrTags && ocrTags.length > 0) {
    const merged = new Set([...(existing.ocrTags || []), ...ocrTags])
    existing.ocrTags = Array.from(merged)
  }
  existing.qualityScore = Math.max(qualityScore, existing.qualityScore || 0)

  await existing.save()
  await ScreenshotEvent.findByIdAndUpdate(ev._id, { extractedClaimId: linkId }).catch(() => {})
  await upsertStructuredClaim(existing, ev, claim).catch(e => console.warn('[TagsEngine] structured_claims upsert error:', e.message))
  console.log(`[TagsEngine] Updated claim ${claim.claimId || claim.ediClaimId} (duration: ${processingDurationSec}s)`)
  return existing
}

