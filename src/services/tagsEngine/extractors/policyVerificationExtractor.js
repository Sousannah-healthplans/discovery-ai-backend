/**
 * Extracts data from Policy Verification pages
 * Uses centralized regex from claimRegexPatterns.js
 */

import { BaseExtractor } from './baseExtractor.js'
import { PATTERNS, CLAIM_ID_STRICT_PATTERNS, normSpace, getClaimIdFromUrl } from '../claimRegexPatterns.js'

export class PolicyVerificationExtractor extends BaseExtractor {
  bestClaimId(cleanText) {
    for (const src of CLAIM_ID_STRICT_PATTERNS) {
      const m = cleanText.match(new RegExp(src, 'i'))
      if (m && m[1] && this.isPlausibleClaimId(m[1].trim())) return m[1].trim()
    }
    const m = cleanText.match(new RegExp(PATTERNS.claim_id, 'i'))
    if (m && m[1] && this.isPlausibleClaimId(m[1].trim())) return m[1].trim()
    return null
  }

  extract(ocrText, url, ocrTags = [], ocrStructured = null) {
    const text = this.normalizeWhitespace(ocrText)
    const lines = text.split(/\r?\n/).map(l => this.normalizeWhitespace(l)).filter(Boolean)

    const result = {
      docType: 'policy_verification',
      claimId: null,
      claimInfo: {},
      patientInfo: {},
      providerInfo: {},
      serviceDetails: []
    }

    result.claimId = this.bestClaimId(text) || getClaimIdFromUrl(url) || null

    const receivedRe = new RegExp(PATTERNS.received_date, 'i')
    const receivedMatch = text.match(receivedRe)
    if (receivedMatch && receivedMatch[1]) {
      result.claimInfo.receivedDate = normSpace(receivedMatch[1])
    }
    if (!result.claimInfo.receivedDate && result.claimId) {
      const receivedClaimRe = new RegExp(`Claim\\s*#?\\s*${result.claimId}\\s+Received\\s*:?\\s*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})`, 'i')
      const m = text.match(receivedClaimRe)
      if (m && m[1]) result.claimInfo.receivedDate = normSpace(m[1])
    }

    // Patient Information
    const patientName = this.findLabelValue(text, ['Name'])
    if (patientName) {
      result.patientInfo.patientName = patientName
    }

    const dob = this.findLabelValue(text, ['DOB'])
    if (dob) {
      result.patientInfo.dob = dob
    }

    const memberRe = new RegExp(PATTERNS.member_id, 'i')
    const memberMatch = text.match(memberRe)
    const memberId = (memberMatch && memberMatch[1] && memberMatch[1].trim()) ||
                     this.findLabelValue(text, ['Member ID', 'MemberID']) ||
                     this.extractPattern(text, this.memberRe)
    if (memberId) result.patientInfo.memberId = memberId

    // Provider Information
    const providerName = this.findLabelValue(text, ['Provider Information', 'Name'], { separator: /\n/ })
    if (providerName) {
      result.providerInfo.providerName = providerName
    }

    const dateOfService = this.findLabelValue(text, ['Date of Service'])
    if (dateOfService) {
      result.claimInfo.dateOfService = dateOfService
    }

    // Service Details table
    const serviceHeaderPattern = /Service\s+Date|CPT\s+Code|Billed\s+Amount/i
    let inServiceTable = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (serviceHeaderPattern.test(line)) {
        inServiceTable = true
        continue
      }
      if (inServiceTable) {
        if (line.toLowerCase().includes('total') || !line.trim()) {
          break
        }
        const dateMatch = line.match(this.dateRe)
        const cptMatch = line.match(/\b(\d{5}|[A-Z]\d{4})\b/)
        const amounts = [...line.matchAll(this.amountRe)]
        if (dateMatch && (cptMatch || amounts.length > 0)) {
          result.serviceDetails.push({
            serviceDate: dateMatch[1],
            cptCode: cptMatch ? cptMatch[1] : null,
            description: null,
            billedAmount: amounts[0] ? this.cleanMoney(amounts[0][1]) : null,
            allowedAmount: amounts[1] ? this.cleanMoney(amounts[1][1]) : null
          })
        }
      }
    }

    return result
  }
}

