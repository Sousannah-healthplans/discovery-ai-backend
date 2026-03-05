/**
 * Intelligent claim extractor that adapts to different claim website structures
 * Routes to specialized extractors based on detected page type
 */

import { ClaimDetailExtractor } from './extractors/claimDetailExtractor.js'
import { PolicyVerificationExtractor } from './extractors/policyVerificationExtractor.js'
import { AdjudicationExtractor } from './extractors/adjudicationExtractor.js'
import { BaseExtractor } from './extractors/baseExtractor.js'
import { getClaimIdFromUrl, sanitizePersonName, sanitizeProviderName } from './claimRegexPatterns.js'

export class IntelligentExtractor extends BaseExtractor {
  constructor() {
    super()
    this.extractors = {
      claim_detail: new ClaimDetailExtractor(),
      policy_verification: new PolicyVerificationExtractor(),
      adjudication: new AdjudicationExtractor()
    }
  }

  /**
   * Detect document type from OCR text and URL.
   * Priority: explicit page title > URL-based hints > keyword frequency analysis.
   */
  detectDocType(ocrText, url) {
    const text = this.normalizeWhitespace(ocrText).toLowerCase()
    const urlLower = (url || '').toLowerCase()

    // 1. CuraMind explicit page title: "CuraMind Claim Detail", "CuraMind Adjudication", etc.
    //    The prefix is required so sidebar nav items like "Dashboard" don't cause false matches.
    const curaMindTitle = text.match(/(?:curamind|cura\s*mind)\s+(claim\s*detail|adjudication|policy\s*verification|claims?\s*queue|dashboard)\b/i)
    if (curaMindTitle) {
      const title = curaMindTitle[1].toLowerCase().replace(/\s+/g, ' ')
      if (title.includes('claim') && title.includes('detail')) return 'claim_detail'
      if (title === 'adjudication') return 'adjudication'
      if (title.includes('policy')) return 'policy_verification'
      if (title.includes('queue')) return 'claims_queue'
      if (title === 'dashboard') return 'dashboard'
    }

    // 2. URL-based page type detection (path segments like /adjudication, /policy, /detail)
    if (urlLower) {
      if (/\/policy[-_]?verif/i.test(urlLower)) return 'policy_verification'
      if (/\/adjudication/i.test(urlLower)) return 'adjudication'
      if (/\/dashboard/i.test(urlLower)) return 'dashboard'
      if (/\/queue/i.test(urlLower)) return 'claims_queue'
    }

    if (text.includes('policy verification') || text.includes('no policy found')) {
      return 'policy_verification'
    }
    if (text.includes('dashboard') && text.includes('recent claims')) {
      return 'dashboard'
    }
    if (text.includes('claims queue') && !text.includes('claim information') && !text.includes('professional claim')) {
      return 'claims_queue'
    }

    // 3. Keyword frequency analysis (fallback)
    const hasAdjudication = text.includes('adjudication') || text.includes('total amount calculation')
    const hasClaimHeaders = text.includes('claim information') || text.includes('professional claim') ||
      text.includes('claim pg') || text.includes('claim detail')
    const hasClaimUrl = urlLower.includes('/claim/')

    if (hasAdjudication) {
      const adjCount = (text.match(/billed\s*amount|allowed\s*amount|deductible|payable|copay|coinsurance|net\s*pay|contract\s*amount/gi) || []).length
      const claimInfoCount = (text.match(/patient\s*name|member\s*id|claim\s*status|received\s*date|claim\s*type|assigned\s*to|date\s*of\s*birth/gi) || []).length
      if (adjCount >= 3 && adjCount > claimInfoCount) {
        return 'adjudication'
      }
      if (hasClaimHeaders || hasClaimUrl) {
        return 'claim_detail'
      }
      return 'adjudication'
    }

    if (hasClaimHeaders || hasClaimUrl || text.includes('patient name') || text.includes('member id') ||
      text.includes('claim status') || text.includes('received date')) {
      return 'claim_detail'
    }

    const claimIdMatch = (ocrText || '').match(this.claimRe)
    if (claimIdMatch) return 'claim_detail'

    return 'unknown'
  }

  /**
   * Extract structured claim data from OCR text (and optional structured OCR for exact line/section data)
   * Routes to appropriate specialized extractor
   */
  extract(ocrText, url, ocrTags = [], ocrStructured = null) {
    const docType = this.detectDocType(ocrText, url)
    // Always use ClaimDetailExtractor for claim-related pages (it handles adjudication data too)
    // Only use specialized extractors for truly different page types (policy_verification)
    const extractor = docType === 'policy_verification'
      ? this.extractors.policy_verification
      : this.extractors.claim_detail

    // Run extractor (pass ocrStructured when available for exact claim data from screenshot)
    const extracted = extractor.extract(ocrText, url, ocrTags, ocrStructured)
    extracted.docType = docType

    // Merge common fields
    const result = {
      docType: extracted.docType || docType,
      claimId: extracted.claimId,
      claimInfo: extracted.claimInfo || {},
      patientInfo: extracted.patientInfo || {},
      providerInfo: extracted.providerInfo || {},
      serviceDetails: extracted.serviceDetails || [],
      adjudication: extracted.adjudication || {},
      recentClaims: extracted.recentClaims || [],
      claimsQueue: extracted.claimsQueue || []
    }

    // Extract URL if not already set
    if (!result.claimInfo.url) {
      const urlMatch = ocrText.match(this.urlRe)
      if (urlMatch) {
        result.claimInfo.url = urlMatch[0]
      } else if (url) {
        result.claimInfo.url = url
      }
    }

    // Extract emails
    const emails = this.extractAll(ocrText, this.emailRe)
    if (emails.length) {
      result.claimInfo.emails = emails
    }

    return result
  }

  /**
   * Build a normalized claim object from extracted data
   * Merges data from multiple sources (claim info, patient info, provider info)
   */
  buildClaim(extracted, screenshotEvent) {
    let claimId = extracted.claimId || null
    const ediClaimId = extracted.claimInfo?.ediClaimId || null
    // Fallback: get Professional Claim ID from URL (event data or OCR-captured) when OCR didn't provide it
    if (!claimId && screenshotEvent?.data) {
      const urlCandidate =
        screenshotEvent.data.url ??
        screenshotEvent.data.pageUrl ??
        screenshotEvent.data.sourceUrl ??
        extracted.claimInfo?.url
      if (urlCandidate && typeof urlCandidate === 'string' && !urlCandidate.startsWith('data:')) {
        const fromUrl = getClaimIdFromUrl(urlCandidate)
        if (fromUrl) claimId = fromUrl
      }
    }
    // Never use EDI Claim # as Professional Claim ID: if they match, clear claimId
    if (claimId && ediClaimId && String(claimId).trim() === String(ediClaimId).trim()) {
      claimId = null
    }
    if (!claimId && !ediClaimId) return null

    let providerName = extracted.providerInfo.providerName || null
    let providerId = extracted.providerInfo?.providerId || null

    // Clean provider ID: extract only digits, require 6-10 digits
    if (providerId) {
      const idDigits = providerId.replace(/\D/g, '')
      providerId = (idDigits.length >= 6 && idDigits.length <= 15) ? idDigits : null
    }

    if (providerName) {
      // Remove noise: @, ID, NPI, TIN, 6+ digit IDs (keeps commas)
      providerName = sanitizeProviderName(providerName)
      // If provider ID is known, remove it from the name
      if (providerId && providerName && providerName.includes(providerId)) {
        providerName = providerName.replace(new RegExp(providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/\s{2,}/g, ' ').trim()
      }
      providerName = providerName ? sanitizePersonName(providerName) : null
      // Reject if: purely numeric, too short
      if (providerName.length < 2 || /^\d+$/.test(providerName)) providerName = null
      // Only reject when the entire value is exactly a single noise label (e.g. "Service"), not "Service Medical Group"
      if (providerName && /^(?:Service|CPT|Date|Billed|Allowed|Total|Amount|Code|Claim|Patient|Member|Name|ID|NPI|TIN|Provider|Information|Details)$/i.test(providerName.trim())) {
        providerName = null
      }
    }

    // Cross-validate: if providerName is still just the ID, clear it
    if (providerName && providerId && providerName.replace(/\D/g, '') === providerId) {
      providerName = null
    }
    // If providerId ended up with letters, it's not a valid ID
    if (providerId && /[A-Za-z]/.test(providerId)) {
      providerId = null
    }

    // Patient name: if extractor missed it, try broad fallback from raw OCR text
    let patientName = extracted.patientInfo.patientName || null
    if (!patientName && screenshotEvent?.ocrText) {
      const ocrText = screenshotEvent.ocrText
      const broadPatientRe = /(?:Patient\s*Name|Member\s*Name)\s*[:\-]?\s*([A-Z][A-Za-z]+(?:[,\s]+[A-Z][A-Za-z]+)+)/i
      const m = ocrText.match(broadPatientRe)
      if (m && m[1] && m[1].length >= 4 && m[1].length <= 60) {
        patientName = sanitizePersonName(m[1].trim())
      }
    }
    // Fallback: look for "LAST, FIRST" near Member ID (common layout where name follows the ID value)
    if (!patientName && screenshotEvent?.ocrText) {
      const ocrText = screenshotEvent.ocrText
      const memberIdNameRe = /Member\s*ID\s*[:\-]?\s*[A-Z]?\s*\d{6,}\s+([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/i
      const lines = ocrText.split(/\r?\n/)
      for (const line of lines) {
        if (!/Member\s*ID/i.test(line) || /Company\s*ID/i.test(line)) continue
        const m = line.match(memberIdNameRe)
        if (m && m[1] && m[1].length >= 4 && m[1].length <= 60) {
          patientName = sanitizePersonName(m[1].trim())
          if (patientName && patientName.length >= 4) break
        }
      }
    }

    // Merge data from different sections
    const claim = {
      claimId,
      ediClaimId,
      claimType: extracted.claimInfo.claimType || null,
      status: extracted.claimInfo.status || null,
      assignedTo: extracted.claimInfo.assignedTo || null,
      authRefStatus: extracted.claimInfo?.authRefStatus || null,
      priority: extracted.claimInfo?.priority || null,
      companyId: extracted.claimInfo?.companyId || null,
      serviceDateFrom: extracted.claimInfo?.serviceDateFrom || null,
      ediBatchId: extracted.claimInfo?.ediBatchId || null,
      placeOfService: extracted.claimInfo?.placeOfService || null,
      facility: extracted.claimInfo?.facility || null,
      outcome: extracted.claimInfo?.outcome || null,
      payerResp: extracted.claimInfo?.payerResp || null,
      primaryDiagnosis: extracted.claimInfo?.primaryDiagnosis || null,
      authReferralNums: extracted.claimInfo?.authReferralNums || [],
      receivedDate: extracted.claimInfo.receivedDate ? this.parseDate(extracted.claimInfo.receivedDate) : null,
      patientName,
      dob: extracted.patientInfo.dob ? this.parseDate(extracted.patientInfo.dob) : null,
      memberId: extracted.patientInfo.memberId || null,
      gender: extracted.patientInfo?.gender || null,
      providerName,
      providerId,
      docType: extracted.docType,
      origin: this.determineOrigin(extracted),
      sourceUrl: extracted.claimInfo.url || screenshotEvent?.data?.url || null,
      serviceDetails: extracted.serviceDetails || [],
      adjudication: extracted.adjudication || {}
    }

    return claim
  }

  determineOrigin(extracted) {
    if (extracted.docType === 'adjudication') return 'adjudication'
    if (extracted.docType === 'policy_verification') return 'policy_verification'
    if (extracted.docType === 'claim_detail') return 'screen_detail'
    if (extracted.recentClaims?.length) return 'dashboard_recent'
    if (extracted.claimsQueue?.length) return 'queue_list'
    return 'unknown'
  }
}

