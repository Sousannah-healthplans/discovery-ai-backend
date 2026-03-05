import Tesseract from 'tesseract.js';
import sharp from 'sharp';

/**
 * OCR Service for processing screenshots — Tesseract.js only.
 * Returns { text, structured } with intelligent zone-based layout (HEADER/SIDEBAR/BODY/FOOTER)
 * optimised for claims UI pages. All processing is 100% local.
 */

// ─── OCR text cleaning (fixes common Tesseract artefacts) ────────────────────

const KNOWN_FIXES = {
  'Clalm': 'Claim',
  'Clairn': 'Claim',
  'Arnount': 'Amount',
  'Arnout': 'Amount',
  'lnformation': 'Information',
  'Detalls': 'Details',
  'Servlce': 'Service',
  'Provlder': 'Provider',
  'Patlent': 'Patient',
  'Recelved': 'Received',
  'Adjudlcation': 'Adjudication',
  'Verlfication': 'Verification',
  'Polley': 'Policy',
  'Bllled': 'Billed',
  'Alloved': 'Allowed',
  'Allowed': 'Allowed',
  'Dlagnosis': 'Diagnosis',
  'Denled': 'Denied',
  'Denieo': 'Denied',
  'Approveo': 'Approved',
  'Approvea': 'Approved',
};

function cleanOcrText(text) {
  if (!text) return '';

  // Fix camelCase-joined words (e.g. "thirstyHe" → "thirsty He")
  text = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Fix letters glued to digits (e.g. "DOB02" → "DOB 02")
  text = text.replace(/([a-zA-Z])(\d)/g, '$1 $2');
  text = text.replace(/(\d)([a-zA-Z])/g, '$1 $2');

  for (const [fault, fix] of Object.entries(KNOWN_FIXES)) {
    text = text.replaceAll(fault, fix);
  }
  return text.trim();
}

// ─── Image preprocessing ─────────────────────────────────────────────────────

async function preprocessImage(imageBuffer) {
  let image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;
  const maxSide = Math.max(width, height);

  if (maxSide < 1000) {
    const scale = 1000 / maxSide;
    image = image.resize(
      Math.round(width * scale),
      Math.round(height * scale),
      { kernel: 'lanczos3' }
    );
  }

  image = image
    .greyscale()
    .normalize()
    .sharpen();

  return await image.toBuffer();
}

// ─── Intelligent zone detection (adapted from IntelligentDocParser) ──────────

/**
 * Build structured zones from Tesseract word-level data.
 * Groups words into rows by Y-coordinate, detects sidebar via gap analysis,
 * and routes into HEADER / SIDEBAR / BODY / FOOTER zones.
 * Produces an HTML-like structured JSON for downstream claim extraction.
 */
function buildZonesFromTesseractData(data) {
  const pageWidth = data.width || 1920;
  const pageHeight = data.height || 1080;
  if (!pageWidth || !pageHeight) return null;

  // Step 1: Collect every word with its bounding box
  const allWords = [];
  for (const block of (data.blocks || [])) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const word of (line.words || [])) {
          const cleaned = cleanOcrText(word.text || '');
          if (!cleaned) continue;
          const bb = word.bbox;
          if (!bb) continue;
          allWords.push({
            text: cleaned,
            bbox: [bb.x0, bb.y0, bb.x1, bb.y1]
          });
        }
      }
    }
  }

  if (allWords.length === 0) return null;

  // Step 2: Sort by vertical center and group into rows
  allWords.sort((a, b) => ((a.bbox[1] + a.bbox[3]) / 2) - ((b.bbox[1] + b.bbox[3]) / 2));

  const rows = [];
  let currRow = [allWords[0]];

  for (let i = 1; i < allWords.length; i++) {
    const y1 = (currRow[0].bbox[1] + currRow[0].bbox[3]) / 2;
    const y2 = (allWords[i].bbox[1] + allWords[i].bbox[3]) / 2;
    if (Math.abs(y2 - y1) < (pageHeight * 0.015)) {
      currRow.push(allWords[i]);
    } else {
      rows.push(currRow.slice().sort((a, b) => a.bbox[0] - b.bbox[0]));
      currRow = [allWords[i]];
    }
  }
  rows.push(currRow.slice().sort((a, b) => a.bbox[0] - b.bbox[0]));

  // Step 3: Detect sidebar via gap analysis
  let hasSidebar = false;
  for (const row of rows) {
    if (row.length > 1) {
      const first = row[0];
      const second = row[1];
      if (first.bbox[2] < (pageWidth * 0.25) && (second.bbox[0] - first.bbox[2]) > (pageWidth * 0.10)) {
        hasSidebar = true;
        break;
      }
    }
  }

  // Step 4: Route words into zones
  const zones = { HEADER: [], SIDEBAR: [], BODY: [], FOOTER: [] };

  for (const row of rows) {
    const yCenter = (row[0].bbox[1] + row[0].bbox[3]) / 2;
    const sidebarItems = [];
    const bodyItems = [];

    for (const w of row) {
      if (yCenter < (pageHeight * 0.12)) {
        zones.HEADER.push(w);
      } else if (yCenter > (pageHeight * 0.88)) {
        zones.FOOTER.push(w);
      } else if (hasSidebar && w.bbox[2] < (pageWidth * 0.25)) {
        sidebarItems.push(w);
      } else {
        bodyItems.push(w);
      }
    }

    if (sidebarItems.length) zones.SIDEBAR.push(sidebarItems);
    if (bodyItems.length) zones.BODY.push(bodyItems);
  }

  // Step 5: Format each zone into readable lines with table separators
  function formatZone(zoneRows, isBody = false) {
    const output = [];
    for (let row of zoneRows) {
      if (!Array.isArray(row)) row = [row];
      let lineStr = '';
      for (let j = 0; j < row.length; j++) {
        if (j > 0) {
          const gap = row[j].bbox[0] - row[j - 1].bbox[2];
          if (gap > (pageWidth * 0.04) && isBody) {
            lineStr += '   |   ';
          } else {
            lineStr += ' ';
          }
        }
        lineStr += row[j].text;
      }
      if (lineStr.trim()) output.push(lineStr.trim());
    }
    return output;
  }

  const formattedZones = {};
  if (zones.HEADER.length) formattedZones.HEADER = formatZone([zones.HEADER]);
  if (zones.SIDEBAR.length) formattedZones.SIDEBAR = formatZone(zones.SIDEBAR);
  if (zones.BODY.length) formattedZones.BODY = formatZone(zones.BODY, true);
  if (zones.FOOTER.length) formattedZones.FOOTER = formatZone([zones.FOOTER]);

  // Build HTML-like string for easier downstream consumption
  let htmlStructure = '';
  for (const [tag, lines] of Object.entries(formattedZones)) {
    htmlStructure += `<${tag}>\n`;
    for (const line of lines) {
      htmlStructure += `  ${line}\n`;
    }
    htmlStructure += `</${tag}>\n`;
  }

  return {
    zones: formattedZones,
    htmlStructure: htmlStructure.trim(),
    pageWidth,
    pageHeight,
    hasSidebar,
    totalWords: allWords.length,
    totalRows: rows.length
  };
}

// ─── Build structured result from Tesseract data ─────────────────────────────

function buildStructuredFromTesseractData(data) {
  const blocks = (data.blocks || []).map((block) => {
    const paragraphs = (block.paragraphs || []).map((para) => {
      const lines = (para.lines || []).map((line) => {
        const lineText = cleanOcrText(
          (line.text && line.text.trim()) ||
          (line.words && line.words.map((w) => w.text).join(' ').trim()) ||
          ''
        );
        const words = (line.words || []).map((w) => ({
          text: cleanOcrText(w.text || ''),
          bbox: w.bbox ? { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 } : undefined
        }));
        return { text: lineText, words };
      }).filter((l) => l.text.length > 0);
      return { lines };
    }).filter((p) => p.lines.length > 0);
    return { paragraphs };
  }).filter((b) => b.paragraphs.length > 0);

  const lines = [];
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        if (line.text) lines.push(line.text);
      }
    }
  }

  // Add intelligent zone detection
  const zoneData = buildZonesFromTesseractData(data);

  return {
    blocks,
    lines,
    ...(zoneData || {})
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract text and structured layout from image using Tesseract OCR.
 * Returns structured zones (HEADER/SIDEBAR/BODY/FOOTER) optimised for claims UI.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ text: string, structured: object, engine: 'tesseract' }>}
 */
export async function extractTextAndStructuredFromImage(imageBuffer) {
  try {
    console.log('[OCR Service] Starting image preprocessing...');
    const processedBuffer = await preprocessImage(imageBuffer);
    console.log('[OCR Service] Preprocessing complete, buffer size:', processedBuffer.length);

    console.log('[OCR Service] Starting Tesseract OCR recognition...');
    const { data } = await Tesseract.recognize(
      processedBuffer,
      'eng',
      {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pct = Math.round(m.progress * 100);
            if (pct === 0 || pct === 50 || pct === 100) {
              console.log(`[OCR Service] Progress: ${pct}%`);
            }
          } else if (m.status) {
            console.log(`[OCR Service] Status: ${m.status}`);
          }
        }
      }
    );

    const rawText = (data.text || '').trim();
    const text = cleanOcrText(rawText);
    const structured = buildStructuredFromTesseractData(data);

    console.log(`[OCR Service] OCR complete (tesseract): ${text.length} chars, ${structured.lines.length} lines, ${structured.blocks.length} blocks`);
    if (structured.zones) {
      const zoneNames = Object.keys(structured.zones).join(', ');
      console.log(`[OCR Service] Zones detected: ${zoneNames} | Sidebar: ${structured.hasSidebar} | Words: ${structured.totalWords} | Rows: ${structured.totalRows}`);
    }
    if (text.length > 0) {
      console.log(`[OCR Service] First 100 chars: ${text.substring(0, 100)}...`);
    }

    return { text, structured, engine: 'tesseract' };
  } catch (error) {
    console.error('[OCR Service] Error extracting text:', error);
    console.error('[OCR Service] Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    throw error;
  }
}

/**
 * Extract text only from image (backward compatible).
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>}
 */
export async function extractTextFromImage(imageBuffer) {
  const { text } = await extractTextAndStructuredFromImage(imageBuffer);
  return text;
}

/**
 * Extract text and structured layout from image URL (downloads image first).
 * @param {string} imageUrl
 * @returns {Promise<{ text: string, structured: object, engine: 'tesseract' }>}
 */
export async function extractTextAndStructuredFromImageUrl(imageUrl) {
  try {
    console.log(`[OCR Service] Fetching image from URL: ${imageUrl.substring(0, 100)}...`);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    console.log(`[OCR Service] Image fetched, converting to buffer...`);
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    console.log(`[OCR Service] Buffer created: ${imageBuffer.length} bytes`);
    return await extractTextAndStructuredFromImage(imageBuffer);
  } catch (error) {
    console.error('[OCR Service] Error extracting text from URL:', error);
    console.error('[OCR Service] Error details:', {
      message: error.message,
      stack: error.stack,
      url: imageUrl.substring(0, 100)
    });
    throw error;
  }
}

/**
 * Extract text only from image URL (backward compatible).
 * @param {string} imageUrl
 * @returns {Promise<string>}
 */
export async function extractTextFromImageUrl(imageUrl) {
  const { text } = await extractTextAndStructuredFromImageUrl(imageUrl);
  return text;
}
