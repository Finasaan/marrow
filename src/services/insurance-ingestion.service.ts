/**
 * Insurance Ingestion Service
 * Handles PDF fetching, text extraction, Urdu stripping, table extraction,
 * SHA-256 hashing, paragraph-aware chunking, embedding generation, and storage.
 *
 * Fully self-contained — no cross-worker calls to spine.
 */

import { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Types
// ============================================================================

export interface CleanedDocument {
  company_id: string;
  company_name: string;
  policy_name: string;
  doc_type: string;
  source_url: string;
  raw_text: string;
  cleaned_text: string;
  document_hash: string;
}

export interface InsuranceChunkData {
  chunk_index: number;
  chunk_type: "body" | "table";
  text: string;
  char_start: number;
  char_end: number;
  metadata: Record<string, unknown>;
}

export interface ProcessedPDF {
  document: CleanedDocument;
  chunks: InsuranceChunkData[];
}

// ============================================================================
// PDF Fetching
// ============================================================================

/**
 * Fetch a PDF from URL and return its ArrayBuffer
 */
async function fetchPDF(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Finasaan-InsuranceBot/1.0",
      Accept: "application/pdf",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch PDF from ${url}: ${response.status}`);
  }

  return response.arrayBuffer();
}

// ============================================================================
// Text Extraction
// ============================================================================

/**
 * Extract text from PDF buffer using unpdf (edge-compatible)
 * Skips image-only PDFs by checking extracted text length
 */
async function extractTextFromPDF(pdfBuffer: ArrayBuffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const buffer = new Uint8Array(pdfBuffer);
  const result = await extractText(buffer);
  return result.text.join("\n");
}

// ============================================================================
// Text Cleaning
// ============================================================================

/**
 * Strip Urdu/Arabic/non-Latin script from content
 * Keeps Latin characters, numbers, punctuation, whitespace
 */
function stripNonLatin(text: string): string {
  // Remove Arabic/Urdu (0600-06FF, 0750-077F, FB50-FDFF, FE70-FEFF)
  // Remove Devanagari, Bengali, Gurmukhi, other Indic scripts
  // Remove CJK and other non-Latin blocks
  return text.replace(
    /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0B00-\u0B7F\u0C00-\u0C7F\u0D00-\u0D7F\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g,
    ""
  );
}

/**
 * Clean and normalize extracted text
 */
function cleanText(raw: string): string {
  let text = stripNonLatin(raw);

  // Normalize whitespace (tabs and multiple spaces to single space)
  text = text.replace(/[ \t]+/g, " ");

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n");

  // Remove lines that are just whitespace
  text = text.replace(/\n[ \t]+\n/g, "\n\n");

  // Limit consecutive blank lines to max 2
  text = text.replace(/\n{4,}/g, "\n\n\n");

  return text.trim();
}

// ============================================================================
// Document Hashing
// ============================================================================

/**
 * Generate SHA-256 hash of document content
 * Uses Web Crypto API (available in Cloudflare Workers)
 */
async function hashDocument(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Table Extraction
// ============================================================================

/**
 * Detect and extract table-like content from text
 * Returns separated body text and table chunks
 */
function extractTables(text: string): {
  body: string;
  tables: Array<{ text: string; start: number; end: number }>;
} {
  const tables: Array<{ text: string; start: number; end: number }> = [];
  const lines = text.split("\n");
  const bodyLines: string[] = [];
  let tableBuffer: string[] = [];
  let tableStart = 0;
  let currentPos = 0;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = currentPos;
    currentPos += line.length + 1; // +1 for newline

    // Detect table rows: pipes (|) or tab-separated columns
    const pipeCount = (line.match(/\|/g) || []).length;
    const tabCount = (line.match(/\t/g) || []).length;
    const isSeparatorRow = /^[\s|+:-]+$/.test(line) && line.includes("-");
    const isTableLike =
      pipeCount >= 2 || tabCount >= 2 || (inTable && isSeparatorRow);

    if (isTableLike) {
      if (!inTable) {
        inTable = true;
        tableStart = lineStart;
      }
      tableBuffer.push(line);
    } else {
      if (inTable && tableBuffer.length >= 2) {
        // Save the accumulated table
        tables.push({
          text: tableBuffer.join("\n"),
          start: tableStart,
          end: lineStart,
        });
      } else if (inTable) {
        // Single line with pipes isn't really a table
        bodyLines.push(...tableBuffer);
      }
      inTable = false;
      tableBuffer = [];
      bodyLines.push(line);
    }
  }

  // Handle trailing table
  if (inTable && tableBuffer.length >= 2) {
    tables.push({
      text: tableBuffer.join("\n"),
      start: tableStart,
      end: currentPos,
    });
  } else if (inTable) {
    bodyLines.push(...tableBuffer);
  }

  return { body: bodyLines.join("\n"), tables };
}

// ============================================================================
// Paragraph-Aware Chunking
// ============================================================================

/**
 * Chunk text into overlapping segments, splitting on paragraph boundaries
 * Target: ~2000 chars per chunk, 200 char overlap
 */
function chunkText(
  text: string,
  chunkSize = 2000,
  overlap = 200
): Array<{ text: string; char_start: number; char_end: number }> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // If text fits in one chunk
  if (trimmed.length <= chunkSize) {
    return [{ text: trimmed, char_start: 0, char_end: trimmed.length }];
  }

  // Split into paragraphs (double newline)
  const paragraphs = trimmed.split(/\n\n+/);
  const chunks: Array<{
    text: string;
    char_start: number;
    char_end: number;
  }> = [];

  let currentChunk = "";
  let chunkStart = 0;
  let globalPos = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraWithSep = para + "\n\n";

    if (
      currentChunk.length + paraWithSep.length > chunkSize &&
      currentChunk.length > 0
    ) {
      // Flush current chunk
      const content = currentChunk.trim();
      if (content.length > 0) {
        chunks.push({
          text: content,
          char_start: chunkStart,
          char_end: chunkStart + currentChunk.length,
        });
      }

      // Start new chunk with overlap from end of previous
      const overlapText = currentChunk.slice(-overlap);
      chunkStart = chunkStart + currentChunk.length - overlap;
      currentChunk = overlapText + paraWithSep;
    } else {
      if (currentChunk.length === 0) {
        chunkStart = globalPos;
      }
      currentChunk += paraWithSep;
    }

    globalPos += paraWithSep.length;
  }

  // Flush remaining
  const content = currentChunk.trim();
  if (content.length > 0) {
    chunks.push({
      text: content,
      char_start: chunkStart,
      char_end: chunkStart + currentChunk.length,
    });
  }

  return chunks;
}

// ============================================================================
// Metadata Parsing from URL
// ============================================================================

/**
 * Parse company_id, company_name, policy_name, and doc_type from PDF URL
 */
function parseMetadataFromUrl(url: string): {
  company_id: string;
  company_name: string;
  policy_name: string;
  doc_type: string;
} {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname.toLowerCase();
  const path = decodeURIComponent(urlObj.pathname);
  const filename = path.split("/").pop() || "";

  // Company detection from hostname
  let company_id = "unknown";
  let company_name = "Unknown";

  if (hostname.includes("adamjeeinsurance")) {
    company_id = "adamjee-insurance";
    company_name = "Adamjee Insurance";
  } else if (hostname.includes("adamjeelife")) {
    company_id = "adamjee-life";
    company_name = "Adamjee Life";
  } else if (hostname.includes("alfalahinsurance")) {
    company_id = "alfalah-insurance";
    company_name = "Alfalah Insurance";
  } else if (hostname.includes("chubb")) {
    company_id = "chubb-pakistan";
    company_name = "Chubb Pakistan";
  } else if (hostname.includes("jubileelife")) {
    company_id = "jubilee-life";
    company_name = "Jubilee Life";
  } else if (hostname.includes("pqgtl") || hostname.includes("pakqatar")) {
    company_id = "pak-qatar-takaful";
    company_name = "Pak-Qatar General Takaful";
  } else if (hostname.includes("efulife")) {
    company_id = "efu-life";
    company_name = "EFU Life";
  } else if (hostname.includes("statelife")) {
    company_id = "state-life";
    company_name = "State Life";
  } else if (hostname.includes("tpllife")) {
    company_id = "tpl-life";
    company_name = "TPL Life";
  }

  // Policy name from filename
  const policy_name =
    filename
      .replace(/\.pdf$/i, "")
      .replace(/[-_]/g, " ")
      .replace(/%20/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Unknown Policy";

  // Doc type heuristic
  let doc_type = "policy_wording";
  const lower = filename.toLowerCase();
  if (lower.includes("brochure")) doc_type = "brochure";
  else if (lower.includes("factsheet") || lower.includes("fact-sheet"))
    doc_type = "factsheet";
  else if (lower.includes("claim")) doc_type = "claims_guide";
  else if (
    lower.includes("panel") ||
    lower.includes("workshop") ||
    lower.includes("hospital")
  )
    doc_type = "provider_list";
  else if (lower.includes("white") && lower.includes("paper"))
    doc_type = "whitepaper";
  else if (lower.includes("report")) doc_type = "report";
  else if (lower.includes("compliance") || lower.includes("certificate"))
    doc_type = "compliance";
  else if (lower.includes("guideline")) doc_type = "guidelines";
  else if (lower.includes("wording") || lower.includes("policy"))
    doc_type = "policy_wording";

  return { company_id, company_name, policy_name, doc_type };
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Process a single PDF: fetch, extract, clean, hash, chunk
 * Returns document record + chunks ready to be sent to spine for embedding
 */
export async function processInsurancePDF(
  url: string,
  overrides?: {
    company_id?: string;
    company_name?: string;
    policy_name?: string;
    doc_type?: string;
  }
): Promise<ProcessedPDF> {
  // 1. Parse metadata from URL
  const parsed = parseMetadataFromUrl(url);
  const meta = {
    company_id: overrides?.company_id || parsed.company_id,
    company_name: overrides?.company_name || parsed.company_name,
    policy_name: overrides?.policy_name || parsed.policy_name,
    doc_type: overrides?.doc_type || parsed.doc_type,
  };

  // 2. Fetch PDF
  console.log(`[Insurance] Fetching PDF: ${url}`);
  const pdfBuffer = await fetchPDF(url);
  console.log(`[Insurance] Downloaded ${pdfBuffer.byteLength} bytes`);

  // 3. Extract text
  const rawText = await extractTextFromPDF(pdfBuffer);
  if (!rawText || rawText.trim().length < 50) {
    throw new Error(`PDF appears to be image-only or too short: ${url}`);
  }
  console.log(`[Insurance] Extracted ${rawText.length} chars of raw text`);

  // 4. Clean text (strip Urdu, normalize)
  const cleanedText = cleanText(rawText);
  console.log(`[Insurance] Cleaned text: ${cleanedText.length} chars`);

  // 5. Hash for deduplication
  const documentHash = await hashDocument(cleanedText);

  // 6. Extract tables and separate body
  const { body, tables } = extractTables(cleanedText);
  console.log(
    `[Insurance] Found ${tables.length} tables, body: ${body.length} chars`
  );

  // 7. Chunk body text (2000 chars, 200 overlap)
  const bodyChunks = chunkText(body, 2000, 200);

  // 8. Build chunk array
  const chunks: InsuranceChunkData[] = [];

  bodyChunks.forEach((c, i) => {
    chunks.push({
      chunk_index: i,
      chunk_type: "body",
      text: c.text,
      char_start: c.char_start,
      char_end: c.char_end,
      metadata: {
        source_url: url,
        policy_name: meta.policy_name,
        doc_type: meta.doc_type,
      },
    });
  });

  // Add table chunks
  tables.forEach((t, i) => {
    chunks.push({
      chunk_index: bodyChunks.length + i,
      chunk_type: "table",
      text: t.text,
      char_start: t.start,
      char_end: t.end,
      metadata: {
        source_url: url,
        policy_name: meta.policy_name,
        doc_type: meta.doc_type,
        is_table: true,
      },
    });
  });

  console.log(
    `[Insurance] Created ${chunks.length} chunks (${bodyChunks.length} body + ${tables.length} table)`
  );

  const document: CleanedDocument = {
    company_id: meta.company_id,
    company_name: meta.company_name,
    policy_name: meta.policy_name,
    doc_type: meta.doc_type,
    source_url: url,
    raw_text: rawText,
    cleaned_text: cleanedText,
    document_hash: documentHash,
  };

  return { document, chunks };
}

// ============================================================================
// PDF Source Registry — 24 PDFs from research
// ============================================================================

export const INSURANCE_PDF_URLS: string[] = [
  // Adamjee Insurance (6)
  "https://www.adamjeeinsurance.com/assets/Policy%20Wording%20International%20Plan.pdf",
  "https://www.adamjeeinsurance.com/assets/Policy%20Wording%20Student%20Plan.pdf",
  "https://www.adamjeeinsurance.com/step-form/download-pdf/domestic_plan",
  "https://www.adamjeeinsurance.com/business/assets/HospitalPanel.pdf",
  "https://www.adamjeeinsurance.com/business/assets/HealthDiscountCenters.pdf",
  "https://www.adamjeeinsurance.com/business/assets/compliance_certificate.pdf",
  // Chubb Pakistan (4)
  "https://www.chubb.com/content/dam/chubb-sites/chubb-com/products/cyber-risk-insurance/documents/pdf/cyber-erm-insurance-factsheet-pk.pdf",
  "https://www.chubb.com/content/dam/chubb-sites/chubb-com/products/cyber-risk-insurance/documents/pdf/6547-chubb_white_paper-pk.pdf",
  "https://www.chubb.com/content/dam/chubb-sites/chubb-com/pk-en/campaigns/cyber/6378_chubb-cyber_claims_report_pk_v1.pdf",
  "https://www.chubb.com/content/dam/chubb-sites/chubb-com/pk-en/pdfs/products/group-personal-accident-factsheet.pdf",
  // Jubilee Life (4)
  "https://www.jubileelife.com/assets/documents/Edu_Smart_Brochure_A5_Updated.pdf",
  "https://www.jubileelife.com/assets/documents/Cancer-Protection-Plan-brochure.pdf",
  "https://www.jubileelife.com/assets/documents/JMP_-_bilingual_brochure.PDF",
  "https://www.jubileelife.com/assets/documents/Jubilee_Smart_Life_Education_Plan.pdf",
  // Pak-Qatar General Takaful (10)
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Terrorism-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Shop-Owner-Comprehensive-Takaful-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Professional-Indemnity-Takaful-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Mobile-All-Risk-Takaful-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Contractors-Plant-Machinery-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Boiler-Pressure-Vessel-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Bankers-Blanket-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/All-Risk-Contents-Takaful-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Panel-Workshop-List-1.pdf",
  "https://pqgtl.com.pk/wp-content/uploads/2023/10/Motor-Claim-Guidelines-Final-1.pdf",
];

// ============================================================================
// Embedding Generation (Workers AI REST API)
// ============================================================================

const CF_ACCOUNT_ID = "345590cd19a379d6bf1008c6a7860451";

/**
 * Generate embeddings for multiple texts using the Cloudflare Workers AI REST API.
 * Uses @cf/baai/bge-large-en-v1.5 (1024-dim vectors).
 * Uses the REST API instead of the AI binding to work in local dev without --remote.
 */
export async function generateEmbeddings(
  apiToken: string,
  texts: string[]
): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-large-en-v1.5`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Workers AI embeddings failed (${response.status}): ${err}`);
  }

  const result = (await response.json()) as {
    success: boolean;
    result?: { data: number[][] };
    errors?: Array<{ message: string }>;
  };

  if (!result.success || !result.result?.data) {
    throw new Error(
      `Workers AI embeddings error: ${JSON.stringify(result.errors)}`
    );
  }

  return result.result.data;
}

// ============================================================================
// Supabase Storage
// ============================================================================

/**
 * Store an insurance document record and return its new UUID.
 */
export async function storeInsuranceDocument(
  supabase: SupabaseClient,
  doc: CleanedDocument
): Promise<string> {
  const { data, error } = await supabase
    .from("insurance_documents")
    .insert({
      company_id: doc.company_id,
      company_name: doc.company_name,
      policy_name: doc.policy_name,
      doc_type: doc.doc_type,
      source_url: doc.source_url,
      raw_text: doc.raw_text,
      cleaned_text: doc.cleaned_text,
      document_hash: doc.document_hash,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to store insurance document: ${error.message}`);
  }

  return data.id;
}

/**
 * Store insurance chunks with pre-generated embeddings.
 * Inserts in batches of 50 to stay within Supabase payload limits.
 * Returns the number of rows inserted.
 */
export async function storeInsuranceChunks(
  supabase: SupabaseClient,
  documentId: string,
  companyId: string,
  chunks: InsuranceChunkData[],
  embeddings: number[][]
): Promise<number> {
  const rows = chunks.map((chunk, i) => ({
    document_id: documentId,
    company_id: companyId,
    chunk_index: chunk.chunk_index,
    chunk_type: chunk.chunk_type,
    text: chunk.text,
    embedding: JSON.stringify(embeddings[i]),
    char_start: chunk.char_start,
    char_end: chunk.char_end,
    metadata: chunk.metadata,
  }));

  const BATCH_SIZE = 50;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from("insurance_chunks")
      .insert(batch)
      .select("id");

    if (error) {
      throw new Error(
        `Failed to store insurance chunks (batch ${i}): ${error.message}`
      );
    }

    totalInserted += data?.length || 0;
  }

  return totalInserted;
}
