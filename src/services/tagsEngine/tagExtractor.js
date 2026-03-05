/**
 * Tag extraction for OCR text (keywords/phrases).
 * Part of the tags engine – used for searchable tags on claims.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'up', 'about', 'into', 'through', 'during', 'including', 'against', 'among',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may',
  'might', 'must', 'can', 'it', 'its', 'they', 'them', 'their', 'there', 'then', 'than',
  'when', 'where', 'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'too', 'very', 'just', 'now'
])

const MIN_TAG_LENGTH = 3
const MAX_TAGS = 10

export function extractTags(text) {
  if (!text || typeof text !== 'string') return []
  const cleaned = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const wordCounts = new Map()
  for (const word of cleaned.split(' ')) {
    const trimmed = word.trim()
    if (trimmed.length < MIN_TAG_LENGTH || STOP_WORDS.has(trimmed) || /^\d+$/.test(trimmed)) continue
    wordCounts.set(trimmed, (wordCounts.get(trimmed) || 0) + 1)
  }
  return Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS)
    .map(([word]) => word)
}

export function extractPhrases(text) {
  if (!text || typeof text !== 'string') return []
  const cleaned = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const words = cleaned.split(' ')
  const phrases = new Set()
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i].trim()
    const w2 = words[i + 1].trim()
    if (w1.length >= MIN_TAG_LENGTH && w2.length >= MIN_TAG_LENGTH && !STOP_WORDS.has(w1) && !STOP_WORDS.has(w2)) {
      phrases.add(`${w1} ${w2}`)
    }
  }
  return Array.from(phrases).slice(0, 5)
}
