/**
 * Tag extraction utility
 * Extracts important keywords/tags from OCR text
 */

// Common stop words to filter out
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'up', 'about', 'into', 'through', 'during', 'including', 'against', 'among',
  'throughout', 'despite', 'towards', 'upon', 'concerning', 'to', 'of', 'in', 'for', 'on',
  'at', 'by', 'with', 'from', 'up', 'about', 'into', 'through', 'during', 'including',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may',
  'might', 'must', 'can', 'it', 'its', 'they', 'them', 'their', 'there', 'then', 'than',
  'when', 'where', 'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'now'
]);

// Minimum word length for tags
const MIN_TAG_LENGTH = 3;

// Maximum number of tags to extract
const MAX_TAGS = 10;

/**
 * Extract important tags from OCR text
 * @param {string} text - OCR extracted text
 * @returns {string[]} Array of important tags/keywords
 */
export function extractTags(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  // Clean and normalize text
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  if (!cleaned) {
    return [];
  }
  
  // Split into words
  const words = cleaned.split(' ');
  
  // Filter and count words
  const wordCounts = new Map();
  
  for (const word of words) {
    const trimmed = word.trim();
    
    // Skip if too short, is a stop word, or is a number
    if (
      trimmed.length < MIN_TAG_LENGTH ||
      STOP_WORDS.has(trimmed) ||
      /^\d+$/.test(trimmed) // Skip pure numbers
    ) {
      continue;
    }
    
    // Count word frequency
    wordCounts.set(trimmed, (wordCounts.get(trimmed) || 0) + 1);
  }
  
  // Sort by frequency (descending) and take top tags
  const sortedTags = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by frequency
    .slice(0, MAX_TAGS)
    .map(([word]) => word); // Extract just the words
  
  return sortedTags;
}

/**
 * Extract important phrases (2-3 word combinations) from OCR text
 * @param {string} text - OCR extracted text
 * @returns {string[]} Array of important phrases
 */
export function extractPhrases(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!cleaned) {
    return [];
  }
  
  const words = cleaned.split(' ');
  const phrases = new Set();
  
  // Extract 2-word phrases
  for (let i = 0; i < words.length - 1; i++) {
    const word1 = words[i].trim();
    const word2 = words[i + 1].trim();
    
    if (
      word1.length >= MIN_TAG_LENGTH &&
      word2.length >= MIN_TAG_LENGTH &&
      !STOP_WORDS.has(word1) &&
      !STOP_WORDS.has(word2)
    ) {
      phrases.add(`${word1} ${word2}`);
    }
  }
  
  return Array.from(phrases).slice(0, 5); // Return top 5 phrases
}

