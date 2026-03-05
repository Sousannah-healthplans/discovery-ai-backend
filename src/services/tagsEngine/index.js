/**
 * Tags engine – intelligent claim extraction from OCR text
 * Exports extraction, merging, and text parsing used by routes and scripts.
 */

export { extractClaimFromScreenshotEvent } from './claimExtractionService.js'
export { mergeClaims, mergeServiceDetails, mergeAdjudication } from './claimMerger.js'
export { normalizeWhitespace, getSectionText, truncateAtDelimiters, parseDate, extractOne, extractAll } from './textParser.js'
export { IntelligentExtractor } from './intelligentExtractor.js'
export { extractTags, extractPhrases } from './tagExtractor.js'
