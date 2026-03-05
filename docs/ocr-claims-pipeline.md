# OCR & Claim Extraction Pipeline

## Overview

1. **Image → OCR** (`src/services/ocrService.js`): Preprocess image (sharp), then Tesseract.js with intelligent zone detection. Output: `{ text, structured: { blocks, lines, zones, htmlStructure } }`.
2. **Storage**: `ScreenshotEvent` stores `ocrText` and `ocrStructured` in MongoDB for section-aware parsing.
3. **Claim extraction** (`src/services/tagsEngine/`): Section-aware extractors use `ocrStructured` for exact fields. Result saved as structured JSON in `OcrClaim` (ocr_claims).
4. **Optional LLM**: If `OLLAMA_URL` is set, OCR text is sent to Ollama to extract/fill fields; result is merged into the claim.

## Structured Output & Where It Is Saved

The full structured OCR result (including zones and htmlStructure) is saved in **MongoDB on the ScreenshotEvent document**, in the field **`ocrStructured`** (Mixed type). It is written whenever OCR runs: on new screenshot ingestion (`collect.js` / analytics) and when you click **Reprocess Claims** (which re-runs OCR on all screenshots with image data and saves the new structured result).

Structure:

- `blocks` – Tesseract's native block/paragraph/line/word hierarchy with bounding boxes
- `lines` – Flat list of all text lines in reading order
- `zones` – `{ HEADER, SIDEBAR, BODY, FOOTER }` — each containing an array of formatted text lines (used for claim extraction)
- `htmlStructure` – HTML-like tagged string (`<HEADER>...</HEADER><BODY>...</BODY>` etc.)
- `hasSidebar` – Whether a sidebar was detected via gap analysis

Claim extractors always use this structured data when present: `getLinesFromStructured(ocrStructured)` prefers zone-based lines (BODY, then HEADER, etc.) for claims UI.

## Env

- `OLLAMA_URL` – Optional Ollama base URL for LLM claim enrichment.
