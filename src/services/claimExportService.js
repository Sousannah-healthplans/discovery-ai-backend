import fs from 'fs'
import path from 'path'
import Excel from 'exceljs'
import OcrClaim from '../models/OcrClaim.js'
import ScreenshotEvent from '../models/events/ScreenshotEvent.js'
import ExtensionUser from '../models/ExtensionUser.js'
import { sanitizeProviderName } from './tagsEngine/claimRegexPatterns.js'

function cleanProviderName(name, providerId) {
  if (!name || typeof name !== 'string') return ''
  let v = sanitizeProviderName(name)
  if (!v) return ''
  if (providerId) {
    const idStr = String(providerId).replace(/\D/g, '')
    if (idStr.length >= 6) v = v.replace(new RegExp(idStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/\s{2,}/g, ' ').trim()
  }
  if (/^\d+$/.test(v) || v.length < 2 || !/[A-Za-z]/.test(v)) return ''
  return v
}

function cleanProviderId(id) {
  if (!id || typeof id !== 'string') return ''
  const digits = id.replace(/\D/g, '')
  return digits.length >= 6 ? digits : ''
}

function fmtDate(d) {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`
}

function fmtTs(d) {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function esc(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r'))
    return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Format processing duration like frontend: "45s" or "2m 30s" */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

/** Derive app/software name from URL (e.g. lovable.app -> Lovable, youtube.com -> YouTube). */
function getAppNameFromUrl(url) {
  if (!url || typeof url !== 'string' || url.startsWith('data:')) return ''
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    const host = (u.hostname || '').toLowerCase().replace(/^www\./, '')
    if (!host) return ''
    const known = {
      'easy-claims-hub.lovable.app': 'CuraMind',
      'lovable.app': 'Lovable',
      'lovable.dev': 'Lovable',
      'youtube.com': 'YouTube',
      'www.youtube.com': 'YouTube',
      'youtu.be': 'YouTube',
      'google.com': 'Google',
      'www.google.com': 'Google',
      'github.com': 'GitHub',
      'www.github.com': 'GitHub',
      'facebook.com': 'Facebook',
      'www.facebook.com': 'Facebook',
      'twitter.com': 'Twitter',
      'x.com': 'X',
      'linkedin.com': 'LinkedIn',
      'www.linkedin.com': 'LinkedIn',
      'outlook.office.com': 'Outlook',
      'outlook.live.com': 'Outlook',
      'mail.google.com': 'Gmail',
      'drive.google.com': 'Google Drive',
      'docs.google.com': 'Google Docs',
      'sheets.google.com': 'Google Sheets',
      'slack.com': 'Slack',
      'teams.microsoft.com': 'Microsoft Teams',
      'zoom.us': 'Zoom',
      'app.zoom.us': 'Zoom',
      'notion.so': 'Notion',
      'figma.com': 'Figma',
      'vercel.app': 'Vercel',
      'netlify.app': 'Netlify'
    }
    if (known[host]) return known[host]
    const base = host.split('.')[0]
    if (base) return base.charAt(0).toUpperCase() + base.slice(1)
    return host
  } catch {
    return ''
  }
}

const HEADERS = [
  'User_Id',
  'User_email',
  'Claim ID',
  'Claim EDI',
  'received_date',
  'status',
  'Status History',
  'Auth/Ref Status',
  'assigned_to',
  'claim_type',
  'patient_name',
  'member_id',
  'DOB',
  'Priority',
  'provider_name',
  'provider_id',
  'total_billed',
  'total_net_pay',
  'Timestamp_start',
  'Timestamp_end',
  'image_source_file',
  'website_url',
  'Software/App being Used',
  'csv_file_path',
  'when_last_updated',
  'OCR - engine_used',
  'OCR-quality_score_0_100',
  'json_file',
  'json_source_path',
  'doctype',
  'Category',
  'Operation',
  'Details',
  'Capture reason',
  'Screenshot ID'
]

const UNIQUE_CLAIMS_HEADERS = [
  'Claim ID',
  'Reopened',
  'Status',
  'Status History',
  'Type',
  'Provider',
  'Provider ID',
  'Patient',
  'Member ID',
  'DOB',
  'Priority',
  'doctype',
  'Total Billed',
  'Total Net Pay',
  'Received',
  'Processing Time'
]

/**
 * Category, Operation, Details — how they are derived (not raw regex fields):
 *
 * - Category: From claim.docType (set during extraction). The intelligent extractor
 *   detects document type (e.g. claim_detail, adjudication, policy_verification,
 *   dashboard) from OCR text/URL. Default "Review & Approval" if missing.
 *
 * - Operation: Derived from claim.status and claim.origin:
 *   - If status is set and not "Needs Review" → use status (e.g. "Reject", "Paid", "Voided Claim").
 *   - Else if origin contains "detail" (e.g. screen_detail) → "Review".
 *   - Else → "Extract doc".
 *
 * - Details: A single summary line: "Category → Operation for claim <claimId>".
 *   Example: "Review & Approval → Reject for claim 56900".
 */
function getCategoryOperationDetails(claim) {
  const dt = (claim.docType || '').toLowerCase()
  let category = 'Review & Approval'
  if (dt === 'claim_detail') category = 'Claim Detail'
  else if (dt === 'adjudication') category = 'Adjudication'
  else if (dt === 'policy_verification') category = 'Policy Verification'
  else if (dt === 'dashboard') category = 'Dashboard'
  else if (dt === 'claims_queue') category = 'Claims Queue'
  else if (claim.docType) category = claim.docType

  // URL-based override: use path segments for more accurate category when docType is generic
  if (claim.sourceUrl && (category === 'Review & Approval' || dt === 'claim_detail')) {
    const urlLow = (claim.sourceUrl || '').toLowerCase()
    if (/\/policy[-_]?verif/i.test(urlLow)) category = 'Policy Verification'
    else if (/\/adjudication/i.test(urlLow)) category = 'Adjudication'
    else if (/\/dashboard/i.test(urlLow)) category = 'Dashboard'
    else if (/\/queue/i.test(urlLow)) category = 'Claims Queue'
  }

  let operation = ''
  if (claim.status && claim.status !== 'Needs Review') {
    operation = claim.status
  } else if (claim.origin && claim.origin.includes('detail')) {
    operation = 'Review'
  } else {
    operation = 'Extract doc'
  }
  const details = claim.claimId
    ? `${category} \u2192 ${operation} for claim ${claim.claimId}`
    : ''
  return { category, operation, details }
}

/** Format statusHistory array as a readable string: "Needs Review (02/18 15:46) → Voided (02/18 17:28)" */
function formatStatusHistory(statusHistory) {
  if (!Array.isArray(statusHistory) || statusHistory.length === 0) return ''
  return statusHistory.map(h => {
    const ts = h.timestamp ? fmtTs(h.timestamp) : ''
    return ts ? `${h.status} (${ts})` : h.status
  }).join(' → ')
}

/** Find the status that was current at a given timestamp from the statusHistory. */
function statusAtTime(statusHistory, ts) {
  if (!Array.isArray(statusHistory) || statusHistory.length === 0) return null
  const tsMs = ts ? new Date(ts).getTime() : 0
  let current = statusHistory[0]?.status || null
  for (const entry of statusHistory) {
    const entryMs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    if (entryMs <= tsMs) current = entry.status
    else break
  }
  return current
}

/** Returns raw values for one screenshot row (includes Capture reason from data.reason). claim may be null; then claim fields are empty. Software/App from URL. */
function buildRowValues(claim, ev, trackerId, tsEndOverride, nameByTracker, emailByTracker, idByTracker = new Map()) {
  const mongoUserId = (ev?.extensionUserId != null ? String(ev.extensionUserId) : null) || idByTracker.get(trackerId) || ''
  const userEmail = emailByTracker.get(trackerId) || ''
  const assignedTo = userEmail || nameByTracker.get(trackerId) || trackerId
  const tsStart = ev?.ts != null ? new Date(ev.ts) : (claim?.firstSeenTs ? new Date(claim.firstSeenTs) : null)
  const tsEnd = tsEndOverride != null ? new Date(tsEndOverride) : (claim?.lastSeenTs ? new Date(claim.lastSeenTs) : tsStart)
  let imageFile = ''
  if (ev?.data?.cloudinaryUrl && typeof ev.data.cloudinaryUrl === 'string') imageFile = ev.data.cloudinaryUrl
  else if (ev?.data?.screenshotFilename) imageFile = ev.data.screenshotFilename
  const webUrl = ev?.data?.url && typeof ev.data.url === 'string' && !ev.data.url.startsWith('data:') ? ev.data.url : (claim?.sourceUrl || '')
  const softwareApp = getAppNameFromUrl(webUrl)
  const whenUpdated = claim?.updatedAt ? fmtTs(claim.updatedAt) : ''
  const ocrEngine = ev?.ocrEngine || claim?.engineUsed || ''
  const qualityScore = typeof claim?.qualityScore === 'number' ? claim.qualityScore : ''
  const screenshotId = ev?._id != null ? String(ev._id) : ''
  const jsonFile = ev?.data?.screenshotFilename ? ev.data.screenshotFilename + '.json' : ''
  const { category, operation, details } = claim ? getCategoryOperationDetails(claim) : { category: '', operation: '', details: '' }
  const docTypeStr = claim?.docType != null ? String(claim.docType) : ''
  const claimIdStr = claim?.claimId != null ? String(claim.claimId) : ''
  const ediClaimIdStr = claim?.ediClaimId != null ? String(claim.ediClaimId) : ''
  const captureReason = ev?.captureReason || (ev?.data?.reason != null ? String(ev.data.reason) : '') || ''
  // Show status at the time of this screenshot (from history) or fall back to claim's current status
  const evTs = ev?.ts ?? null
  const rowStatus = (claim?.statusHistory?.length > 0 && evTs)
    ? (statusAtTime(claim.statusHistory, evTs) || claim?.status || '')
    : (claim?.status || '')
  const statusHistoryStr = claim ? formatStatusHistory(claim.statusHistory) : ''
  const adj = claim?.adjudication || {}
  const totalBilled = adj.totalBilled ?? ''
  const totalNetPay = adj.totalNetPay ?? ''
  return [
    mongoUserId,
    userEmail,
    claimIdStr,
    ediClaimIdStr,
    claim ? fmtDate(claim.receivedDate) : '',
    rowStatus,
    statusHistoryStr,
    claim?.authRefStatus || '',
    assignedTo,
    claim?.claimType || '',
    claim?.patientName || '',
    claim?.memberId != null ? String(claim.memberId) : '',
    claim?.dob != null ? (typeof claim.dob === 'string' ? claim.dob : fmtDate(claim.dob)) : '',
    claim?.priority != null ? String(claim.priority) : '',
    cleanProviderName(claim?.providerName, claim?.providerId),
    cleanProviderId(claim?.providerId),
    totalBilled === '' ? '' : Number(totalBilled),
    totalNetPay === '' ? '' : Number(totalNetPay),
    fmtTs(tsStart),
    fmtTs(tsEnd),
    imageFile,
    webUrl,
    softwareApp,
    '',
    whenUpdated,
    ocrEngine,
    qualityScore === '' ? '' : Number(qualityScore),
    jsonFile,
    '',
    docTypeStr,
    category,
    operation,
    details,
    captureReason,
    screenshotId
  ]
}

/**
 * Build claimMap (by claimId/ediClaimId) and claimByScreenshotId.
 * Only screenshots with an explicit extractedClaimId get claim data.
 */
function buildClaimLookups(claims) {
  const claimMap = new Map()
  const claimByScreenshotId = new Map()
  for (const c of claims) {
    const id = c.claimId || c.ediClaimId || c._id?.toString()
    if (!id) continue
    const existing = claimMap.get(id)
    if (!existing) {
      claimMap.set(id, c)
    } else {
      const existTs = existing.updatedAt || existing.lastSeenTs
      const candTs = c.updatedAt || c.lastSeenTs
      if (candTs && (!existTs || new Date(candTs) > new Date(existTs)))
        claimMap.set(id, c)
    }
    if (c.ediClaimId) claimMap.set(String(c.ediClaimId), c)
    if (c.claimId) claimMap.set(String(c.claimId), c)
    if (c.screenshotEventId) claimByScreenshotId.set(String(c.screenshotEventId), c)
  }
  return { claimMap, claimByScreenshotId }
}

/**
 * Resolve the claim for a screenshot event.
 * Only associate claim data when the screenshot has an explicit extractedClaimId
 * (i.e. we confirmed this screenshot shows a single specific claim).
 * Screenshots without extractedClaimId (Google, YouTube, dashboards, etc.) get no claim data.
 */
function resolveClaimForEvent(ev, claimMap, claimByScreenshotId) {
  return (
    (ev?.extractedClaimId && claimMap.get(String(ev.extractedClaimId))) ||
    claimByScreenshotId.get(String(ev?._id)) ||
    null
  )
}

const EVENT_EXPORT_SELECT = '_id ts userId extensionUserId ocrEngine extractedClaimId captureReason data.cloudinaryUrl data.screenshotFilename data.url data.reason'

/**
 * Build CSV content with the exact columns (Claim ID, Claim EDI, Auth/Ref Status, etc.).
 * Exports ALL screenshots in scope (project), sorted by timestamp — one row per screenshot.
 * Claim-related screenshots get full claim data; non-claim screenshots (e.g. YouTube, other sites)
 * get a row with claim columns empty. Software/App column = app name from URL.
 */
export async function getClaimsCsvContent(query = {}) {
  const allEvents = await ScreenshotEvent.find(query).select(EVENT_EXPORT_SELECT).sort({ ts: 1 }).lean()
  const lines = [HEADERS.join(',')]
  if (allEvents.length === 0) {
    return { csvContent: '\uFEFF' + lines.join('\n'), count: 0 }
  }

  const claims = await OcrClaim.find(query).select('-ocrText -ocrTags').lean()
  const { claimMap, claimByScreenshotId } = buildClaimLookups(claims)

  const trackerIds = [...new Set(allEvents.map(e => e.userId).filter(Boolean))]
  const extUserIds = [...new Set(allEvents.map(e => e.extensionUserId).filter(Boolean))]
  const orClauses = [
    ...(trackerIds.length ? [{ trackerUserId: { $in: trackerIds } }] : []),
    ...(extUserIds.length ? [{ _id: { $in: extUserIds } }] : [])
  ]
  const extUsers = orClauses.length > 0
    ? await ExtensionUser.find({ $or: orClauses }).lean()
    : []
  const emailByTracker = new Map()
  const nameByTracker = new Map()
  const idByTracker = new Map()
  const userByObjId = new Map()
  for (const u of extUsers) {
    const email = u.email || u.username || ''
    const name = u.name || u.username || ''
    if (u.trackerUserId) {
      emailByTracker.set(u.trackerUserId, email)
      nameByTracker.set(u.trackerUserId, name)
      if (u._id != null) idByTracker.set(u.trackerUserId, String(u._id))
    }
    if (u._id) userByObjId.set(u._id.toString(), { email, name })
  }
  // Map old trackerUserIds from events via extensionUserId fallback
  for (const ev of allEvents) {
    if (ev.userId && !emailByTracker.has(ev.userId) && ev.extensionUserId) {
      const info = userByObjId.get(ev.extensionUserId.toString())
      if (info) {
        emailByTracker.set(ev.userId, info.email)
        nameByTracker.set(ev.userId, info.name)
      }
    }
  }

  const rowsForSort = []
  for (let i = 0; i < allEvents.length; i++) {
    const ev = allEvents[i]
    const nextEv = i < allEvents.length - 1 ? allEvents[i + 1] : null
    const tsEndOverride = nextEv?.ts ?? null
    const claim = resolveClaimForEvent(ev, claimMap, claimByScreenshotId)
    const trackerId = ev.userId || claim?.trackerUserId || ''
    const row = buildRowValues(claim, ev, trackerId, tsEndOverride, nameByTracker, emailByTracker, idByTracker)
    const ts = ev?.ts ?? 0
    rowsForSort.push({ ts, row: row.map((v) => esc(v)).join(',') })
  }
  rowsForSort.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  for (const { row } of rowsForSort) lines.push(row)

  return { csvContent: '\uFEFF' + lines.join('\n'), count: lines.length - 1 }
}

/**
 * Build a two-sheet Excel workbook: "Claim Screenshots" (25 cols, one row per screenshot)
 * and "Unique Claims" (same columns as frontend table). Returns buffer for .xlsx download.
 * All screenshots in scope, sorted by timestamp; non-claim rows have claim columns empty. Software/App from URL.
 */
export async function getClaimsExcelBuffer(query = {}) {
  const allEvents = await ScreenshotEvent.find(query).select(EVENT_EXPORT_SELECT).sort({ ts: 1 }).lean()
  const wb = new Excel.Workbook()
  const sh1 = wb.addWorksheet('Claim Screenshots', { views: [{ state: 'frozen', ySplit: 1 }] })
  const sh2 = wb.addWorksheet('Unique Claims', { views: [{ state: 'frozen', ySplit: 1 }] })
  sh1.addRow(HEADERS)
  sh2.addRow(UNIQUE_CLAIMS_HEADERS)
  // Claim ID and Claim EDI as text so mixed alphanumeric (e.g. 2511220892041240041F) are not converted
  sh1.getColumn(3).numFmt = '@'
  sh1.getColumn(4).numFmt = '@'
  sh2.getColumn(1).numFmt = '@'

  if (allEvents.length === 0) {
    return await wb.xlsx.writeBuffer()
  }

  const claims = await OcrClaim.find(query).select('-ocrText -ocrTags').lean()
  const { claimMap, claimByScreenshotId } = buildClaimLookups(claims)

  const trackerIds = [...new Set(allEvents.map(e => e.userId).filter(Boolean))]
  const extUserIds = [...new Set(allEvents.map(e => e.extensionUserId).filter(Boolean))]
  const orClauses2 = [
    ...(trackerIds.length ? [{ trackerUserId: { $in: trackerIds } }] : []),
    ...(extUserIds.length ? [{ _id: { $in: extUserIds } }] : [])
  ]
  const extUsers = orClauses2.length > 0
    ? await ExtensionUser.find({ $or: orClauses2 }).lean()
    : []
  const emailByTracker = new Map()
  const nameByTracker = new Map()
  const idByTracker = new Map()
  const userByObjId2 = new Map()
  for (const u of extUsers) {
    const email = u.email || u.username || ''
    const name = u.name || u.username || ''
    if (u.trackerUserId) {
      emailByTracker.set(u.trackerUserId, email)
      nameByTracker.set(u.trackerUserId, name)
      if (u._id != null) idByTracker.set(u.trackerUserId, String(u._id))
    }
    if (u._id) userByObjId2.set(u._id.toString(), { email, name })
  }
  for (const ev of allEvents) {
    if (ev.userId && !emailByTracker.has(ev.userId) && ev.extensionUserId) {
      const info = userByObjId2.get(ev.extensionUserId.toString())
      if (info) {
        emailByTracker.set(ev.userId, info.email)
        nameByTracker.set(ev.userId, info.name)
      }
    }
  }

  const screenshotRowsForSort = []
  for (let i = 0; i < allEvents.length; i++) {
    const ev = allEvents[i]
    const nextEv = i < allEvents.length - 1 ? allEvents[i + 1] : null
    const tsEndOverride = nextEv?.ts ?? null
    const claim = resolveClaimForEvent(ev, claimMap, claimByScreenshotId)
    const trackerId = ev.userId || claim?.trackerUserId || ''
    const row = buildRowValues(claim, ev, trackerId, tsEndOverride, nameByTracker, emailByTracker, idByTracker)
    screenshotRowsForSort.push({ ts: ev?.ts ?? 0, row })
  }
  screenshotRowsForSort.sort((a, b) => (a.ts || 0) - (b.ts || 0))

  for (const { row } of screenshotRowsForSort) {
    sh1.addRow(row)
  }

  const uniqueClaimsRows = claims.map((c) => {
    const adj = c.adjudication || {}
    const tb = adj.totalBilled ?? ''
    const tnp = adj.totalNetPay ?? ''
    const dobStr = c.dob != null ? (typeof c.dob === 'string' ? c.dob : fmtDate(c.dob)) : ''
    return [
      c.claimId != null ? String(c.claimId) : '',
      c.isReopened ? (c.reopenSequence ? `Reopen #${c.reopenSequence}` : 'Yes') : '',
      c.status ?? '',
      formatStatusHistory(c.statusHistory),
      (c.claimType || '').trim().slice(0, 30) || '—',
      cleanProviderName(c.providerName, c.providerId) || '—',
      cleanProviderId(c.providerId) || '—',
      (c.patientName || '').trim() || '—',
      (c.memberId || '').trim().slice(0, 20) || '—',
      dobStr || '—',
      (c.priority || '').trim() || '—',
      (c.docType || '').trim() || '—',
      tb === '' ? '' : Number(tb),
      tnp === '' ? '' : Number(tnp),
      c.receivedDate ? new Date(c.receivedDate).toLocaleDateString() : '',
      formatDuration(c.processingDurationSec ?? 0)
    ]
  })
  for (const r of uniqueClaimsRows) {
    sh2.addRow(r)
  }

  return await wb.xlsx.writeBuffer()
}

export async function exportClaimsToCsv(query = {}) {
  const { csvContent, count } = await getClaimsCsvContent(query)
  const exportDir = path.join(process.cwd(), 'exports')
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true })
  const filePath = path.join(exportDir, 'claims_export.csv')
  fs.writeFileSync(filePath, csvContent, 'utf8')
  return { filePath, count }
}
