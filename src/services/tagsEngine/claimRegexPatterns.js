/**
 * Centralized regex patterns for claim extraction from OCR text.
 * Mirrors the generic regex logbook (Python) for consistent extraction.
 * Update this file when you refine or add patterns; extractors use it as single source of truth.
 */

// ========== FLAT FIELD PATTERNS (key = field name, value = regex source) ==========
export const PATTERNS = {
  page_url: '(?:https?://)?(?:[a-zA-Z0-9-]+\\.)+(?:com|app|org|net|io|gov)(?:/[^\\s]*)?\\b',
  app_name: '(?:Portal|App|System|Platform|Powered\\s*by)\\s*[:\\-]?\\s*([A-Za-z0-9\\s]+?)(?=\\s*\\-\\s*|v\\d|\\n|\\||$)',
  operator_email: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
  operator_name: '\\b(?:Logged\\s*in\\s*as|User|Assigned\\s*To|Owner|Examiner)\\s*[:#\\-]?\\s*([A-Za-z0-9\\s]+?)(?=\\s*\\||\\n|@|$)',
  screen_timestamp: '\\b(?:\\d{1,2}/\\d{1,2}/\\d{2,4}\\s+)?\\d{1,2}:\\d{2}\\s?(?:AM|PM)\\b|\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\b',
  claim_type: '\\bClaim\\s*Type\\s*[:\\-\\s]*\\s*([A-Za-z0-9\\s/\\-&]+?)(?=\\s{2,}|\\s+Service\\s+Details|\\s+Settings|\\s+Reports|\\s*\\n|$)',
  claim_type_strict: '\\bClaim\\s*Type\\s*[:\\-]?\\s*(Professional|Institutional|Dental|Pharmacy|Medical|Behavioral|837P|837I|Professional\\s*Claim|Institutional\\s*Claim)\\b',
  /** OCR-exact: any value after Claim Type (handles newline/split layout) */
  claim_type_raw: '\\bClaim\\s*Type\\s*[:\\-]?\\s*[\\s\\n]*([A-Za-z0-9\\s/\\-]+?)(?=\\s+Reports|\\s+Settings|\\s+Claim\\s+Information|\\s*General|\\s*Auth|\\s*Member|\\s*Status|\\s*Patient|\\s*Provider|\\s*Service|\\n\\s*[A-Z]|$)',
  priority_level: '\\b(?:Priority|Severity)\\s*[:\\-]?\\s*(High|Medium|Low|Urgent|Routine|Normal)\\b',
  priority_with_code: '\\bPriority\\s*[:\\-]?\\s*(\\d+\\s+[A-Za-z]+)\\b',
  workflow_status: '\\b(?:Status|State|Workflow|Claim\\s*Status)\\s*[:\\-]?\\s*(Needs\\s*Review|Needs\\s*Repair|Needs\\s*Repricing|Paid|Denied|Voided|In\\s*Progress|Final|Pending|Active|Awaiting\\s*action|Being\\s*processed|Require\\s*attention|PENDING\\s*REVIEW)\\b',
  status_with_code: '\\bStatus\\s*[:\\-]?\\s*(\\d+\\s+[A-Za-z\\s]+?)(?=\\s*Date|\\n|\\s*Auth|\\s*Claim|$)',
  /** OCR-exact: capture whatever follows Status: (no fixed list, no normalization) */
  status_raw: '\\b(?:Claim\\s+)?Status\\s*[:\\-]?\\s*([\\s\\S]+?)(?=\\s*Date\\s+Received|\\s*Received\\s+Date|\\s*Auth/Referral|\\s*Auth/Ref\\s*Status|\\s*Claim\\s+Type|\\s*General\\s+Information|\\s*Service\\s+Date|\\s*Assigned\\s+To)',
  /** OCR-exact: capture whatever follows Auth/Ref Status (no fixed list) */
  auth_ref_status_raw: '\\bAuth/Ref\\s*Status\\s*(?:\\([^)]+\\))?\\s*[:\\-]?\\s*([\\s\\S]+?)(?=\\s*Auth/Ref\\s*Status|\\s*Claim\\s+Type|\\s*General\\s+Information|\\s*Service\\s+Date)',
  date_received: '\\bDate\\s*Received\\s*[:\\-]?\\s*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\b',
  /** Allows newline/extra space between label and date (split layout) */
  date_received_flex: '\\b(?:Date\\s*Received|Received\\s*Date)\\s*[:\\-]?\\s*[\\s\\n]*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\b',
  birth_date: '\\bBirth\\s*Date\\s*[:\\-]?\\s*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\b',
  pend_reason: '\\b(?:Pend|Denial)\\s*Reason\\s*[:\\-]?\\s*([A-Za-z0-9\\s,\\-]+)(?:\\n|$)',

  claim_id: '\\b(?:Claim\\s*ID|Claim\\s*#|ICN|DCN|Control\\s*No|Claim\\s*D|#)\\s*([A-Za-z0-9\\-]{4,25})\\b',
  professional_claim_id: '\\bProfessional\\s*Claim\\s*(?::|[\\-\u2014\u2013])?\\s*(?:[\u2014\u2013]\\s*)?\\s*([0-9]{14,25}[A-Za-z]{0,5})\\b',
  member_id: '\\b(?:Member\\s*ID|MemberID|MEM-|Subscriber\\s*ID|Policy\\s*#)\\s*[:#]?\\s*((?:[A-Z]\\s+)?\\d{6,}|[A-Za-z0-9\\-]{4,25})\\b',
  /** Member ID when value may be separated by icons/newline */
  member_id_flex: '\\bMember\\s*ID\\s*[:\\-]?\\s*[^A-Za-z0-9\\n]*([A-Za-z0-9\\-]{4,25})\\b',
  member_id_with_name: '\\bMember\\s*ID\\s*[:\\-]?\\s*([A-Za-z0-9\\-]{4,25})\\s+([A-Z][A-Za-z]+,\\s*[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*)(?=\\s+PCP|\\s+Provider|\\s+Primary|\\s+Service|\\s+Encounters|\\s+Birth|\\s+Gender|\\s+Place|\\s+Facility|\\s+Outcome|\\s+Payer|\\s+EDI|\\s+General|\\s*\\n|$)',
  /** Member ID and name when name is on same line or next line (\\s matches newline) */
  member_id_with_name_flex: '\\bMember\\s*ID\\s*[:\\-]?\\s*([A-Za-z0-9\\-]{4,25})\\s+([A-Z][A-Za-z]+,\\s*[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*)(?=\\s+PCP|\\s+Provider|\\s+Primary|\\s+Service|\\s+Encounters|\\s+Birth|\\s+Gender|\\s+Place|\\s+Facility|\\s+Outcome|\\s+Payer|\\s+EDI|\\s+General|\\s*\\n|$)',
  company_id: '\\bCompany\\s*ID\\s*[:\\-]?\\s*([A-Za-z0-9]+)(?=\\s|\\s*Status|\\n|$)',
  /** Standalone Provider ID (no name required) — catches split layout */
  provider_id_only: '\\bProvider\\s*ID\\s*[:\\-]?\\s*(\\d{6,})(?=\\s|\\s*Name|\\n|$)',
  /** Standalone Provider Name (optional leading digits) — catches "Provider Name: Value" */
  provider_name_only: '\\bProvider\\s*Name\\s*[:\\-]?\\s*(?:\\d{6,}\\s+)?([A-Za-z][A-Za-z\\s,.\'-]{2,80}?)(?=\\s+Service|\\s+Patient|\\s+Claim|\\s+Date|\\s+Primary|\\s+General|\\s+Auth|\\s*\\n|$)',
  provider_id_with_name: '\\bProvider\\s*ID\\s*[:\\-]?\\s*(\\d{6,})\\s+([A-Z][A-Za-z,.\\s]{2,60}?(?:\\s*(?:MD|DO|NP|DDS|DPM|PA|LCSW)\\b)?)(?=\\s+(?:Primary|Birth|Gender|Marital|EOB|MPPR|Place|Facility|Outcome|Payer|Encounters|Service|Patient|Member|Date|Auth|Claim|General|Information|Status|Company|EDI|Area|Assigned)|\\s*\\n|$)',
  primary_diagnosis: '\\bPrimary\\s*Diagnosis\\s*[:\\-]?\\s*([A-Z]\\d{2}(?:\\.[0-9A-Z]{1,4})?\\s*(?:[A-Z]\\s+)?[A-Za-z0-9\\s,.\\-]+?)(?=\\s*Birth|\\s*Gender|\\n|$)',
  place_of_service_24b: '\\bPlace\\s*of\\s*Service\\s*\\(?\\s*24\\s*b\\s*\\)?\\s*[:\\-]?\\s*(\\d{2}\\s+[A-Za-z]+)\\b',
  facility: '\\bFacility\\s*[:\\-]?\\s*(\\d+\\s+[A-Za-z\\s]+?)(?=\\s*Outcome|\\s*Place|\\s*Payer|\\n|$)',
  outcome: '\\bOutcome\\s*[:\\-]?\\s*(\\d{2}\\s+[A-Za-z\\s]+?)(?=\\s*Payer|\\n|$)',
  payer_resp: '\\bPayer\\s*Resp\\s*[:\\-]?\\s*([A-Za-z]+)\\b',
  edi_claim: '\\bEDI\\s*Claim\\s*#?\\s*[:\\-]?\\s*([0-9]{15,25})\\b',
  edi_batch_id: '\\bEDI\\s*Batch\\s*ID\\s*[:\\-]?\\s*(\\d+)\\b',
  service_date_from: '\\bService\\s*Date\\s*From\\s*[:\\-]?\\s*(\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\b',
  auth_referral: '\\bAuth/Referral\\s*#?\\d?\\s*\\(?\\d*\\)?\\s*[:\\-]?\\s*([0-9]+)\\b',
  auth_ref_status: '\\bAuth/Ref\\s*Status\\s*(?:\\([^)]+\\))?\\s*[:\\-]?\\s*(\\d+\\s+[A-Za-z]+)\\b',
  group_id: '\\bGroup\\s*(?:#|ID|No|Number)\\b\\s*[:\\-]?\\s*([A-Za-z0-9\\-]{2,30})\\b',
  plan_name: '\\b(?:Plan|Network|Product)\\s*[:\\-]?\\s*([A-Za-z0-9\\s\\-]{2,40})\\b',
  trace_eft_num: '\\b(?:Trace|EFT|Check|Draft)\\s*(?:#|Number|ID)?\\s*[:\\-]?\\s*([A-Za-z0-9\\-]{6,20})\\b',

  patient_name: '\\b(?:Patient\\s*Name|Member\\s*Name)\\b\\s*[:\\-]?\\s*([A-Za-z][A-Za-z\\s,\\.\'-]{1,58}?)(?=\\s+Member\\s|\\s+Date\\s|\\s+DOB\\s|\\s+ID\\s|\\s*\\n|\\d{1,2}/\\d{1,2}/\\d|$)',
  patient_name_strict: '\\b(?:Patient\\s*Name|Member\\s*Name)\\b\\s*[:\\-]?\\s*([A-Z][a-z]+(?:,\\s*[A-Z][a-z]+|\\s+[A-Z][a-z]+)+)\\b',
  patient_name_last_first: '\\b(?:Patient\\s*Name|Member\\s*Name|Name)\\b\\s*[:\\-]?\\s*([A-Za-z][A-Za-z]*\\s*,\\s*[A-Za-z][A-Za-z]*(?:\\s+[A-Za-z][A-Za-z]*)*)\\b',
  patient_dob: '\\b(?:DOB|Birth|Date\\s*of\\s*Birth)\\s*[:\\-]?\\s*(\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4})\\b',
  patient_gender: '\\b(?:Sex|Gender)\\s*(?:\\(\\d+\\))?\\s*[:\\-]?\\s*(M|F|Male|Female|Unknown)\\b',
  subscriber_name: '\\b(?:Subscriber|Guarantor)(?:\\s*Name)?\\s*[:\\-]?\\s*([A-Z][a-z]+(?:,\\s*[A-Z][a-z]+|\\s+[A-Z][a-z]+)+)\\b',

  billing_provider: '\\b(?:Billing\\s*Provider|Provider|Facility)\\s*[:\\-]?\\s*([A-Z0-9\\s,&.\\.\\-]+?)(?=\\s*(?:NPI|TIN|Address|\\n|$))',
  rendering_provider: '\\bRendering\\s*(?:Provider)?\\s*[:\\-]?\\s*([A-Z][a-z]+(?:,\\s*[A-Z][a-z]+|\\s+[A-Z][a-z]+(?: MD| DO| NP)?))\\b',
  provider_npi: '\\bNPI\\s*[:#]?\\s*(\\d{10})\\b',
  provider_tin: '\\b(?:TIN|Tax\\s*ID)\\s*[:#]?\\s*(\\d{2}-?\\d{7})\\b',
  state_zip: '\\b([A-Z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\b',

  received_date: '\\b(?:Received|Received\\s*Date|Date\\s*Received|Recerved\\s*Date|Recerved)\\b\\s*[:\\-]?\\s*(\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4})',
  service_date: '\\b(?:DOS|Service\\s*Date|Date\\s*of\\s*Service)\\b\\s*[:\\-]?\\s*(\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4})',
  admission_date: '\\b(?:Admit|Admission)\\s*Date\\b\\s*[:\\-]?\\s*(\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4})',
  paid_date: '\\b(?:Paid|Check|EFT)\\s*Date\\b\\s*[:\\-]?\\s*(\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4})',

  total_billed: '\\b(?:Total\\s*Billed|Total\\s*Charges|Charge\\s*Amt|Billed\\s*Amount)\\b\\s*[:|\\-]?\\s*\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  allowed_amount: '\\b(?:Total\\s*Allowed|Allowed\\s*Amount|AllowedAmount)\\b\\s*[:|\\-]?\\s*\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  total_net_pay: '\\b(?:Total\\s*Net\\s*Pay|Net\\s*Pay(?:ment)?|Total\\s*Payment)\\b\\s*[:|\\-]?\\s*\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  plan_paid: '\\b(?:Paid|Payment|Plan\\s*Paid|Payable\\s*Amount)\\b\\s*[:|\\-]?\\s*\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  patient_resp: '\\b(?:Member\\s*Resp|Patient\\s*Resp|Owed|Pt\\s*Resp)\\b\\s*[:|\\-]?\\s*\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',

  copay: '(?im)^\\s*Copay\\b[^\\n\\r]*?\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  deductible: '(?im)^\\s*Deductible\\b[^\\n\\r]*?\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',
  coinsurance: '(?im)^\\s*(?:Coinsurance|Coins)\\b[^\\n\\r]*?\\$?\\s*(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|-?\\d+(?:\\.\\d{2})?)',

  icd10_codes: '\\b([A-TV-Z][0-9][0-9A-Z](?:\\.[0-9A-Z]{1,4})?)\\b',
  cpt_codes: '\\b(\\d{5}|[A-Z]\\d{4})\\b',
  modifiers: '\\b(?:Mod|Modifier)s?\\s*[:\\-]?\\s*([A-Z0-9]{2}(?:,\\s*[A-Z0-9]{2})*)\\b',
  pos: '\\b(?:POS|Place\\s*of\\s*Service)\\b\\s*[:\\-]?\\s*(\\d{2})\\b',
  drg_code: '\\bDRG\\b\\s*[:\\-]?\\s*(\\d{3})\\b',
  revenue_code: '\\bRev(?:enue)?\\s*Code\\b\\s*[:\\-]?\\s*(\\d{3,4})\\b',

  carc_codes: '\\b(?:CO|PR|OA|PI)-\\d{1,4}\\b',
  rarc_codes: '\\bRARC\\s*[:\\-]?\\s*(M\\d{1,4}|N\\d{1,4})\\b'
}

// ========== WORKFLOW STATUS TYPO FIXES (OCR noise) ==========
export const STATUS_FIX = {
  vorded: 'Voided',
  volded: 'Voided',
  voled: 'Voided',
  revlew: 'Review',
  repalr: 'Repair',
  tbdapending: 'TBD / PENDING',
  tbdpending: 'TBD / PENDING',
  awaitingaction: 'Awaiting action',
  beingprocessed: 'Being processed',
  requireattention: 'Require attention',
  medlum: 'Medium',
  motium: 'Medium',
  emot: 'Medium',
  inprogress: 'In Progress',
  pendingreview: 'Pending Review',
  needsreview: 'Needs Review',
  needsrepair: 'Needs Repair',
  needsrepricing: 'Needs Repricing',
  innetwork: 'In-Network',
  'n-network': 'In-Network',
  renewedclalm: 'Renewed Claim',
  needsrevlew: 'Needs Review',
  needsrepalr: 'Needs Repair',
  repalr: 'Repair',
  '2pendingreview': '2 Pending Review',
  // OCR misreads of "pending" / "PENDING"
  penn: 'Pending',
  pend: 'Pending',
  pendng: 'Pending',
  pending: 'Pending',
  '1penn': '1 Pending',
  '2penn': '2 Pending',
  '3penn': '3 Pending',
  '4penn': '4 Pending',
  '5penn': '5 Pending',
  '6penn': '6 Pending',
  '1pend': '1 Pending',
  '2pend': '2 Pending',
  '3pend': '3 Pending',
  '4pend': '4 Pending',
  '5pend': '5 Pending',
  '6pend': '6 Pending',
  // OCR misreads of "denied" / "DENIED"
  denied: 'Denied',
  penied: 'Denied',
  pennid: 'Denied',
  penned: 'Denied',
  denn: 'Denied',
  denled: 'Denied',
  denieo: 'Denied',
  denleo: 'Denied',
  oenieo: 'Denied',
  deniea: 'Denied',
  penieo: 'Denied',
  // "5 penn" on status line is often misread "5 Denied" (fixed in cleanOcrNoise); keep "N penn" → "N Pending" for list/other contexts
  // So 5penn remains 5 Pending here; status-line-specific fix is in cleanOcrNoise
  // OCR misreads of "approved" / "APPROVED"
  approved: 'Approved',
  approveo: 'Approved',
  approvea: 'Approved',
  approvedclaim: 'Approved',
  // Common status normalization
  partialapproval: 'Partial Approval',
  partialapprovai: 'Partial Approval',
  paid: 'Paid',
  voided: 'Voided',
  final: 'Final'
}

/** Canonical status label by code (1–5). After extraction, status is shown as "N LABEL" (e.g. 1 APPROVED, 2 PENDING REVIEW). */
export const STATUS_CODE_CANONICAL = {
  1: 'APPROVED',
  2: 'PENDING REVIEW',
  3: 'MANUAL HOLD',
  4: 'PARTIAL APPROVAL',
  5: 'DENIED'
}

// ========== VALID CLAIM STATUS TYPES (for validation — if extracted value is not in this set, use last valid from same claim) ==========
/** Normalized status strings that are valid workflow statuses (no "Date Received", "Assigned To", etc.) */
export const VALID_STATUS_TYPES = new Set([
  'Needs Review', 'Needs Repair', 'Needs Repricing', 'Paid', 'Denied', 'Voided', 'In Progress', 'Final',
  'Pending', 'Active', 'Awaiting action', 'Being processed', 'Require attention', 'Pending Review', 'PENDING REVIEW',
  'Approved', 'Partial Approval', 'TBD / PENDING',
  '1 Pending', '2 Pending', '3 Pending', '4 Pending', '5 Pending', '6 Pending',
  '1 Denied', '2 Denied', '3 Denied', '4 Denied', '5 Denied', '6 Denied',
  '2 Pending Review',
  // Canonical status code + label (after validation)
  '1 APPROVED', '2 PENDING REVIEW', '3 MANUAL HOLD', '4 PARTIAL APPROVAL', '5 DENIED'
])

/**
 * Normalize status for comparison (lowercase, no extra spaces, optional leading digit).
 * Returns the normalized form used in VALID_STATUS_TYPES (e.g. "5 Pending" → match "5 Pending" or "Pending").
 */
function normalizedStatusForValidation(s) {
  if (!s || typeof s !== 'string') return ''
  const raw = normSpace(s)
  const codeMatch = raw.match(/^(\d{1,2})\s+(.+)$/)
  const text = codeMatch ? codeMatch[2].trim() : raw
  const key = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ')
  const withCode = codeMatch ? `${codeMatch[1]} ${text}` : text
  return { key, withCode, text }
}

/**
 * Returns true if the status is one of the known workflow status types (not a column label like "Date Received").
 */
export function isStatusValid(status) {
  if (!status || typeof status !== 'string') return false
  const raw = normSpace(status)
  if (raw.length < 2) return false
  // Reject obvious column headers / wrong-field captures
  if (/^(?:Date\s+Received|Received\s+Date|Assigned\s+To|Claim\s+Type|Auth\/Ref|Service\s+Date|General\s+Information)/i.test(raw)) return false
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) return false // date only
  const { key, withCode } = normalizedStatusForValidation(status)
  for (const v of VALID_STATUS_TYPES) {
    const vNorm = v.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ')
    if (withCode === v || key === vNorm || (key && key.includes(vNorm))) return true
  }
  if (/^(?:needs\s+review|needs\s+repair|needs\s+repricing|paid|denied|voided|in\s+progress|pending|approved|final)/i.test(key)) return true
  if (/^\d\s+(?:pending|denied|approved|review|repair)/i.test(withCode)) return true
  return false
}

/**
 * Get the most recent valid status from statusHistory (for fallback when current extraction is invalid).
 */
export function getLastValidStatusFromHistory(statusHistory) {
  if (!Array.isArray(statusHistory) || statusHistory.length === 0) return null
  for (let i = statusHistory.length - 1; i >= 0; i--) {
    const s = statusHistory[i]?.status
    if (s && isStatusValid(s)) return s
  }
  return null
}

/**
 * Get the last valid status from previous docs for the same claim (e.g. same claimId).
 * Use when current row's status is invalid — prefer the status from a prior row/doc with same claim id, not a static default.
 * @param {Array<{ status?: string, statusHistory?: Array<{ status?: string }> }>} sameClaimDocs - Previous docs for this claim (newest first)
 * @returns {string|null} First valid status found from docs' status or their statusHistory, or null
 */
export function getLastValidStatusFromPreviousDocs(sameClaimDocs) {
  if (!Array.isArray(sameClaimDocs) || sameClaimDocs.length === 0) return null
  for (const doc of sameClaimDocs) {
    if (doc?.status && isStatusValid(doc.status)) return doc.status
    const fromHistory = getLastValidStatusFromHistory(doc?.statusHistory)
    if (fromHistory) return fromHistory
  }
  return null
}

// ========== SECTION HEADERS TO IGNORE (avoid treating as field values) ==========
export const SECTION_WORDS_TO_IGNORE = [
  'patient information',
  'provider information',
  'claim information',
  'general information',
  'service details',
  'policy verification',
  'adjudication',
  'dashboard',
  'claims queue',
  'reports',
  'settings',
  'edit withlovable',
  'edit with lovable',
  'all bookmarks',
  'allbookmark',
  'all bookmark',
  'professional claim'
]

// ========== MATRIX PATTERNS (regex source) ==========
// Service line: date | code? | description | $billed [| $allowed]
export const SERVICE_LINE_MATRIX =
  '(?<line_date>\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\s*\\|?\\s*' +
  '(?<line_code>\\d{5}|[A-Z]\\d{4})?\\s*\\|?\\s*' +
  '(?<line_desc>[^$|]+?)\\s*\\|?\\s*' +
  '\\$(?<line_billed>[\\d,]+\\.\\d{2})' +
  '(?:\\s*\\|?\\s*\\$(?<line_allowed>[\\d,]+\\.\\d{2}))?'

// Professional Claim service line: [▸] Seq, From Date, To Date, Service (P-77014 / P-G6015), Mod, Diag, Qty, Billed, Contract, Net Pay, Deductible, Copay, Coinsurance, Adjustment(s), Adjust Code, Prev Paid, Prev Pat Resp, ...
// Mod+Diag: 0-2 letter-starting tokens before Qty (Qty has 3 decimal places; money has 2)
export const SERVICE_LINE_MATRIX_PRO =
  '(?<line_seq>\\d+)\\s+' +
  '(?<line_from>\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\s+' +
  '(?<line_to>\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})\\s+' +
  '(?<line_code>P-\\d{5}|P-[A-Z]\\d{4})\\s+' +
  '(?:[A-Z][A-Z0-9.]*\\s+){0,2}' +
  '(?<line_qty>\\d+\\.\\d{3})\\s+' +
  '(?<line_billed>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_contract>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_net_pay>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_deductible>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_copay>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_coinsurance>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_adjustment>[\\d,]+\\.\\d{2})\\s+' +
  '(?:\\S+\\s+)?' +
  '(?<line_prev_paid>[\\d,]+\\.\\d{2})\\s+' +
  '(?<line_prev_pat_resp>[\\d,]+\\.\\d{2})'

// Totals row: "Totals:" then Billed sum, then later Net Pay sum (flexible whitespace between)
export const TOTALS_LINE = 'Totals?:\\s*([\\d,]+\\.\\d{2})(?:\\s+[\\d.,\\s]*)?([\\d,]+\\.\\d{2})?'

// Separate total labels: "Total Billed:\n$7385.56" and "Total Net Pay:\n$5649.69"
export const TOTAL_BILLED_LABEL = '\\bTotal\\s*Billed\\s*[:\\-]?\\s*\\$?\\s*([\\d,]+\\.\\d{2})'
export const TOTAL_NET_PAY_LABEL = '\\bTotal\\s*Net\\s*Pay\\s*[:\\-]?\\s*\\$?\\s*([\\d,]+\\.\\d{2})'

// Queue table (piped)
export const QUEUE_MATRIX_PIPED =
  '^\\s*(?<claim_id>\\d{4,12})\\s*\\|\\s*' +
  '(?<patient_name>[^|]+?)\\s*\\|\\s*' +
  '(?<plan_name>[^|]+?)\\s*\\|\\s*' +
  '(?<billing_provider>[^|]+?)\\s*\\|\\s*' +
  '(?<priority_level>[^|]+?)\\s*\\|\\s*' +
  '(?<workflow_status>[^|]+)' +
  '(?:\\s*\\|\\s*(?<received_date>\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}))?\\s*$'

// Queue table (orphan / space-separated)
export const QUEUE_MATRIX_ORPHAN =
  '^(?<claim_id>\\d{4,12})\\s+' +
  '(?<patient_name>[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)+)\\s+' +
  '(?<plan_name>[A-Za-z0-9]+\\s*\\d{1,6}|\\d{2,6}|[A-Za-z0-9]{2,40})?\\s+' +
  '(?<billing_provider>[A-Za-z0-9\\s,.\\-]+?)\\s+' +
  '(?<priority_level>[A-Za-z]+)\\s+' +
  '(?<workflow_status>[A-Za-z\\s/]+?)' +
  '(?:\\s+(?<received_date>\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}))?$'

// Generic one-off patterns used by base extractors (date MM/DD/YYYY, dollar amount)
export const DATE_MMDDYYYY = '\\b(\\d{1,2})/(\\d{1,2})/(\\d{2,4})\\b'
export const AMOUNT_DOLLAR = '\\$?\\s*([-]?\\d[\\d,]*(?:\\.\\d{2})?)'

// ========== STRICT CLAIM ID PATTERNS (for best-claim-id resolution) — Professional Claim first as Claim ID ==========
export const CLAIM_ID_STRICT_PATTERNS = [
  '\\bProfessional\\s*Claim\\s*(?::|[\\-\u2014\u2013])?\\s*(?:[\u2014\u2013]\\s*)?\\s*([0-9]{14,25}[A-Za-z]{0,5})\\b',
  '\\bClaim\\s*#\\s*([A-Za-z0-9\\-]{4,25})\\b',
  '\\bClaim\\s*ID\\s*[:#\\-]?\\s*([A-Za-z0-9\\-]{4,25})\\b',
  '\\b(?:ICN|DCN|Control\\s*No)\\s*[:#\\-]?\\s*([A-Za-z0-9\\-]{4,25})\\b',
  '\\B#([A-Za-z0-9\\-]{4,25})\\b',
  '/claims/(\\d{4,25})\\b'
]

// ========== URL CLAIM ID (e.g. .../claim/2511220892041240041F or ?claimId=xxx) ==========
/** Extract Professional Claim ID from URL (path or query). ID = ~10-30 alphanumeric (numbers + letters). */
export function getClaimIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null

  // 1) Path: /claim/ID or /claims/ID — ID until next /, ?, # or end (10-40 alphanumeric so trailing part not cut off)
  let m = trimmed.match(/\/claim[s]?\/([0-9A-Za-z]{10,40})(?=[\/?#]|$)/i)
  if (m && m[1]) {
    const id = m[1]
    if (/[0-9]/.test(id)) return id
  }

  // 2) Query: ?claimId=ID or ?claim_id=ID or ?id=ID
  m = trimmed.match(/[?&](?:claimId|claim_id|id)=([0-9A-Za-z]{10,40})(?=&|#|$)/i)
  if (m && m[1]) {
    const id = m[1]
    if (/[0-9]/.test(id)) return id
  }

  // 3) Any path segment that looks like claim ID: long alphanumeric (e.g. /view/2511220892041240041F)
  m = trimmed.match(/\/([0-9]{10,}[0-9A-Za-z]{0,15})(?=[\/?#]|$)/)
  if (m && m[1]) {
    const id = m[1]
    if (id.length >= 10 && id.length <= 40) return id
  }

  return null
}

// ========== OCR NOISE CLEANING ==========
/**
 * Remove common OCR noise from claims UI screenshots.
 * Strips UI artifacts (pipes, icons, brackets, garbled dividers) while preserving actual data.
 * Should be called ONCE on raw OCR text before any regex extraction.
 */
export function cleanOcrNoise(text) {
  if (!text || typeof text !== 'string') return ''
  let s = text

  // Strip HTML zone tags (keep content between them)
  s = s.replace(/<\/?(HEADER|BODY|FOOTER|SIDEBAR)>/gi, '')

  // Remove pipe characters (UI field borders / cell separators in web claims UI)
  s = s.replace(/\|/g, ' ')

  // Remove © ® and common UI emoji/icons (lock, arrow, checkbox, link, etc.)
  s = s.replace(/[©®🔒🔓🔑▶▷◀◁☐☑☒✓✗❌⚠️ℹ️🔍🔎📋📎□■●○◆◇★☆⬅➡⬆⬇↑↓←→🔗\u200B\u200C\u200D\uFEFF]/gu, '')

  // Remove @) artifact after IDs
  s = s.replace(/@\)/g, '')

  // Remove & artifact after label colon (lock/shield icon OCR near field values)
  s = s.replace(/(:\s*)&(\s)/g, '$1$2')

  // Remove i@ artifact (lock/link icon near names/IDs)
  s = s.replace(/\bi@/g, '')

  // Remove (J (j artifacts (unchecked checkbox OCR)
  s = s.replace(/\([Jj]\b/g, '')

  // Remove [ ] immediately around digits (input field borders): "[01" → "01", "[ 11" → "11"
  s = s.replace(/\[\s*(\d)/g, '$1')
  s = s.replace(/(\d)\s*\]/g, '$1')

  // Remove standalone 'fi' token between spaces or after colon (lock icon OCR)
  s = s.replace(/([\s:])fi(\s)/g, '$1$2')

  // Remove standalone 'i' right after label colon (icon after label): ": i H" → ": H"
  s = s.replace(/(:\s*)i(\s+[A-Z0-9])/g, '$1$2')

  // Remove standalone Q between spaces before uppercase text or digits (search icon OCR)
  s = s.replace(/(\s)Q(\s+[A-Z@])/g, '$1$2')
  s = s.replace(/(\s)Q(\s+\d)/g, '$1$2')

  // Remove 'wi' before uppercase names (avatar/icon OCR artifact)
  s = s.replace(/\bwi\s+(?=[A-Z])/g, '')

  // Remove standalone 'a' between spaces before digits (sidebar icon OCR artifact: "| a 31")
  s = s.replace(/(\s)a\s+(\d)/g, '$1$2')
  // Remove standalone 'a' between digit and word (status OCR: "5 a penn" → "5 penn")
  s = s.replace(/(\d)\s+a\s+([a-zA-Z])/g, '$1 $2')

  // In status lines, "penn" is often a Tesseract misread of "Denied" (not "Pending")
  // Only replace "N penn" (digit + penn) in lines that look like Status / Auth/Ref Status
  s = s.split('\n').map((line) => {
    const isStatusLine = /\b(?:Status|Auth\/Ref\s*Status|Claim\s*Status)\s*[:\.\-]?\s*[\s\d]*/i.test(line) && /\d\s+penn\b/.test(line)
    if (isStatusLine) return line.replace(/(\d)\s+penn\b/g, '$1 Denied')
    return line
  }).join('\n')

  // Remove @ not in email context (lock/link icon): " @ " or " @WORD"
  s = s.replace(/\s@\s/g, ' ')
  s = s.replace(/(\s)@([A-Z])/g, '$1$2')

  // Remove ~~ and any ~ sequences (dropdown indicators)
  s = s.replace(/~+/g, '')

  // Remove trailing v or v. at end of lines (dropdown indicator)
  s = s.replace(/\sv\.?\s*$/gm, '')
  // Remove standalone v between spaces before label keywords (dropdown indicator in inline text)
  s = s.replace(/\sv\s+(?=Service|Auth|Payer|Status|Date|Claim|Member|Provider|General|Primary)/g, ' ')

  // Remove ## artifact (adjustment code column noise)
  s = s.replace(/\s##\s/g, ' ')

  // Remove ™ and ¥ characters (garbled OCR)
  s = s.replace(/[™¥]/g, '')

  // Remove garbled section dividers: sequences of em-dashes with noise between
  s = s.replace(/[—–]{2,}[^\n]*[—–]{2,}/g, '')
  // Remove remaining isolated em-dash sequences (2+)
  s = s.replace(/\s[—–]+\s/g, ' ')

  // Remove toolbar noise (Bx B«<D>D>>»QBRBBHDOZBOO patterns)
  s = s.replace(/B[x«][^»\n]*[»][A-Z]*/g, '')

  // Remove "Edit with Lovable" watermark
  s = s.replace(/Edit\s*with\s*Lovable\s*x?/gi, '')

  // Fix known OCR misspellings in section headers
  s = s.replace(/\bInformaton\b/gi, 'Information')
  s = s.replace(/\bInformotion\b/gi, 'Information')
  s = s.replace(/\bBiled\b/g, 'Billed')

  // Collapse space within alphanumeric member/subscriber IDs: "H 6334066489" → "H6334066489"
  s = s.replace(/\b([A-Z])\s+(\d{6,})\b/g, '$1$2')

  // Collapse space within ICD-10 codes: "E 119" → "E119", "M 545" → "M545"
  s = s.replace(/\b([A-TV-Z])\s+(\d{2,3}(?:\.\d{1,4})?)\b/g, '$1$2')

  // Normalize multiple whitespace to single space (preserve newlines)
  s = s.replace(/[^\S\n]+/g, ' ')
  s = s.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n')

  return s
}

// ========== HELPERS ==========
export function normSpace(s) {
  if (s == null || typeof s !== 'string') return ''
  return s.replace(/\s+/g, ' ').trim()
}

export function cleanMoney(val) {
  if (val == null) return null
  const s = String(val).trim().replace(/,/g, '').replace(/\$/g, '').replace(/\s/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

function normalizeStatusText(raw) {
  const key = raw.toLowerCase().replace(/[^a-z0-9/]/g, '')
  if (STATUS_FIX[key]) return STATUS_FIX[key]
  const low = raw.toLowerCase().replace(/\s/g, '')
  for (const [bad, good] of Object.entries(STATUS_FIX)) {
    if (low.includes(bad)) return good
  }
  return raw.replace(/^["']|["']$/g, '').trim()
}

export function normalizeWorkflowStatus(s) {
  if (!s) return s
  const raw = normSpace(s)
  // "1 : APPROVED" / "2 : PENDING REVIEW" / "3 : MANUAL HOLD" etc. → "1 APPROVED", "2 PENDING REVIEW", ...
  const withColon = raw.match(/^([\dliI|]{1,2})\s*:\s*(.+)$/i)
  const noColon = raw.match(/^(\d{1,2})\s+(.+)$/)
  const codeAndLabel = withColon
    ? [withColon[1].trim(), withColon[2].trim()]
    : noColon
      ? [noColon[1], noColon[2].trim()]
      : null
  if (codeAndLabel) {
    const codeStr = fixStatusCodeOcr(codeAndLabel[0])
    const code = parseInt(codeStr, 10)
    if (Number.isFinite(code) && code >= 1 && code <= 5 && STATUS_CODE_CANONICAL[code]) {
      return `${code} ${STATUS_CODE_CANONICAL[code]}`
    }
    const normalized = normalizeStatusText(codeAndLabel[1])
    return `${codeStr} ${normalized}`
  }
  return normalizeStatusText(raw)
}

/**
 * Fix OCR misreads of status code digits: "l" / "I" / "i" → "1", "O" → "0", etc.
 * Only applied to short strings that should be a digit (1-2 chars).
 */
export function fixStatusCodeOcr(s) {
  if (!s || typeof s !== 'string') return s
  const t = s.trim()
  if (t.length > 2) return t
  return t
    .replace(/[lIi|]/g, '1')
    .replace(/[Oo]/g, '0')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
}

const NAME_TRAILING_NOISE_RE = /\s+(?:PCP|Service|Area|Provider|Primary|Diagnosis|Birth|Gender|Marital|Status|Information|Date|DOB|Phone|Address|Email|Fax|Zip|City|State|Group|Plan|Network|Encounters|Indicator|Resp|EOB|MPPR|C\.?O\.?B|Payer|Place|Facility|Outcome|Subscriber|General|Auth|Member|Referral)(?:\s.*)?$/i

/**
 * Sanitize a person name (patient or provider) by removing trailing field-label words
 * that OCR captured beyond the actual name.
 */
export function sanitizePersonName(name) {
  if (!name || typeof name !== 'string') return name
  let clean = name.trim()
  clean = clean.replace(NAME_TRAILING_NOISE_RE, '').trim()
  // Remove trailing comma left over after stripping noise (e.g. "DAVIS," → "DAVIS")
  clean = clean.replace(/,\s*$/, '').trim()
  if (clean.length < 2) return name.trim()
  return clean
}

/**
 * Remove noise from provider name: @, ID, NPI, TIN, and similar labels/characters.
 * Keeps commas (e.g. "Last, First").
 */
export function sanitizeProviderName(providerName) {
  if (!providerName || typeof providerName !== 'string') return ''
  let v = providerName.trim()
  // Remove noise characters (keep letters, digits in short groups, commas, spaces, hyphen, apostrophe, period)
  v = v.replace(/@/g, '')
  v = v.replace(/[#*]/g, ' ') // bullets / noise
  // Remove "ID : 123456" or "ID: 123456" or "ID 123456" (label + optional colon + provider ID)
  v = v.replace(/\bID\s*[:\-]?\s*\d{6,}\b/gi, ' ')
  v = v.replace(/\bNPI\s*[:\-]?\s*\d*/gi, ' ')
  v = v.replace(/\bTIN\s*[:\-]?\s*\d*/gi, ' ')
  // Remove standalone 6+ digit numbers (provider IDs)
  v = v.replace(/\b\d{6,}\b/g, ' ')
  // Remove leading/trailing standalone labels (word boundary so "Idaho" is kept)
  v = v.replace(/^\s*(?:ID|NPI|TIN|Provider)\s*[:\-]?\s*/gi, ' ')
  v = v.replace(/\s*(?:ID|NPI|TIN)\s*[:\-]?\s*$/gi, ' ')
  v = v.replace(/\b(?:ID|NPI|TIN)\b/gi, ' ') // standalone anywhere (e.g. "Name, ID" -> "Name,")
  // Collapse multiple spaces, trim (preserve commas)
  v = v.replace(/\s{2,}/g, ' ').trim()
  // Remove leading/trailing comma+space or space+comma left as noise
  v = v.replace(/^[,\s]+|[,\s]+$/g, '').trim()
  if (v.length < 2 || !/[A-Za-z]/.test(v)) return ''
  return v
}

/** Strip one leading non-letter from a patient name candidate (e.g. leftover lock/icon). */
export function stripLeadingNameNoise(s) {
  if (!s || typeof s !== 'string') return s
  const t = s.trim()
  if (t.length < 3) return t
  if (/[A-Za-z]/.test(t.charAt(0))) return t
  const rest = t.slice(1).trim()
  if (rest.length >= 2 && /^[A-Za-z]/.test(rest)) return rest
  return t
}

export function isPlausibleClaimId(val) {
  if (!val) return false
  const v = String(val).trim()
  if (v.length < 4 || v.length > 25) return false
  if (!/\d/.test(v)) return false
  if (!/^[A-Za-z0-9\-]+$/.test(v)) return false
  if (/etail|detail/i.test(v)) return false
  return true
}

export function isValidCpt(val) {
  if (!val) return false
  return /^(?:\d{5}|[A-Z]\d{4})$/.test(String(val).trim())
}

export function looksLikeSectionHeader(s) {
  if (!s) return false
  const t = normSpace(s).toLowerCase()
  if (SECTION_WORDS_TO_IGNORE.includes(t)) return true
  return SECTION_WORDS_TO_IGNORE.some(w => t.startsWith(w))
}

// ========== COMPILED REGEXES (for extractors) ==========
export function getCompiled(name, flags = 'i') {
  const src = PATTERNS[name]
  return src ? new RegExp(src, flags) : null
}

export function getClaimIdRegex() {
  return new RegExp(PATTERNS.claim_id, 'i')
}

export function getMemberIdRegex() {
  return new RegExp(PATTERNS.member_id, 'i')
}

export function getReceivedDateRegex() {
  return new RegExp(PATTERNS.received_date, 'i')
}

export function getWorkflowStatusRegex() {
  return new RegExp(PATTERNS.workflow_status, 'i')
}

export function getServiceLineMatrixRegex() {
  return new RegExp(SERVICE_LINE_MATRIX, 'gi')
}

export function getServiceLineMatrixProRegex() {
  return new RegExp(SERVICE_LINE_MATRIX_PRO, 'gi')
}

export function getTotalsLineRegex() {
  return new RegExp(TOTALS_LINE, 'i')
}

export function getTotalBilledLabelRegex() {
  return new RegExp(TOTAL_BILLED_LABEL, 'i')
}

export function getTotalNetPayLabelRegex() {
  return new RegExp(TOTAL_NET_PAY_LABEL, 'i')
}

export function getQueueMatrixPipedRegex() {
  return new RegExp(QUEUE_MATRIX_PIPED, 'im')
}

export function getQueueMatrixOrphanRegex() {
  return new RegExp(QUEUE_MATRIX_ORPHAN, 'im')
}
