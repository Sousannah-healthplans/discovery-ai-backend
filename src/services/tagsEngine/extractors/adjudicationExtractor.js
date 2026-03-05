/**
 * Extracts data from Adjudication pages
 * Uses centralized regex from claimRegexPatterns.js; line-by-line adjudication amounts
 */

import { BaseExtractor } from './baseExtractor.js'
import { CLAIM_ID_STRICT_PATTERNS, PATTERNS, getClaimIdFromUrl } from '../claimRegexPatterns.js'

export class AdjudicationExtractor extends BaseExtractor {
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

    const result = {
      docType: 'adjudication',
      claimId: null,
      claimInfo: {},
      patientInfo: {},
      adjudication: {}
    }

    result.claimId = this.bestClaimId(text) || getClaimIdFromUrl(url) || null

    const titleMatch = text.match(/Claim\s*#?\s*(\d+)\s*[-–]\s*([A-Za-z]+\s+[A-Za-z]+)/i)
    if (titleMatch) result.patientInfo.patientName = titleMatch[2].trim()

    // Line-by-line adjudication (AllowedAmount / Allowed Amount, Deductible, Payable)
    let billed = null, allowed = null, deductible = null, payable = null
    for (const line of text.split('\n')) {
      if (billed == null && /Billed\s*Amount\b/i.test(line)) {
        const m = line.match(/\$?\s*([-]?\d[\d,]*\.\d{2})/)
        if (m) billed = this.cleanMoney(m[1])
      }
      if (allowed == null && /Allowed\s*Amount\b|AllowedAmount\b/i.test(line)) {
        const m = line.match(/\$?\s*([-]?\d[\d,]*\.\d{2})/)
        if (m) allowed = this.cleanMoney(m[1])
      }
      if (deductible == null && /Deductible\b/i.test(line)) {
        const m = line.match(/(-?\$?\s*[\d,]*\.\d{2})/)
        if (m) deductible = this.cleanMoney(m[1])
      }
      if (payable == null && /Payable\s*Amount\b/i.test(line)) {
        const m = line.match(/\$?\s*([-]?\d[\d,]*\.\d{2})/)
        if (m) payable = this.cleanMoney(m[1])
      }
    }
    if (/Deductible\b[^\n\r]*[-]?\$?0\.00/i.test(text)) deductible = 0
    if (billed != null) result.adjudication.billedAmount = billed
    if (allowed != null) result.adjudication.allowedAmount = allowed
    if (deductible != null) result.adjudication.deductible = deductible
    if (payable != null) result.adjudication.payableAmount = payable

    const totalMatch = text.match(/\$([0-9]+(?:\.[0-9]{2})?)\s*(?:Billed|Total)/i)
    if (totalMatch && result.adjudication.billedAmount == null) {
      result.adjudication.billedAmount = this.cleanMoney(totalMatch[1])
    }

    return result
  }
}

