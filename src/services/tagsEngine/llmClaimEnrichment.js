/**
 * Optional LLM-based claim enrichment.
 * When OLLAMA_URL is set, sends OCR text to a local Ollama model to extract/fill claim fields
 * and merges the result with rule-based extraction for smarter, layout-agnostic parsing.
 */

const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/+$/, '')

const EXTRACTION_PROMPT = `You are a claim data extractor. Given OCR text from a healthcare claims web page or screenshot, extract structured JSON with these fields only. Use null for missing values. Return ONLY valid JSON, no markdown or explanation.

Fields to extract:
- claimId (string, digits only if present)
- status (e.g. Needs Review, Paid, Denied)
- claimType (string)
- providerName (string)
- patientName (string)
- memberId (string, e.g. MEM-xxx)
- receivedDate (MM/DD/YYYY or null)
- dob (MM/DD/YYYY or null)
- serviceDetails: array of { serviceDate, cptCode, description, billedAmount, allowedAmount }
- adjudication: { billedAmount, allowedAmount, deductible, payableAmount }

OCR text:
"""
{{OCR_TEXT}}
"""

Return only the JSON object.`

/**
 * Call Ollama to extract claim JSON from OCR text.
 * @param {string} ocrText
 * @param {{ model?: string, timeoutMs?: number }} options
 * @returns {Promise<object|null>} Parsed claim-like object or null
 */
export async function extractClaimWithLlm(ocrText, options = {}) {
  if (!OLLAMA_URL || !ocrText || ocrText.trim().length < 20) return null
  const model = options.model || 'llama3.2'
  const timeoutMs = options.timeoutMs ?? 30000
  const url = `${OLLAMA_URL}/api/generate`
  const body = {
    model,
    prompt: EXTRACTION_PROMPT.replace('{{OCR_TEXT}}', ocrText.slice(0, 6000)),
    stream: false,
    options: { temperature: 0.1, num_predict: 1024 }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const data = await res.json()
    const raw = (data.response || '').trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    return parsed
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[LLM Enrichment] Ollama call failed:', e.message)
    }
    return null
  }
}

/**
 * Merge LLM-extracted object into rule-based claim. Only fill missing or empty fields.
 * @param {object} claim - From rule-based extractor
 * @param {object} llmResult - From extractClaimWithLlm
 * @returns {object} Merged claim
 */
export function mergeLlmIntoClaim(claim, llmResult) {
  if (!claim || !llmResult) return claim
  const out = { ...claim }
  const setIfMissing = (key, src) => {
    const v = src[key]
    if (v != null && v !== '' && (typeof v !== 'string' || v.trim())) {
      if (out[key] == null || out[key] === '') out[key] = v
    }
  }
  setIfMissing('status', llmResult)
  setIfMissing('claimType', llmResult)
  setIfMissing('providerName', llmResult)
  setIfMissing('patientName', llmResult)
  setIfMissing('memberId', llmResult)
  setIfMissing('receivedDate', llmResult)
  setIfMissing('dob', llmResult)
  if (Array.isArray(llmResult.serviceDetails) && llmResult.serviceDetails.length > 0) {
    if (!Array.isArray(out.serviceDetails) || out.serviceDetails.length === 0) {
      out.serviceDetails = llmResult.serviceDetails
    }
  }
  if (llmResult.adjudication && typeof llmResult.adjudication === 'object') {
    if (!out.adjudication || Object.keys(out.adjudication || {}).length === 0) {
      out.adjudication = llmResult.adjudication
    }
  }
  return out
}
