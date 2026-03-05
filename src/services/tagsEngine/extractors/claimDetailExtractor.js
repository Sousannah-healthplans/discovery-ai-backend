/**
 * Extracts data from Claim Detail pages
 * Uses section-aware parsing and centralized regex from claimRegexPatterns.js
 */

import { BaseExtractor } from './baseExtractor.js'
import {
  getSectionText,
  truncateAtDelimiters,
  getLinesFromStructured,
  getSectionLinesFromStructured,
  getTextFromStructured
} from '../textParser.js'
import {
  PATTERNS,
  CLAIM_ID_STRICT_PATTERNS,
  getServiceLineMatrixRegex,
  getServiceLineMatrixProRegex,
  getTotalsLineRegex,
  getTotalBilledLabelRegex,
  getTotalNetPayLabelRegex,
  normSpace,
  getClaimIdFromUrl,
  cleanOcrNoise,
  stripLeadingNameNoise,
  fixStatusCodeOcr,
  sanitizePersonName,
  sanitizeProviderName
} from '../claimRegexPatterns.js'

const STATUS_BOUNDARY_RE = /\s+(?:Date\s+Received|Received\s+Date|Service\s+Date|Date\s+From|Auth\/|Claim\s+Type|General\s+Inform|Assigned\s+To|Priority|Member\s+ID|Provider\s+ID|Patient\s+Name|Company\s+ID|EDI\s+Claim|EDI\s+Batch|Place\s+of|Facility|Outcome|Payer\s+Resp|Birth\s+Date|Gender)\b.*$/i

function truncateStatusAtBoundary(st) {
  return st.replace(STATUS_BOUNDARY_RE, '').trim()
}

export class ClaimDetailExtractor extends BaseExtractor {
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
    // Prefer structured lines when available (exact data from screenshot layout)
    const rawLines = ocrStructured && ocrStructured.lines && ocrStructured.lines.length > 0
      ? getLinesFromStructured(ocrStructured)
      : this.normalizeWhitespace(ocrText).split(/\r?\n/).map(l => this.normalizeWhitespace(l)).filter(Boolean)
    const rawText = ocrStructured && ocrStructured.lines && ocrStructured.lines.length > 0
      ? getTextFromStructured(ocrStructured)
      : this.normalizeWhitespace(ocrText)
    // Clean OCR noise (UI artifacts: pipes, icons, brackets, garbled dividers) before extraction
    const text = cleanOcrNoise(rawText)
    const lines = rawLines.map(l => cleanOcrNoise(l))
    const tLow = text.toLowerCase()

    const result = {
      docType: 'claim_detail',
      claimId: null,
      claimInfo: {},
      patientInfo: {},
      providerInfo: {},
      serviceDetails: [],
      adjudication: {}
    }

    const professionalRe = new RegExp(PATTERNS.professional_claim_id, 'i')
    let professionalMatch = text.match(professionalRe)
    if (!professionalMatch && Array.isArray(lines)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (/^[0-9]{14,25}[A-Za-z]{0,5}$/.test(line)) {
          const prev = (lines[i - 1] || '').trim() + (lines[i - 2] || '').trim()
          if (/Professional\s*Claim/i.test(prev)) {
            professionalMatch = [null, line]
            break
          }
        }
      }
    }
    const ediRe = new RegExp(PATTERNS.edi_claim, 'i')
    const ediMatch = text.match(ediRe)
    // Claim ID from Professional Claim, URL, or best match from text (Claim #, Claim ID, etc.)
    result.claimId = (professionalMatch && professionalMatch[1] ? professionalMatch[1].trim() : null) ||
      getClaimIdFromUrl(url) ||
      this.bestClaimId(text) ||
      null
    if (ediMatch && ediMatch[1]) {
      result.claimInfo.ediClaimId = ediMatch[1].trim()
    }

    // Parse piped table rows from raw zone lines (header|value pairs common in table-layout UIs)
    const pipedFields = {}
    if (ocrStructured && ocrStructured.zones && typeof ocrStructured.zones === 'object') {
      const rawBody = Array.isArray(ocrStructured.zones.BODY) ? ocrStructured.zones.BODY : []
      const rawSidebar = Array.isArray(ocrStructured.zones.SIDEBAR) ? ocrStructured.zones.SIDEBAR : []
      for (const rawZoneLines of [rawBody, rawSidebar]) {
        for (let i = 0; i < rawZoneLines.length - 1; i++) {
          const headerLine = rawZoneLines[i]
          const dataLine = rawZoneLines[i + 1]
          if (!headerLine.includes('|') || !dataLine.includes('|')) continue
          if (!/[A-Za-z]{3,}/.test(headerLine)) continue
          const headers = headerLine.split(/\s*\|\s*/).map(h => h.trim()).filter(Boolean)
          const values = dataLine.split(/\s*\|\s*/).map(v => v.trim()).filter(Boolean)
          for (let j = 0; j < headers.length && j < values.length; j++) {
            const key = headers[j].toLowerCase().replace(/\s+/g, ' ')
            pipedFields[key] = cleanOcrNoise(values[j])
          }
        }
      }
    }
    // Plain-text table rows: header line with known labels, data line with values below
    const plainTableFields = {}
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim()
      const nextLine = lines[i + 1] ? lines[i + 1].trim() : ''
      if (!nextLine) continue
      // Patient row: "Patient Name Date of Birth Member ID Provider"
      // Handles OCR variations: MemberID, MemberiD, Member ID, MemberD
      if (/Patient\s+Name\s+.*(?:Member\s*(?:ID|iD|D)|Date\s+of\s+Birth|Provider)/i.test(line)) {
        // "First Last DD/MM/YYYY MEM-NNN Provider Name" or "Last, First DD/MM/YYYY ..."
        const nameBeforeDate = nextLine.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(\d{2}\/\d{2}\/\d{4})\s+(MEM-\d+|[A-Za-z0-9\-]{4,25})\s+(.+)$/) ||
          nextLine.match(/^([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+(\d{2}\/\d{2}\/\d{4})\s+(MEM-\d+|[A-Za-z0-9\-]{4,25})\s+(.+)$/)
        if (nameBeforeDate) {
          plainTableFields['patient name'] = nameBeforeDate[1]
          plainTableFields['date of birth'] = nameBeforeDate[2]
          plainTableFields['member id'] = nameBeforeDate[3]
          plainTableFields['provider'] = nameBeforeDate[4].replace(/\s*~\s*$/, '').trim()
        }
      }
      // Claim row: "Claim ID Received Date Claim Status Assigned To"
      // Handles OCR variations: ClaimD, Claim1D, ClaimID, Claim ID, Claim_ID + Recerved/Received
      if (/Claim\s*(?:ID|1D|D|_ID)\s+.*(?:Rece(?:i|r)?ved|Date|Claim\s*Status|Status|Assigned)/i.test(line)) {
        const m = nextLine.match(/^(\S+)\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)(?:\s{2,}(.+))?$/)
        if (m) {
          plainTableFields['received date'] = m[2]
          const statusAndAssigned = m[3].trim()
          const assignedMatch = statusAndAssigned.match(/^(.+?)\s+([A-Z][a-z]+(?:\s*[A-Z][a-z]+)+)\s*~?\s*$/)
          if (assignedMatch) {
            plainTableFields['claim status'] = assignedMatch[1].trim()
            plainTableFields['assigned to'] = assignedMatch[2].trim()
          } else {
            plainTableFields['claim status'] = statusAndAssigned.replace(/\s*~\s*$/, '').trim()
          }
        }
      }
    }

    // Line-by-line label→value parser: label alone on one line, value on the next
    // AND same-line: "Label: value" or "Label value" on a single line
    // Handles CuraMind sidebar/body layouts where each field is on its own row
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      // Same-line extraction: "Label: value" or "Label  value"
      const claimTypeInline = line.match(/^Claim[\s\-]*Type\s*[:\-]?\s+(.+)$/i)
      if (claimTypeInline && !plainTableFields['claim type']) {
        const ct = claimTypeInline[1].replace(/^[a-z]\s+/i, '').trim()
        if (ct && ct.length >= 1 && ct.length <= 60 && !/^(Date|Status|Patient|Provider|Member|Received|Service|Auth|Settings|Reports)/i.test(ct)) {
          plainTableFields['claim type'] = ct.split(/\s{2,}/)[0].trim()
        }
      }
      const statusInline = line.match(/^(?:Claim\s+)?Status\s*[:\-]?\s+(.+)$/i)
      if (statusInline && !plainTableFields['claim status']) {
        let st = statusInline[1].replace(/\s*~\s*$/, '').trim()
        st = truncateStatusAtBoundary(st)
        const codeMatch = st.match(/^([\dliI|]{1,2})\s+(.+)$/)
        if (codeMatch) {
          st = `${fixStatusCodeOcr(codeMatch[1])} ${codeMatch[2]}`
        }
        if (st && st.length >= 1 && st.length <= 60 &&
          !/^(Date|Type|Patient|Provider|Member|Received|Service|Claim\s|Auth|Adjudication|Dashboard|Reports|Settings|Information|Queue|Assigned)/i.test(st) &&
          !/\b(Received\s+Date|Assigned\s+To|Claim\s+Status)\b/i.test(st)) {
          plainTableFields['claim status'] = st
        }
      }
      const receivedInline = line.match(/^(?:Received\s*Date|Date\s*Received)\s*[:\-]?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
      if (receivedInline && !plainTableFields['received date']) {
        plainTableFields['received date'] = receivedInline[1]
      }
      const patientInline = line.match(/^Patient\s*Name\s*[:\-]?\s+([A-Z].+)$/i)
      if (patientInline && !plainTableFields['patient name']) {
        let n = stripLeadingNameNoise(patientInline[1].trim())
        n = sanitizePersonName(n)
        if (n && n.length >= 3 && n.length <= 60 &&
          !/^(Date|Status|Type|Provider|Member|Received|Service|Claim|Auth|DOB|Birth)/i.test(n) &&
          !/\b(Date\s+of\s+Birth|Member\s*ID|Provider)\b/i.test(n)) {
          plainTableFields['patient name'] = truncateAtDelimiters(n)
        }
      }
      const memberInline = line.match(/^Member\s*ID\s*[:\-]?\s+([A-Za-z0-9\-]{3,25})/i)
      if (memberInline && !plainTableFields['member id']) {
        plainTableFields['member id'] = memberInline[1]
      }
      const providerInline = line.match(/^Provider(?:\s*Name)?\s*[:\-]?\s+([A-Z].+)$/i)
      if (providerInline && !plainTableFields['provider']) {
        let p = providerInline[1].replace(/\s*~\s*$/, '').trim()
        p = p.replace(/^\d{8,}\s+/, '').trim()
        p = p.replace(/\s+\d{8,}\s*$/, '').trim()
        p = sanitizePersonName(p)
        if (p.length >= 3 && p.length <= 80 && !/^(Date|Status|Type|Patient|Member|Received|Service|Claim|Auth)/i.test(p)) {
          plainTableFields['provider'] = truncateAtDelimiters(p)
        }
      }

      // Next-line extraction: label alone on one line, value on the next
      const nextVal = (i < lines.length - 1) ? (lines[i + 1] || '').trim() : ''
      if (!nextVal || nextVal.length > 100) continue
      const lineLow = line.toLowerCase().replace(/[:\-]/g, '').trim()

      if (/^received\s*date$/i.test(lineLow) && !plainTableFields['received date']) {
        const d = nextVal.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})/)
        if (d) plainTableFields['received date'] = d[1]
      }
      if (/^claim\s*type$/i.test(lineLow) && !plainTableFields['claim type']) {
        const ct = nextVal.replace(/^[a-z]\s+/i, '').trim()
        if (ct && ct.length <= 60 && !/^(Date|Status|Patient|Provider|Member|Received|Service|Claim\s|Auth)/i.test(ct)) {
          plainTableFields['claim type'] = ct
        }
      }
      if (/^(?:claim\s*)?status$/i.test(lineLow) && !plainTableFields['claim status']) {
        let st = nextVal.replace(/\s*~\s*$/, '').trim()
        if (/^[\dliI|]{1,2}$/.test(st)) {
          const lineAfter = (lines[i + 2] || '').trim()
          if (lineAfter && /^[A-Za-z]/i.test(lineAfter) && lineAfter.length <= 40) {
            st = `${fixStatusCodeOcr(st)} ${lineAfter}`
          } else {
            st = fixStatusCodeOcr(st)
          }
        }
        if (st && st.length <= 60 && !/^(Date|Type|Patient|Provider|Member|Received|Service|Claim\s|Auth|Adjudication|Dashboard|Reports|Settings|Information|Queue)/i.test(st)) {
          plainTableFields['claim status'] = st
        }
      }
      if (/^member\s*id$/i.test(lineLow) && !plainTableFields['member id']) {
        const mid = nextVal.match(/^([A-Za-z0-9\-]{3,25})/)
        if (mid) plainTableFields['member id'] = mid[1]
      }
      if (/^patient\s*name$/i.test(lineLow) && !plainTableFields['patient name']) {
        const n = stripLeadingNameNoise(nextVal)
        if (n && n.length >= 3 && n.length <= 60 && /^[A-Z]/i.test(n) && !/^(Date|Status|Type|Provider|Member|Received|Service|Claim|Auth|DOB|Birth)/i.test(n)) {
          plainTableFields['patient name'] = n
        }
      }
      if (/^provider(?:\s*name)?$/i.test(lineLow) && !plainTableFields['provider']) {
        let p = nextVal.replace(/\s*~\s*$/, '').trim()
        p = p.replace(/^\d{8,}\s+/, '').trim()
        p = p.replace(/\s+\d{8,}\s*$/, '').trim()
        p = sanitizePersonName(p)
        if (p && p.length >= 3 && p.length <= 80 && /^[A-Z]/i.test(p) && !/^(Date|Status|Type|Patient|Member|Received|Service|Claim|Auth)/i.test(p)) {
          plainTableFields['provider'] = p
        }
      }
      if (/^(?:date\s*of\s*birth|dob)$/i.test(lineLow) && !plainTableFields['date of birth']) {
        const d = nextVal.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})/)
        if (d) plainTableFields['date of birth'] = d[1]
      }
      if (/^assigned\s*to$/i.test(lineLow) && !plainTableFields['assigned to']) {
        const a = nextVal.replace(/\s*~\s*$/, '').trim()
        if (a && a.length >= 2 && a.length <= 80) plainTableFields['assigned to'] = a
      }
    }

    // Apply piped and plain-text table fields early (before regex) — table layouts produce reliable values
    const tableFields = { ...plainTableFields, ...pipedFields }
    if (tableFields['received date']) {
      const d = tableFields['received date'].match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)
      if (d) result.claimInfo.receivedDate = d[1]
    }
    if (tableFields['claim status']) {
      let raw = (tableFields['claim status'] || '').trim()
      raw = cleanOcrNoise(raw)
      raw = truncateStatusAtBoundary(raw)
      const codeAndLabel = raw.match(/^([\dliI|]{1,2})\s+(.+)$/)
      if (codeAndLabel) {
        raw = `${fixStatusCodeOcr(codeAndLabel[1])} ${codeAndLabel[2]}`
      }
      result.claimInfo.status = this.normalizeWorkflowStatus(raw) || raw
    }
    if (tableFields['claim type']) {
      let ct = (tableFields['claim type'] || '').trim()
      ct = ct.replace(/^[a-z]\s+/i, '').trim()
      if (ct && ct.length >= 1 && ct.length < 80 && !/^(ee|Settings|Service|Details|Reports)?$/i.test(ct)) {
        result.claimInfo.claimType = ct
      }
    }
    if (tableFields['assigned to']) result.claimInfo.assignedTo = tableFields['assigned to']
    if (tableFields['member id']) result.patientInfo.memberId = tableFields['member id']
    if (tableFields['patient name']) {
      let n = stripLeadingNameNoise((tableFields['patient name'] || '').trim())
      n = sanitizePersonName(n)
      if (n.length >= 4 && n.length <= 60) result.patientInfo.patientName = n
    }
    if (tableFields['date of birth']) {
      const d = tableFields['date of birth'].match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)
      if (d) result.patientInfo.dob = d[1]
    }
    if (tableFields['provider']) {
      let p = tableFields['provider'].trim()
      p = sanitizeProviderName(p)
      p = p ? sanitizePersonName(p) : ''
      if (p.length >= 2 && p.length <= 80) result.providerInfo.providerName = p
    }

    // Helper: get section text from structured OCR or cleaned full text, always cleaned
    const structSection = (name, maxLines) => {
      const raw = ocrStructured ? getSectionLinesFromStructured(ocrStructured, name, maxLines).join(' ') : ''
      return raw ? cleanOcrNoise(raw) : ''
    }
    const claimSection = ocrStructured
      ? structSection('Claim Information', 20) || structSection('Claim Pg1', 30) || structSection('Professional Claim', 40)
      : getSectionText(text, 'Claim Information', 400) ||
        getSectionText(text, 'Claim Pg1', 600) ||
        getSectionText(text, 'Professional Claim', 600)
    const claimSectionSrc = claimSection || text

    // Received date: try multiple patterns from full text (handles split layout)
    if (!result.claimInfo.receivedDate) {
      const dateReceivedRe = new RegExp(PATTERNS.date_received, 'i')
      const dateReceivedFlexRe = new RegExp(PATTERNS.date_received_flex, 'i')
      const receivedRe = new RegExp(PATTERNS.received_date, 'i')
      const m = text.match(dateReceivedRe) || text.match(dateReceivedFlexRe) || text.match(receivedRe)
      if (m && m[1]) result.claimInfo.receivedDate = normSpace(m[1])
    }
    if (result.claimId) {
      if (!result.claimInfo.status) {
        const statusRawRe = new RegExp(PATTERNS.status_raw, 'i')
        const statusRawMatch = claimSectionSrc.match(statusRawRe)
        if (statusRawMatch && statusRawMatch[1]) {
          let raw = statusRawMatch[1].replace(/\s*\n\s*/g, ' ').trim()
          raw = cleanOcrNoise(raw)
          raw = truncateStatusAtBoundary(raw)
          const codeAndLabel = raw.match(/^([\dliI|]{1,2})\s+(.+)$/)
          if (codeAndLabel) {
            raw = `${fixStatusCodeOcr(codeAndLabel[1])} ${codeAndLabel[2]}`
          }
          result.claimInfo.status = this.normalizeWorkflowStatus(raw) || raw
        }
      }
      if (!result.claimInfo.assignedTo) {
        const assignedMatch = claimSectionSrc.match(/Assigned\s+To\s*[:\|\-]?\s*([A-Za-z0-9\s]+?)(?=\s*\||\n|$)/i)
        if (assignedMatch) {
          result.claimInfo.assignedTo = truncateAtDelimiters(assignedMatch[1].trim())
        }
      }
      const typeRegexFlex = new RegExp(PATTERNS.claim_type, 'i')
      const typeRegexStrict = new RegExp(PATTERNS.claim_type_strict, 'i')
      let claimType = null
      const typeMatchFlex = claimSectionSrc.match(typeRegexFlex)
      const typeMatchStrict = (claimSectionSrc || text).match(typeRegexStrict)
      if (typeMatchStrict && typeMatchStrict[1]) {
        claimType = truncateAtDelimiters(typeMatchStrict[1].trim())
      }
      if (!claimType && typeMatchFlex && typeMatchFlex[1]) {
        claimType = truncateAtDelimiters(typeMatchFlex[1].trim())
      }
      if (!claimType) {
        const legacyMatch = claimSectionSrc.match(/Claim\s+Type\s*[|:\-]\s*([A-Za-z0-9\s]+?)(?:\s+[a-z]{2}\s+[a-z]{2}\s+Settings|\s+Service\s+Details|$)/i)
        if (legacyMatch) claimType = truncateAtDelimiters(legacyMatch[1].trim())
      }
      if (claimType) {
        // Strip leading single-char noise (e.g. sidebar icon OCR: "a 31" → "31")
        claimType = claimType.replace(/^[a-z]\s+/i, '').trim()
        if (claimType.length > 50 || /Service\s+Details|CPT\s+Code|Billed\s+Amount|Settings|Reports\s+ee|^ee\s|^Settings$/i.test(claimType)) {
          claimType = claimType.split(/\s+/).slice(0, 4).join(' ').trim() || null
        }
        const isNoise = /^(ee|Settings|Service|Details|Reports)?$/i.test(claimType)
        if (claimType && !isNoise && claimType.length < 80 && claimType.length >= 1) result.claimInfo.claimType = claimType
      }
    }
    // Claim type from full text (including when claimId came from URL only)
    if (!result.claimInfo.claimType && text) {
      const typeStrictRe = new RegExp(PATTERNS.claim_type_strict, 'i')
      const typeFlexRe = new RegExp(PATTERNS.claim_type, 'i')
      const typeRawRe = new RegExp(PATTERNS.claim_type_raw, 'i')
      const m = text.match(typeStrictRe) || text.match(typeFlexRe) || text.match(typeRawRe)
      if (m && m[1]) {
        let ct = truncateAtDelimiters(m[1].trim())
        // Strip leading single-char noise (e.g. sidebar icon OCR: "a 31" → "31")
        ct = ct.replace(/^[a-z]\s+/i, '').trim()
        if (ct && ct.length < 80 && !/^(ee|Settings|Service|Details|Reports)?$/i.test(ct)) result.claimInfo.claimType = ct
      }
    }
    if (!result.claimInfo.status) {
      const statusRawRe = new RegExp(PATTERNS.status_raw, 'i')
      const m = claimSectionSrc.match(statusRawRe) || text.match(statusRawRe)
      if (m && m[1]) {
        let raw = m[1].replace(/\s*\n\s*/g, ' ').trim()
        raw = cleanOcrNoise(raw)
        raw = truncateStatusAtBoundary(raw)
        const codeAndLabel = raw.match(/^([\dliI|]{1,2})\s+(.+)$/)
        if (codeAndLabel) {
          raw = `${fixStatusCodeOcr(codeAndLabel[1])} ${codeAndLabel[2]}`
        }
        result.claimInfo.status = this.normalizeWorkflowStatus(raw) || raw
      }
    }
    const serviceDateFromRe = new RegExp(PATTERNS.service_date_from, 'i')
    const serviceDateFromMatch = text.match(serviceDateFromRe)
    if (serviceDateFromMatch && serviceDateFromMatch[1] && !result.claimInfo.serviceDateFrom) {
      result.claimInfo.serviceDateFrom = normSpace(serviceDateFromMatch[1])
    }
    // OCR-exact auth/ref status: no fixed pattern, capture exact text after label
    const authRefStatusRawRe = new RegExp(PATTERNS.auth_ref_status_raw, 'i')
    const authRefMatch = claimSectionSrc.match(authRefStatusRawRe) || text.match(authRefStatusRawRe)
    if (authRefMatch && authRefMatch[1]) {
      let authRaw = authRefMatch[1].replace(/\s*\n\s*/g, ' ').trim()
      const authCodeLabel = authRaw.match(/^([\dliI|]{1,2})\s+(.+)$/)
      if (authCodeLabel) {
        authRaw = `${fixStatusCodeOcr(authCodeLabel[1])} ${authCodeLabel[2]}`
      }
      result.claimInfo.authRefStatus = truncateAtDelimiters(authRaw)
    }
    const companyIdRe = new RegExp(PATTERNS.company_id, 'i')
    const companyIdMatch = text.match(companyIdRe)
    if (companyIdMatch && companyIdMatch[1]) result.claimInfo.companyId = companyIdMatch[1].trim()
    const placeOfServiceRe = new RegExp(PATTERNS.place_of_service_24b, 'i')
    const placeOfServiceMatch = text.match(placeOfServiceRe)
    if (placeOfServiceMatch && placeOfServiceMatch[1]) result.claimInfo.placeOfService = normSpace(placeOfServiceMatch[1])
    const facilityRe = new RegExp(PATTERNS.facility, 'i')
    const facilityMatch = text.match(facilityRe)
    if (facilityMatch && facilityMatch[1]) result.claimInfo.facility = truncateAtDelimiters(facilityMatch[1].trim())
    const outcomeRe = new RegExp(PATTERNS.outcome, 'i')
    const outcomeMatch = text.match(outcomeRe)
    if (outcomeMatch && outcomeMatch[1]) result.claimInfo.outcome = truncateAtDelimiters(outcomeMatch[1].trim())
    const payerRespRe = new RegExp(PATTERNS.payer_resp, 'i')
    const payerRespMatch = text.match(payerRespRe)
    if (payerRespMatch && payerRespMatch[1]) result.claimInfo.payerResp = payerRespMatch[1].trim()
    const ediBatchRe = new RegExp(PATTERNS.edi_batch_id, 'i')
    const ediBatchMatch = text.match(ediBatchRe)
    if (ediBatchMatch && ediBatchMatch[1]) result.claimInfo.ediBatchId = ediBatchMatch[1].trim()

    // Auth/Referral number(s)
    const authRefRe = new RegExp(PATTERNS.auth_referral, 'gi')
    const authRefNums = []
    let authRefM
    while ((authRefM = authRefRe.exec(text)) !== null) {
      if (authRefM[1] && authRefM[1].length >= 4) authRefNums.push(authRefM[1].trim())
    }
    if (authRefNums.length > 0) result.claimInfo.authReferralNums = authRefNums

    // Priority (code+label like "3 NORMAL" or standalone label)
    if (!result.claimInfo.priority) {
      const priorityWithCodeRe = new RegExp(PATTERNS.priority_with_code, 'i')
      const priorityLevelRe = new RegExp(PATTERNS.priority_level, 'i')
      const priorityMatch = text.match(priorityWithCodeRe) || text.match(priorityLevelRe)
      if (priorityMatch && priorityMatch[1]) {
        result.claimInfo.priority = normSpace(priorityMatch[1])
      }
      if (!result.claimInfo.priority) {
        for (let i = 0; i < lines.length; i++) {
          if (/^priority$/i.test(lines[i].trim().replace(/[:\-]/g, '').trim())) {
            const nextVal = (lines[i + 1] || '').trim()
            if (nextVal && nextVal.length <= 30) {
              const combined = (lines[i + 2] || '').trim()
              if (/^[A-Z]+$/i.test(nextVal) && /^\d+$/.test(nextVal) === false && combined) {
                result.claimInfo.priority = nextVal
              } else if (/^\d+$/.test(nextVal) && combined && /^[A-Z]+$/i.test(combined)) {
                result.claimInfo.priority = `${nextVal} ${combined}`
              } else {
                result.claimInfo.priority = nextVal
              }
            }
            break
          }
        }
      }
    }

    // Gender
    const genderRe = new RegExp(PATTERNS.patient_gender, 'i')
    const genderMatch = text.match(genderRe)
    if (genderMatch && genderMatch[1]) {
      result.patientInfo.gender = genderMatch[1].trim()
    }
    if (!result.patientInfo.gender) {
      for (let i = 0; i < lines.length; i++) {
        const lineTrimmed = lines[i].trim().replace(/[:\-]/g, '').trim()
        if (/^gender\s*(?:\(\d+\))?$/i.test(lineTrimmed)) {
          const nextVal = (lines[i + 1] || '').trim()
          if (/^[MF]$|^Male$|^Female$|^Unknown$/i.test(nextVal)) {
            result.patientInfo.gender = nextVal
          }
          break
        }
      }
    }

    const generalSection = getSectionText(text, 'General Information', 800) ||
      getSectionText(text, 'General Informaton', 800)
    const generalSrc = generalSection || text
    // Member ID and patient name: run from full text always (not gated by section)
    const memberIdRe = new RegExp(PATTERNS.member_id, 'i')
    const memberIdFlexRe = new RegExp(PATTERNS.member_id_flex, 'i')
    const memberWithNameRe = new RegExp(PATTERNS.member_id_with_name, 'i')
    const memberWithNameFlexRe = new RegExp(PATTERNS.member_id_with_name_flex, 'i')
    for (const src of [generalSrc, text]) {
      if (result.patientInfo.memberId && result.patientInfo.patientName) break
      const memberIdMatch = src.match(memberIdRe) || src.match(memberIdFlexRe)
      if (memberIdMatch && memberIdMatch[1] && !result.patientInfo.memberId) {
        result.patientInfo.memberId = memberIdMatch[1].trim()
      }
      const memberWithNameMatch = src.match(memberWithNameRe) || src.match(memberWithNameFlexRe)
      if (memberWithNameMatch && memberWithNameMatch[1]) {
        if (!result.patientInfo.memberId) result.patientInfo.memberId = normSpace(memberWithNameMatch[1].trim())
        if (memberWithNameMatch[2] && !result.patientInfo.patientName) {
          let name = stripLeadingNameNoise(memberWithNameMatch[2].trim())
          name = sanitizePersonName(truncateAtDelimiters(name))
          if (name.length >= 4) result.patientInfo.patientName = name
        }
      }
    }
    // Line-by-line: Member ID on one line, patient name (LAST, FIRST) on same or next line
    if ((!result.patientInfo.patientName || !result.patientInfo.memberId) && Array.isArray(lines) && lines.length > 0) {
      const memberIdLineRe = /Member\s*ID\s*[:\-]?\s*([A-Za-z0-9\-]{4,25})/i
      const nameLineRe = /^[A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*$/
      const inlineNameRe = /([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/
      for (let i = 0; i < lines.length; i++) {
        const memberLineMatch = lines[i].match(memberIdLineRe)
        if (memberLineMatch && memberLineMatch[1]) {
          if (!result.patientInfo.memberId) result.patientInfo.memberId = memberLineMatch[1].trim()
          if (!result.patientInfo.patientName) {
            const afterId = lines[i].slice(lines[i].indexOf(memberLineMatch[1]) + memberLineMatch[1].length)
            const inlineMatch = afterId.match(inlineNameRe)
            if (inlineMatch && inlineMatch[1] && inlineMatch[1].length >= 4 && inlineMatch[1].length <= 60) {
              let name = stripLeadingNameNoise(inlineMatch[1].trim())
              name = sanitizePersonName(truncateAtDelimiters(name))
              if (name.length >= 4) result.patientInfo.patientName = name
              break
            }
            const nextLine = (lines[i + 1] || '').trim()
            let nextName = stripLeadingNameNoise(nextLine)
            nextName = sanitizePersonName(nextName)
            if (nextName && nameLineRe.test(nextName) && nextName.length >= 4 && nextName.length <= 60) {
              result.patientInfo.patientName = truncateAtDelimiters(nextName)
              break
            }
          }
        }
      }
    }
    if (!result.patientInfo.patientName && text) {
      const nameNearMemberRe = /Member\s*ID\s*[:\-]?\s*[A-Za-z0-9\-]{4,25}\s+([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)(?=\s+PCP|\s+Provider|\s+Primary|\s+Service|\s+Encounters|\s*\n|$)/i
      const m = text.match(nameNearMemberRe)
      if (m && m[1] && m[1].length >= 4 && m[1].length <= 60) {
        let name = stripLeadingNameNoise(m[1].trim())
        name = sanitizePersonName(truncateAtDelimiters(name))
        if (name.length >= 4) result.patientInfo.patientName = name
      }
    }
    // Fallback: handle member IDs where OCR split letter prefix from digits ("H 6889629313")
    if (!result.patientInfo.patientName) {
      const spacedIdNameRe = /Member\s*ID\s*[:\-]?\s*[A-Z]\s*\d{6,}\s+([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/i
      for (const src of [generalSrc, text]) {
        const m = src.match(spacedIdNameRe)
        if (m && m[1]) {
          let name = sanitizePersonName(truncateAtDelimiters(m[1].trim()))
          if (name.length >= 4 && name.length <= 60) {
            result.patientInfo.patientName = name
            break
          }
        }
      }
    }
    // Line-by-line fallback: find "LAST, FIRST" on lines with "Member ID" but NOT "Company ID"
    if (!result.patientInfo.patientName && Array.isArray(lines)) {
      const lastFirstRe = /([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/
      for (const line of lines) {
        if (!/Member\s*ID/i.test(line)) continue
        if (/Company\s*ID/i.test(line)) continue
        const m = line.match(lastFirstRe)
        if (m && m[1]) {
          let name = sanitizePersonName(truncateAtDelimiters(m[1].trim()))
          if (name.length >= 4 && name.length <= 60) {
            result.patientInfo.patientName = name
            break
          }
        }
      }
    }
    if (generalSection || /General\s*Information|Professional\s*Claim|Claim\s*Pg1/i.test(text)) {
      // Early: standalone Provider ID and Name from full text (catches split layout and missing section)
      if (!result.providerInfo.providerId) {
        const providerIdOnlyRe = new RegExp(PATTERNS.provider_id_only, 'i')
        for (const src of [generalSrc, text]) {
          const m = src.match(providerIdOnlyRe)
          if (m && m[1]) {
            result.providerInfo.providerId = m[1].trim()
            break
          }
        }
      }
      if (!result.providerInfo.providerName) {
        const providerNameOnlyRe = new RegExp(PATTERNS.provider_name_only, 'i')
        for (const src of [generalSrc, text]) {
          const m = src.match(providerNameOnlyRe)
          if (m && m[1]) {
            let clean = sanitizeProviderName(m[1].trim())
            clean = clean ? sanitizePersonName(truncateAtDelimiters(clean)) : ''
            if (clean.length >= 2 && clean.length <= 80 && !/^\d+$/.test(clean)) {
              result.providerInfo.providerName = clean
              break
            }
          }
        }
      }
      if (!result.providerInfo.providerName) {
        const billingRe = new RegExp(PATTERNS.billing_provider, 'i')
        const renderingRe = new RegExp(PATTERNS.rendering_provider, 'i')
        for (const src of [generalSrc, text]) {
          const m = src.match(renderingRe) || src.match(billingRe)
          if (m && m[1]) {
            let clean = sanitizeProviderName(m[1].trim())
            clean = clean ? sanitizePersonName(truncateAtDelimiters(clean)) : ''
            if (clean.length >= 2 && clean.length <= 80 && !/^\d+$/.test(clean) && /[A-Za-z]{2,}/.test(clean)) {
              result.providerInfo.providerName = clean
              break
            }
          }
        }
      }
      // Line-by-line Provider ID + Name extraction (robust for split layouts)
      if (!result.providerInfo.providerId || !result.providerInfo.providerName) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          const pidInline = line.match(/^Provider\s*ID\s*[:\-]?\s*(\d{6,})/i)
          if (pidInline) {
            if (!result.providerInfo.providerId) result.providerInfo.providerId = pidInline[1]
            // Name might be on the rest of this line or the next line
            const afterPid = line.slice(line.indexOf(pidInline[1]) + pidInline[1].length).trim()
            if (afterPid && /^[A-Z]/.test(afterPid) && afterPid.length >= 3 && !result.providerInfo.providerName) {
              let pn = sanitizeProviderName(afterPid)
              pn = pn ? sanitizePersonName(truncateAtDelimiters(pn)) : ''
              if (pn.length >= 3) result.providerInfo.providerName = pn
            }
            if (!result.providerInfo.providerName) {
              const nameLine = (lines[i + 1] || '').trim()
              if (nameLine && /^[A-Z]/.test(nameLine) && nameLine.length >= 3 && nameLine.length <= 80 &&
                  !/^(?:Provider|Primary|Birth|Gender|Marital|EOB|MPPR|Place|Facility|Outcome|Payer|Encounters|Member|Patient|Service|Claim|Auth|Date|Status|General|Information)\b/i.test(nameLine)) {
                let pn = sanitizeProviderName(nameLine)
                pn = pn ? sanitizePersonName(truncateAtDelimiters(pn)) : ''
                if (pn.length >= 3) result.providerInfo.providerName = pn
              }
            }
            continue
          }
          if (/^Provider\s*ID\s*[:\-]?\s*$/i.test(line)) {
            const nextLine = (lines[i + 1] || '').trim()
            if (/^\d{6,}$/.test(nextLine)) {
              if (!result.providerInfo.providerId) result.providerInfo.providerId = nextLine
              const nameLine = (lines[i + 2] || '').trim()
              if (nameLine && /^[A-Z]/.test(nameLine) && nameLine.length >= 3 && nameLine.length <= 80 &&
                  !/^(?:Provider|Primary|Birth|Gender|Marital|EOB|MPPR|Place|Facility|Outcome|Payer|Encounters|Member|Patient|Service|Claim|Auth|Date|Status|General|Information)\b/i.test(nameLine)) {
                let pn = sanitizeProviderName(nameLine)
                pn = pn ? sanitizePersonName(truncateAtDelimiters(pn)) : ''
                if (pn.length >= 3 && !result.providerInfo.providerName) result.providerInfo.providerName = pn
              }
            }
          }
        }
      }
      // Regex fallback: Provider ID with name in full text
      const providerWithNameRe = new RegExp(PATTERNS.provider_id_with_name, 'i')
      for (const src of [generalSrc, text]) {
        if (result.providerInfo.providerName && result.providerInfo.providerId) break
        const providerWithNameMatch = src.match(providerWithNameRe)
        if (providerWithNameMatch) {
          if (providerWithNameMatch[2]) {
            if (!result.providerInfo.providerName) {
              let pn = sanitizeProviderName(providerWithNameMatch[2].trim())
              result.providerInfo.providerName = pn ? sanitizePersonName(truncateAtDelimiters(pn)) : null
            }
            if (!result.providerInfo.providerId) result.providerInfo.providerId = providerWithNameMatch[1].trim()
          } else if (providerWithNameMatch[1] && !result.providerInfo.providerName) {
            let pn = sanitizeProviderName(providerWithNameMatch[1].trim())
            result.providerInfo.providerName = pn ? sanitizePersonName(truncateAtDelimiters(pn)) : null
          }
        }
      }
      const primaryDiagRe = new RegExp(PATTERNS.primary_diagnosis, 'i')
      const primaryDiagMatch = generalSrc.match(primaryDiagRe)
      if (primaryDiagMatch && primaryDiagMatch[1]) {
        result.claimInfo.primaryDiagnosis = truncateAtDelimiters(primaryDiagMatch[1].trim())
      }
      const birthDateRe = new RegExp(PATTERNS.birth_date, 'i')
      const birthDateMatch = generalSrc.match(birthDateRe)
      if (birthDateMatch && birthDateMatch[1] && !result.patientInfo.dob) {
        result.patientInfo.dob = normSpace(birthDateMatch[1])
      }
    }

    // Patient Information - section only; use structured when available (always cleaned)
    const patientSection = ocrStructured
      ? structSection('Patient Information', 25)
      : getSectionText(text, 'Patient Information', 350)
    const patientSectionSrc = patientSection || text
    const patientNameRe = new RegExp(PATTERNS.patient_name, 'i')
    const patientNameLastFirstRe = new RegExp(PATTERNS.patient_name_last_first, 'i')
    let patientNameMatch = patientSectionSrc.match(patientNameRe) ||
      patientSectionSrc.match(patientNameLastFirstRe) ||
      patientSectionSrc.match(/Patient\s+Name\s*:?\s*([A-Za-z0-9\s,.'\-]+?)(?=\s+Member|\s+Date|\s+DOB|\s+ID|\s*\n|$)/i) ||
      patientSectionSrc.match(/Name\s*:?\s*([A-Za-z0-9\s,.'\-]{2,50}?)(?=\s+Member|\s+Date|\s+DOB|\s+ID|\s*\n|$)/i)
    const isPlausiblePatientName = (s) => {
      if (!s || s.length < 2 || s.length > 60) return false
      if (/^[\d\s\-]+$/.test(s) || /^MEM-|^\d+$/.test(s)) return false
      if (this.looksLikeSectionHeader(s)) return false
      return true
    }
    if (!result.patientInfo.patientName && patientNameMatch && patientNameMatch[1]) {
      let clean = truncateAtDelimiters(patientNameMatch[1].trim().replace(/\s+/g, ' '))
      clean = stripLeadingNameNoise(clean)
      clean = sanitizePersonName(clean)
      if (isPlausiblePatientName(clean)) result.patientInfo.patientName = clean
    }
    if (!result.patientInfo.patientName && text) {
      const fullTextPatientRe = new RegExp(PATTERNS.patient_name, 'i')
      const lastFirstRe = new RegExp(PATTERNS.patient_name_last_first, 'i')
      const m = text.match(fullTextPatientRe) || text.match(lastFirstRe)
      if (m && m[1]) {
        let clean = truncateAtDelimiters(m[1].trim().replace(/\s+/g, ' '))
        clean = stripLeadingNameNoise(clean)
        clean = sanitizePersonName(clean)
        if (isPlausiblePatientName(clean)) result.patientInfo.patientName = clean
      }
    }
    if (!result.patientInfo.dob) {
      const dobMatch = patientSectionSrc.match(/(?:Date\s+of\s+Birth|DOB)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)
      if (dobMatch && dobMatch[1]) result.patientInfo.dob = dobMatch[1]
    }
    // Standalone MEM-xxx member ID (works even when prefix is consumed by pattern)
    if (!result.patientInfo.memberId) {
      const memStandalone = (patientSectionSrc || text).match(/\b(MEM-\d{1,10})\b/)
      if (memStandalone) result.patientInfo.memberId = memStandalone[1]
    }
    if (!result.patientInfo.memberId) {
      const memberIdMatch = patientSectionSrc.match(memberIdRe) || text.match(memberIdRe) || text.match(memberIdFlexRe)
      if (memberIdMatch && memberIdMatch[1]) result.patientInfo.memberId = memberIdMatch[1].trim()
    }
    if (!result.patientInfo.memberId) {
      const mem = this.extractPattern(patientSectionSrc || text, this.memberRe)
      if (mem) result.patientInfo.memberId = mem
    }

    // Table layout: "Patient Name" is a column header, name is on data row (next line or after other headers)
    if (!result.patientInfo.patientName && Array.isArray(lines)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (/^\s*Patient\s*Name\s*$/i.test(line)) {
          let nextLine = (lines[i + 1] || '').trim()
          nextLine = stripLeadingNameNoise(nextLine)
          nextLine = sanitizePersonName(nextLine)
          const looksLikeFirstLast = nextLine && /^[A-Z][a-z]/.test(nextLine)
          const looksLikeLastFirst = nextLine && /^[A-Z][A-Za-z]+,\s*[A-Z]/.test(nextLine)
          if (nextLine && (looksLikeFirstLast || looksLikeLastFirst) && !/^(?:Date|Birth|Member|Provider|ID|CPT|Service|Claim|Information|Sequence)\b/i.test(nextLine)) {
            if (nextLine.length >= 4 && nextLine.length <= 60) {
              result.patientInfo.patientName = truncateAtDelimiters(nextLine)
              break
            }
          }
        }
        // Header row: "Patient Name Date of Birth Member ID Provider" — data row follows (First Last or LAST, FIRST)
        if (/Patient\s*Name\s+(?:Date|DOB|Birth|Member|ID|Provider)/i.test(line)) {
          const dataLine = (lines[i + 1] || '').trim()
          const nameBeforeDate = dataLine.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+\d{2}\/\d{2}/) ||
            dataLine.match(/^([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+\d{2}\/\d{2}/)
          if (nameBeforeDate && nameBeforeDate[1] && nameBeforeDate[1].length >= 4) {
            let name = stripLeadingNameNoise(nameBeforeDate[1].trim())
            name = sanitizePersonName(truncateAtDelimiters(name))
            if (name.length >= 4) result.patientInfo.patientName = name
            if (result.patientInfo.patientName) break
          }
        }
      }
    }
    if (!result.patientInfo.patientName) {
      const nameBeforeDateRe = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+\d{2}\/\d{2}\/\d{4}/
      const lastFirstBeforeDateRe = /([A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+\d{2}\/\d{2}\/\d{4}/
      const m = patientSectionSrc.match(nameBeforeDateRe) || patientSectionSrc.match(lastFirstBeforeDateRe)
      if (m && m[1] && m[1].length >= 4 && m[1].length <= 60) {
        let name = stripLeadingNameNoise(m[1].trim())
        name = sanitizePersonName(name)
        if (isPlausiblePatientName(name)) result.patientInfo.patientName = truncateAtDelimiters(name)
      }
    }
    // Broad fallback: "LAST, FIRST" or "LAST FIRST" anywhere near "Patient Name" / "Member Name" label
    if (!result.patientInfo.patientName) {
      const broadNameRe = /(?:Patient\s*Name|Member\s*Name)\s*[:\-]?\s*([A-Z][A-Za-z]+(?:[,\s]+[A-Z][A-Za-z]+)+)/i
      for (const src of [patientSectionSrc, text]) {
        const m = src.match(broadNameRe)
        if (m && m[1]) {
          let name = stripLeadingNameNoise(m[1].trim())
          name = sanitizePersonName(truncateAtDelimiters(name))
          if (isPlausiblePatientName(name)) {
            result.patientInfo.patientName = name
            break
          }
        }
      }
    }

    const providerSection = ocrStructured
      ? structSection('Provider Information', 15)
      : getSectionText(text, 'Provider Information', 300)
    const providerSectionSrc = providerSection || text
    if (!result.providerInfo.providerName) {
      const providerNameMatch = providerSectionSrc.match(/Provider\s+Name\s*:?\s*(?:\d{6,}\s+)?([A-Za-z][A-Za-z\s,.'-]+?)(?=\s+(?:Service|Patient|Claim|Date|Primary|Birth|Gender|Place|Facility|Outcome|Payer|EOB|MPPR|Auth|Member|General|Information|Encounters|Status|Area|Company|EDI)|\s+\d{6,}|\s*\n|$)/i) ||
                               providerSectionSrc.match(/Name\s*:?\s*(?:\d{6,}\s+)?([A-Za-z][A-Za-z\s,.'-]{2,60}?(?:Group|Healthcare|Medical|Center|Clinic|Hospital|Associates|LLC|Inc|Corp|Services|Assoc)?)(?=\s+(?:Service|Patient|Claim|Date|Primary|Birth|Gender|Place|Facility|Outcome|Payer|EOB|MPPR|Auth|Member|General|Information)|\s*\n|$)/i)
      if (providerNameMatch && providerNameMatch[1]) {
        let clean = sanitizeProviderName(providerNameMatch[1].trim())
        clean = clean ? sanitizePersonName(truncateAtDelimiters(clean)) : ''
        if (clean.length >= 2 && clean.length <= 80 && !/^\d+$/.test(clean)) result.providerInfo.providerName = clean
      }
    }
    if (!result.providerInfo.providerName && providerSection) {
      const provLines = providerSection.split(/\n/)
      for (const pl of provLines) {
        let candidate = sanitizeProviderName(pl.trim())
        candidate = candidate ? sanitizePersonName(truncateAtDelimiters(candidate)) : ''
        if (candidate.length >= 3 && candidate.length <= 80 && !/^\d+$/.test(candidate) && /[A-Za-z]{2,}/.test(candidate) &&
            !/^(?:Provider|Primary|Birth|Gender|Marital|EOB|MPPR|Place|Facility|Outcome|Payer|Encounters|Member|Patient|Service|Claim|Auth|Date|Status|General|Information|Name|ID|NPI|TIN|Address)\b/i.test(candidate)) {
          result.providerInfo.providerName = candidate
          break
        }
      }
    }
    // Provider ID from NPI or standalone line "Provider ID" + number (if not captured yet)
    if (!result.providerInfo.providerId) {
      const npiMatch = text.match(new RegExp(PATTERNS.provider_npi, 'i'))
      if (npiMatch && npiMatch[1]) result.providerInfo.providerId = npiMatch[1]
    }

    // Service Details: try PRO matrix first (P-77014 style), then standard matrix, then line-by-line
    const serviceText = this.sliceServiceSection(text)
    const useProMatrix = serviceText && (/P-\d{5}|P-[A-Z]\d{4}/.test(serviceText) || (/Sequence|From\s*Date|To\s*Date/.test(serviceText) && /Contract|Net\s*Pay/.test(serviceText)))
    if (serviceText && useProMatrix) {
      const proRe = getServiceLineMatrixProRegex()
      let match
      while ((match = proRe.exec(serviceText)) !== null) {
        const g = match.groups || {}
        const lineBilled = this.cleanMoney(g.line_billed)
        if (lineBilled == null) continue
        const lineCode = g.line_code ? g.line_code.trim() : null
        const contractAmt = g.line_contract ? this.cleanMoney(g.line_contract) : null
        const netPay = g.line_net_pay ? this.cleanMoney(g.line_net_pay) : null
        result.serviceDetails.push({
          serviceDate: normSpace(g.line_from) || null,
          cptCode: lineCode,
          description: null,
          billedAmount: lineBilled,
          allowedAmount: contractAmt,
          contractAmount: contractAmt,
          netPayAmount: netPay,
          deductible: g.line_deductible ? this.cleanMoney(g.line_deductible) : null,
          copay: g.line_copay ? this.cleanMoney(g.line_copay) : null,
          coinsurance: g.line_coinsurance ? this.cleanMoney(g.line_coinsurance) : null,
          adjustment: g.line_adjustment ? this.cleanMoney(g.line_adjustment) : null,
          prevPaid: g.line_prev_paid ? this.cleanMoney(g.line_prev_paid) : null,
          prevPatResp: g.line_prev_pat_resp ? this.cleanMoney(g.line_prev_pat_resp) : null
        })
      }
      const totalsRe = getTotalsLineRegex()
      const totalsMatch = text.match(totalsRe)
      if (totalsMatch) {
        if (totalsMatch[1]) result.adjudication.totalBilled = this.cleanMoney(totalsMatch[1])
        if (totalsMatch[2]) result.adjudication.totalNetPay = this.cleanMoney(totalsMatch[2])
      }
      // Separate labeled totals: "Total Billed:\n$7385.56" / "Total Net Pay:\n$5649.69"
      if (result.adjudication.totalBilled == null) {
        const tbm = text.match(getTotalBilledLabelRegex())
        if (tbm && tbm[1]) result.adjudication.totalBilled = this.cleanMoney(tbm[1])
      }
      if (result.adjudication.totalNetPay == null) {
        const tnm = text.match(getTotalNetPayLabelRegex())
        if (tnm && tnm[1]) result.adjudication.totalNetPay = this.cleanMoney(tnm[1])
      }
    }
    if (result.serviceDetails.length === 0 && serviceText) {
      const serviceLineRe = getServiceLineMatrixRegex()
      let match
      while ((match = serviceLineRe.exec(serviceText)) !== null) {
        const g = match.groups || {}
        const lineBilled = this.cleanMoney(g.line_billed)
        if (lineBilled == null) continue
        const lineDesc = g.line_desc ? normSpace(g.line_desc).replace(/\|/g, '').replace(/Edit\s+with\s*Lovable/gi, '').trim() : null
        const lineCode = g.line_code && /^(?:\d{5}|[A-Z]\d{4}|P-\d{5}|P-[A-Z]\d{4})$/.test(g.line_code.trim()) ? g.line_code.trim() : null
        if (lineDesc && this.looksLikeSectionHeader(lineDesc)) continue
        result.serviceDetails.push({
          serviceDate: normSpace(g.line_date) || null,
          cptCode: lineCode,
          description: lineDesc || null,
          billedAmount: lineBilled,
          allowedAmount: g.line_allowed ? this.cleanMoney(g.line_allowed) : null
        })
      }
    }
    if (result.serviceDetails.length === 0) {
      const serviceHeaderPattern = /Service\s+Date|CPT\s+Code|Billed\s+Amount/i
      let inServiceTable = false
      const rawServiceLines = ocrStructured ? getSectionLinesFromStructured(ocrStructured, 'Service Details', 50) : null
      const serviceSectionLines = rawServiceLines?.length > 0 ? rawServiceLines.map(l => cleanOcrNoise(l)) : null
      const linesToScan = serviceSectionLines?.length > 0 ? serviceSectionLines : lines
      for (let i = 0; i < linesToScan.length; i++) {
        const line = linesToScan[i]
        if (serviceHeaderPattern.test(line)) { inServiceTable = true; continue }
        if (inServiceTable) {
          if (line.toLowerCase().includes('total') || !line.trim()) break
          const dateMatch = line.match(this.dateRe)
          const cptMatch = line.match(/\b(\d{5}|[A-Z]\d{4}|P-\d{5}|P-[A-Z]\d{4})\b/)
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
    }

    // Extract totals from separate labels even when PRO matrix wasn't used
    if (result.adjudication.totalBilled == null) {
      const tbm = text.match(getTotalBilledLabelRegex())
      if (tbm && tbm[1]) result.adjudication.totalBilled = this.cleanMoney(tbm[1])
    }
    if (result.adjudication.totalNetPay == null) {
      const tnm = text.match(getTotalNetPayLabelRegex())
      if (tnm && tnm[1]) result.adjudication.totalNetPay = this.cleanMoney(tnm[1])
    }
    // Fall back to PATTERNS.total_billed / total_net_pay from full text
    if (result.adjudication.totalBilled == null) {
      const totalBilledRe = new RegExp(PATTERNS.total_billed, 'i')
      const m = text.match(totalBilledRe)
      if (m && m[1]) result.adjudication.totalBilled = this.cleanMoney(m[1])
    }
    if (result.adjudication.totalNetPay == null) {
      const totalNetPayRe = new RegExp(PATTERNS.total_net_pay, 'i')
      const m = text.match(totalNetPayRe)
      if (m && m[1]) result.adjudication.totalNetPay = this.cleanMoney(m[1])
    }

    if (tLow.includes('adjudication') || tLow.includes('total amount calculation')) {
      const adj = this.extractAdjudicationAmounts(text)
      if (adj.billedAmount != null) result.adjudication.billedAmount = adj.billedAmount
      if (adj.allowedAmount != null) result.adjudication.allowedAmount = adj.allowedAmount
      if (adj.deductible != null) result.adjudication.deductible = adj.deductible
      if (adj.payableAmount != null) result.adjudication.payableAmount = adj.payableAmount
    }

    return result
  }

  sliceServiceSection(cleanText) {
    const anchors = ['Service Details', 'Service Detail', 'Sequence', 'From Date', 'To Date', 'Service', 'CPT Code', 'Revenue Code', 'Service Date']
    const enders = ['Total Billed', 'Adjudication', 'Remarks', 'Policy Verification', 'Back to Claim', '<FOOTER>', 'QSearch', 'Edit with Lovable', 'All Bookmarks']
    let start = null
    for (const a of anchors) {
      const m = cleanText.match(new RegExp(a.replace(/\s+/g, '\\s+'), 'i'))
      if (m) { start = cleanText.indexOf(m[0]); break }
    }
    if (start == null) return ''
    const sub = cleanText.slice(start)
    let end = sub.length
    for (const e of enders) {
      const m = sub.match(new RegExp(e.replace(/\s+/g, '\\s+'), 'i'))
      if (m && m.index > 0 && m.index < end) end = m.index
    }
    return end !== sub.length ? sub.slice(0, end) : sub
  }

  extractAdjudicationAmounts(cleanText) {
    let billed = null, allowed = null, deductible = null, payable = null
    for (const line of cleanText.split('\n')) {
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
    if (/Deductible\b[^\n\r]*[-]?\$?0\.00/i.test(cleanText)) deductible = 0
    return { billedAmount: billed, allowedAmount: allowed, deductible, payableAmount: payable }
  }

  /** Use centralized normalizeWorkflowStatus from claimRegexPatterns (STATUS_FIX) */
  normalizeStatus(status) {
    return this.normalizeWorkflowStatus(status)
  }
}

