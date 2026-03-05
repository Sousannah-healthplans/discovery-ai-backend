/**
 * Merges claim data from multiple OCR screens (same claimId).
 * Deduplicates service lines by (date, cptCode, billedAmount, allowedAmount) and preserves count.
 */

import { parseDate } from './textParser.js'

/**
 * Build a key for a service line to deduplicate. Include amounts so same CPT twice stays two rows.
 */
function serviceLineKey(s) {
  const date = s.serviceDate || ''
  const cpt = s.cptCode || ''
  const billed = (s.billedAmount != null) ? String(s.billedAmount) : ''
  const allowed = (s.allowedAmount != null) ? String(s.allowedAmount) : ''
  return `${date}|${cpt}|${billed}|${allowed}`
}

/**
 * Prefer line with description; else prefer more complete.
 */
function preferLine(a, b) {
  const aDesc = (a.description || '').trim().length
  const bDesc = (b.description || '').trim().length
  if (aDesc > bDesc) return a
  if (bDesc > aDesc) return b
  const aComplete = [a.serviceDate, a.cptCode, a.billedAmount, a.allowedAmount].filter(v => v != null).length
  const bComplete = [b.serviceDate, b.cptCode, b.billedAmount, b.allowedAmount].filter(v => v != null).length
  return bComplete >= aComplete ? b : a
}

/**
 * Merge service details: same key can appear multiple times (multiple lines with same CPT/amounts).
 * We preserve multiplicity by counting keys and building that many rows.
 */
export function mergeServiceDetails(arrays) {
  const countByKey = new Map()
  const bestByKey = new Map()
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue
    for (const s of arr) {
      const key = serviceLineKey(s)
      countByKey.set(key, (countByKey.get(key) || 0) + 1)
      if (!bestByKey.has(key)) bestByKey.set(key, s)
      else bestByKey.set(key, preferLine(bestByKey.get(key), s))
    }
  }
  const result = []
  for (const [key, count] of countByKey) {
    const line = bestByKey.get(key)
    for (let i = 0; i < count; i++) {
      result.push({ ...line })
    }
  }
  result.sort((a, b) => {
    const d = (a.serviceDate || '').localeCompare(b.serviceDate || '')
    if (d !== 0) return d
    return (a.cptCode || '').localeCompare(b.cptCode || '')
  })
  return result
}

/**
 * Merge adjudication: take non-null from any source.
 */
export function mergeAdjudication(adjudications) {
  const out = {}
  const keys = ['billedAmount', 'allowedAmount', 'deductible', 'payableAmount', 'totalBilled', 'totalNetPay']
  for (const a of adjudications) {
    if (!a || typeof a !== 'object') continue
    for (const k of keys) {
      if (a[k] != null && (out[k] == null || typeof a[k] === 'number')) {
        out[k] = a[k]
      }
    }
  }
  return out
}

/**
 * Merge multiple claim objects (same claimId) into one. Prefer non-empty scalar fields.
 */
export function mergeClaims(claimObjects) {
  if (!claimObjects || claimObjects.length === 0) return null
  const primary = claimObjects[0]
  const merged = {
    claimId: primary.claimId,
    ediClaimId: primary.ediClaimId,
    authRefStatus: primary.authRefStatus,
    claimType: primary.claimType,
    status: primary.status,
    priority: primary.priority,
    assignedTo: primary.assignedTo,
    providerName: primary.providerName,
    patientName: primary.patientName,
    memberId: primary.memberId,
    receivedDate: primary.receivedDate,
    dob: primary.dob,
    sourceUrl: primary.sourceUrl,
    docType: primary.docType,
    origin: primary.origin,
    firstSeenTs: primary.firstSeenTs,
    lastSeenTs: primary.lastSeenTs,
    processingDurationSec: primary.processingDurationSec,
    serviceDetails: [],
    adjudication: {},
    screenshots: [],
    allServiceDetails: [],
    allAdjudication: {},
    statusHistory: []
  }

  for (const c of claimObjects) {
    if (c.providerName && !merged.providerName) merged.providerName = c.providerName
    if (c.patientName && !merged.patientName) merged.patientName = c.patientName
    if (c.memberId && !merged.memberId) merged.memberId = c.memberId
    if (c.receivedDate && !merged.receivedDate) merged.receivedDate = c.receivedDate
    if (c.dob && !merged.dob) merged.dob = c.dob
    if (c.status && c.status !== 'Needs Review' && !merged.status) merged.status = c.status
    if (c.claimType && !merged.claimType) merged.claimType = c.claimType
    if (c.ediClaimId && !merged.ediClaimId) merged.ediClaimId = c.ediClaimId
    if (c.authRefStatus && !merged.authRefStatus) merged.authRefStatus = c.authRefStatus
    if (c.assignedTo && !merged.assignedTo) merged.assignedTo = c.assignedTo
    if (c.priority && !merged.priority) merged.priority = c.priority
    if (c.sourceUrl && !merged.sourceUrl) merged.sourceUrl = c.sourceUrl
    if (c.firstSeenTs && (!merged.firstSeenTs || new Date(c.firstSeenTs) < new Date(merged.firstSeenTs))) {
      merged.firstSeenTs = c.firstSeenTs
    }
    if (c.lastSeenTs && (!merged.lastSeenTs || new Date(c.lastSeenTs) > new Date(merged.lastSeenTs))) {
      merged.lastSeenTs = c.lastSeenTs
    }
  }
  if (merged.firstSeenTs && merged.lastSeenTs) {
    const first = new Date(merged.firstSeenTs).getTime()
    const last = new Date(merged.lastSeenTs).getTime()
    merged.processingDurationSec = Math.max(0, Math.round((last - first) / 1000))
  } else {
    const maxDur = Math.max(0, ...claimObjects.map(c => c.processingDurationSec ?? 0))
    merged.processingDurationSec = merged.processingDurationSec ?? maxDur
  }

  merged.allServiceDetails = mergeServiceDetails(claimObjects.map(c => c.serviceDetails || c.allServiceDetails || []))
  merged.serviceDetails = merged.allServiceDetails
  const adjList = claimObjects.map(c => c.adjudication || c.allAdjudication).filter(Boolean)
  merged.allAdjudication = mergeAdjudication(adjList)
  merged.adjudication = merged.allAdjudication
  // Merge status histories from all docs, deduplicated and sorted by timestamp
  const allHistory = []
  const seenStatusTs = new Set()
  for (const c of claimObjects) {
    if (Array.isArray(c.statusHistory)) {
      for (const h of c.statusHistory) {
        const key = `${h.status}|${h.timestamp ? new Date(h.timestamp).getTime() : 0}`
        if (!seenStatusTs.has(key)) {
          seenStatusTs.add(key)
          allHistory.push(h)
        }
      }
    }
  }
  allHistory.sort((a, b) => {
    const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return tA - tB
  })
  merged.statusHistory = allHistory

  merged.screenshots = claimObjects.map(c => ({
    screenshotEventId: c.screenshotEventId,
    docType: c.docType,
    origin: c.origin,
    sourceUrl: c.sourceUrl,
    firstSeenTs: c.firstSeenTs,
    lastSeenTs: c.lastSeenTs,
    ocrText: c.ocrText,
    ocrTags: c.ocrTags
  }))

  return merged
}
