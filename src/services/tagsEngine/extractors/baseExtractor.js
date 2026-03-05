/**
 * Base extractor class for claim data extraction
 * Uses centralized regex from claimRegexPatterns.js (single source of truth for patterns)
 */

import {
  getClaimIdRegex,
  getMemberIdRegex,
  getReceivedDateRegex,
  getWorkflowStatusRegex,
  PATTERNS,
  AMOUNT_DOLLAR,
  normSpace,
  cleanMoney,
  normalizeWorkflowStatus,
  isPlausibleClaimId,
  looksLikeSectionHeader
} from '../claimRegexPatterns.js'

export class BaseExtractor {
  constructor() {
    this.claimRe = getClaimIdRegex()
    this.memberRe = getMemberIdRegex()
    this.receivedDateRe = new RegExp(PATTERNS.received_date, 'i')
    this.dateRe = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/
    this.amountRe = new RegExp(AMOUNT_DOLLAR, 'g')
    this.emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
    this.urlRe = /(?:https?:\/\/)?[\w.-]*(?:lovable\.app|[a-zA-Z0-9-]+\.(?:com|app|org|net|io|gov))\/[^\s\n]+/
    this.normSpace = normSpace
    this.cleanMoney = cleanMoney
    this.normalizeWorkflowStatus = normalizeWorkflowStatus
    this.isPlausibleClaimId = isPlausibleClaimId
    this.looksLikeSectionHeader = looksLikeSectionHeader
  }

  normalizeWhitespace(text) {
    return (text || '').toString().replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
  }

  parseDate(dateStr) {
    if (!dateStr) return null
    const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (!m) return null
    const mm = parseInt(m[1], 10)
    const dd = parseInt(m[2], 10)
    const yyyy = parseInt(m[3], 10)
    if (!mm || !dd || !yyyy) return null
    try {
      const d = new Date(yyyy, mm - 1, dd)
      return isNaN(d.getTime()) ? null : d
    } catch {
      return null
    }
  }

  extractPattern(text, pattern) {
    const m = (text || '').match(pattern)
    return m ? m[1] || m[0] : null
  }

  extractAll(text, pattern) {
    const matches = []
    let m
    const regex = new RegExp(pattern.source || pattern, pattern.flags || 'g')
    while ((m = regex.exec(text)) !== null) {
      matches.push(m[1] || m[0])
    }
    return matches
  }

  findLabelValue(text, labels, options = {}) {
    const lines = this.normalizeWhitespace(text).split(/\r?\n/)
    const caseSensitive = options.caseSensitive || false
    const separator = options.separator || /[:|\-]/
    const maxNextLines = options.maxNextLines || 1 // Only look at next N lines after label

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const label of labels) {
        const searchText = caseSensitive ? line : line.toLowerCase()
        const searchLabel = caseSensitive ? label : label.toLowerCase()
        const idx = searchText.indexOf(searchLabel)
        if (idx !== -1) {
          // Try same line first
          const after = line.slice(idx + label.length).trim()
          const parts = after.split(separator)
          let val = (parts[1] || parts[0] || '').trim()
          
          // If no value on same line, check next line(s)
          if (!val && maxNextLines > 0) {
            for (let j = 1; j <= maxNextLines && i + j < lines.length; j++) {
              const nextLine = lines[i + j].trim()
              // Stop if we hit another section header (all caps or common headers)
              if (nextLine.match(/^(Claim|Patient|Provider|Service|Member|Date|Status|Assigned)/i)) {
                break
              }
              if (nextLine && !nextLine.match(/^\d{5}$/) && !nextLine.match(/^\$\d/)) {
                val = nextLine.split(separator)[0].trim()
                if (val) break
              }
            }
          }
          
          // Clean up value - remove common noise
          if (val) {
            // Remove common prefixes/suffixes
            val = val.replace(/^(Information|Name|ID|Date|Status|Type|To)\s*/i, '')
            val = val.replace(/\s*(Information|Name|ID|Date|Status|Type|To)$/i, '')
            // Stop at common section boundaries
            val = val.split(/\s+(Claim|Patient|Provider|Service|Member|Date|Status|Assigned)/i)[0].trim()
            // Stop at dates (MM/DD/YYYY)
            val = val.split(/\s+\d{2}\/\d{2}\/\d{4}/)[0].trim()
            // Stop at MEM- patterns
            val = val.split(/\s+MEM-/i)[0].trim()
            // Stop at dollar amounts
            val = val.split(/\s+\$/)[0].trim()
            // Stop at CPT codes (5 digits)
            val = val.split(/\s+\d{5}\b/)[0].trim()
            
            if (val && val.length > 0 && val.length < 100) {
              return val
            }
          }
        }
      }
    }
    return null
  }

  findTableRow(lines, headerPattern, rowIndex = 1) {
    for (let i = 0; i < lines.length; i++) {
      if (headerPattern.test(lines[i]) && i + rowIndex < lines.length) {
        return lines[i + rowIndex]
      }
    }
    return null
  }
}

