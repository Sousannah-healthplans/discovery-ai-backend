/**
 * Text parsing utilities for OCR claim extraction.
 * Section-aware parsing to avoid dumping entire blocks (e.g. Service Details) into single fields.
 */

const SECTION_HEADERS = [
  'Claim Information',
  'Claim Pg1',
  'General Information',
  'General Informaton',
  'Patient Information',
  'Provider Information',
  'Service Details',
  'Adjudication',
  'Total Amount Calculation',
  'Policy Verification',
  'Remarks',
  'Claim Detail',
  'Claim #',
  'Professional Claim'
]

/**
 * Normalize whitespace: collapse multiple spaces/newlines to single space, trim.
 */
export function normalizeWhitespace(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

/**
 * Split text into lines, normalize each line.
 */
export function toLines(text) {
  const normalized = normalizeWhitespace(text)
  return normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

/**
 * Find start index of a section (case-insensitive) in text.
 * Returns -1 if not found.
 */
export function findSectionStart(text, sectionName) {
  if (!text) return -1
  const re = new RegExp(sectionName.replace(/\s+/g, '\\s+'), 'i')
  const m = text.match(re)
  return m ? text.indexOf(m[0]) : -1
}

/**
 * Extract the span of text for a section, bounded by the next known section or end.
 * sectionName: e.g. "Patient Information"
 * Returns trimmed string or ''.
 */
export function getSectionText(fullText, sectionName, maxLength = 600) {
  const normalized = normalizeWhitespace(fullText)
  const start = findSectionStart(normalized, sectionName)
  if (start === -1) return ''

  const afterHeader = normalized.slice(start + sectionName.length).trim()
  let end = afterHeader.length
  for (const header of SECTION_HEADERS) {
    if (header.toLowerCase() === sectionName.toLowerCase()) continue
    const idx = findSectionStart(' ' + afterHeader, header)
    if (idx !== -1 && idx < end) end = idx
  }
  const slice = afterHeader.slice(0, Math.min(end, maxLength))
  return slice.trim()
}

/**
 * Stop value at common delimiters (next section, date, MEM-, $, 5-digit code).
 * Used to avoid pulling "Service Details Service Date..." into a name field.
 */
export function truncateAtDelimiters(value) {
  if (!value || typeof value !== 'string') return ''
  let v = value.trim()
  v = v.split(/\s+(Claim\s+(?:Type|ID|#|Information)|Patient\s+(?:Name|Information)|Provider\s+(?:ID|Name|Information|Service)|Service\s+(?:Details|Date|Area)|Member\s+(?:ID|Name)|Date\s+(?:Received|of)|Status\s*:|Assigned\s|Information\s)/i)[0].trim()
  v = v.split(/\s+\d{2}\/\d{2}\/\d{4}/)[0].trim()
  v = v.split(/\s+MEM-/i)[0].trim()
  v = v.split(/\s+\$/)[0].trim()
  v = v.split(/\s+\d{5}\b/)[0].trim()
  v = v.split(/\s+(Billed|Allowed|Total|CPT|Description)/i)[0].trim()
  if (v.length > 120) v = v.slice(0, 120).trim()
  return v
}

/**
 * Parse date string MM/DD/YYYY to Date or null.
 */
export function parseDate(dateStr) {
  if (!dateStr) return null
  const m = String(dateStr).match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  const d = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10))
  return isNaN(d.getTime()) ? null : d
}

/**
 * Extract first match of pattern from text; returns capture group 1 or full match.
 */
export function extractOne(text, pattern) {
  if (!text) return null
  const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern
  const m = String(text).match(regex)
  return m ? (m[1] || m[0]).trim() : null
}

/**
 * Extract all matches (global regex).
 */
export function extractAll(text, pattern) {
  if (!text) return []
  const regex = new RegExp(pattern.source || pattern, (pattern.flags || '') + 'g')
  const matches = []
  let m
  while ((m = regex.exec(text)) !== null) {
    matches.push(m[1] || m[0])
  }
  return matches
}

// --- Structured OCR helpers (use when ocrStructured is available for exact claim data) ---

/**
 * Get ordered list of line texts from structured OCR.
 * Uses zone-based lines only when they preserve section headers (Claim/Patient/Provider/Service Details);
 * otherwise uses ocrStructured.lines so section-aware extraction works.
 * @param {object} ocrStructured - { blocks, lines, zones: { HEADER, SIDEBAR, BODY, FOOTER } } from OCR service
 * @returns {string[]} Line strings in reading order
 */
function zoneLinesPreserveSections(fromZones) {
  if (!fromZones || fromZones.length === 0) return false
  const needed = ['Claim Information', 'Patient Information', 'Service Details']
  for (const sectionName of needed) {
    const re = new RegExp(sectionName.replace(/\s+/g, '\\s+'), 'i')
    const found = fromZones.some((l) => typeof l === 'string' && re.test(l))
    if (!found) return false
  }
  return true
}

export function getLinesFromStructured(ocrStructured) {
  if (!ocrStructured) return []
  const flatLines = Array.isArray(ocrStructured.lines) ? ocrStructured.lines.filter((l) => typeof l === 'string' && l.trim().length > 0) : []

  const zones = ocrStructured.zones
  if (zones && typeof zones === 'object') {
    const body = Array.isArray(zones.BODY) ? zones.BODY : []
    const header = Array.isArray(zones.HEADER) ? zones.HEADER : []
    const sidebar = Array.isArray(zones.SIDEBAR) ? zones.SIDEBAR : []
    const footer = Array.isArray(zones.FOOTER) ? zones.FOOTER : []
    const fromZones = [...header, ...sidebar, ...body, ...footer].filter((l) => typeof l === 'string' && l.trim().length > 0)
    if (fromZones.length > 0 && zoneLinesPreserveSections(fromZones)) return fromZones
  }

  return flatLines
}

/**
 * Find which line index a section header appears on (case-insensitive).
 * @param {string[]} lines - From getLinesFromStructured(ocrStructured)
 * @param {string} sectionName - e.g. "Patient Information"
 * @returns {number} Line index or -1
 */
export function findSectionLineIndex(lines, sectionName) {
  if (!lines || !sectionName) return -1
  const re = new RegExp(sectionName.replace(/\s+/g, '\\s+'), 'i')
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i
  }
  return -1
}

/**
 * Get lines for a section from structured OCR, bounded by next known section or end.
 * Uses zone-based lines (BODY/HEADER) when available for claims UI.
 * @param {object} ocrStructured - { lines, zones } from OCR
 * @param {string} sectionName - e.g. "Service Details"
 * @param {number} maxLines - Max lines to return (default 50)
 * @returns {string[]} Line strings for that section
 */
export function getSectionLinesFromStructured(ocrStructured, sectionName, maxLines = 50) {
  const lines = getLinesFromStructured(ocrStructured)
  if (lines.length === 0) return []
  const startIdx = findSectionLineIndex(lines, sectionName)
  if (startIdx === -1) return []
  const afterHeader = startIdx + 1
  let endIdx = lines.length
  for (const header of SECTION_HEADERS) {
    if (header.toLowerCase() === sectionName.toLowerCase()) continue
    const idx = findSectionLineIndex(lines.slice(afterHeader), header)
    if (idx !== -1 && afterHeader + idx < endIdx) endIdx = afterHeader + idx
  }
  return lines.slice(afterHeader, Math.min(afterHeader + maxLines, endIdx))
}

/**
 * Get full text from structured OCR (lines joined by newline).
 * Use when you want section-aware text that respects OCR line boundaries.
 */
export function getTextFromStructured(ocrStructured) {
  const lines = getLinesFromStructured(ocrStructured)
  return lines.join('\n')
}
