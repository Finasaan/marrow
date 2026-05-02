import { createHash } from "crypto";
// CloudflareBindings is available globally from worker-configuration.d.ts

// ============================================================================
// Configuration & Constants
// ============================================================================

const CHUNK_SIZE    = 1200; // Optimal for Pakistan legal text context window
const CHUNK_OVERLAP = 150;  // Preserves semantic context across segments
const EMBED_MODEL   = "@cf/baai/bge-large-en-v1.5"; // 1024-dimension
const EMBED_BATCH   = 10;   // Conservative batching for stability
const INSERT_BATCH  = 50;   // Supabase bulk insert batching

// Hardcoded URLs for the Pakistan taxation guidelines (bulk ingestion target)
export const TAX_DOCUMENT_URLS = [
  {
    source_name: "Income_Tax_Ordinance_2001_Amended_Feb_2026",
    url: "https://download1.fbr.gov.pk/Docs/2026226162211364IncomeTaxOrdinance2001-Amended-20.02.2026.pdf",
    doc_type: "ordinance"
  },
  {
    source_name: "Income_Tax_Rules_2002_Amended_Nov_2023",
    url: "https://download1.fbr.gov.pk/Docs/2023112416114319348IncomeTaxRules2002AmendedUpto24.11.2023.pdf",
    doc_type: "rules"
  },
  {
    source_name: "FBR_Circular_08_2025_26",
    url: "https://download1.fbr.gov.pk/Docs/2026415164475474circular1.pdf",
    doc_type: "circular"
  }
];

// ============================================================================
// Types
// ============================================================================

export interface TaxDocumentInput {
  url:          string;
  source_name:  string;
  doc_type?:    "ordinance" | "rules" | "circular" | "guidelines";
  metadata?:    Record<string, any>;
}

export interface TaxDocument {
  id?:           string;
  source_name:   string;
  source_url:    string;
  doc_type:      string;
  document_hash: string;
  metadata:      Record<string, any>;
}

export interface TaxChunkData {
  chunk_index: number;
  text:        string;
  metadata:    Record<string, any>;
}

export interface ProcessedTaxDoc {
  document: TaxDocument;
  chunks:   TaxChunkData[];
}

// ============================================================================
// Step 1: Fetch PDF and extract text (OCR via Workers AI)
// ============================================================================

/**
 * Downloads PDF from FBR, generates SHA-256 hash for deduplication,
 * and extracts text using Cloudflare Workers AI 'toMarkdown' capability.
 */
export async function fetchAndExtract(
  ai: CloudflareBindings["AI"],
  url: string
): Promise<{ text: string; hash: string }> {
  console.log(`[TaxDocs] Fetching PDF from: ${url}`);
  
  const response = await fetch(url, {
    headers: { "User-Agent": "Finasaan-Tax-Ingestor/1.0" }
  });

  if (!response.ok) {
    throw new Error(`Failed to download PDF (${response.status}): ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const blob = new Blob([buffer], { type: "application/pdf" });
  
  // SHA-256 for idempotent ingestion (prevent duplicates)
  const hash = createHash("sha256")
    .update(Buffer.from(buffer))
    .digest("hex");

  // Step 1: Extract text (OCR via AI.toMarkdown or fallback to unpdf)
  let text = "";
  try {
    // Try native Workers AI document conversion first (if binding exists and is functional)
    if ((ai as any).toMarkdown) {
      const [result] = await (ai as any).toMarkdown([{ name: "document.pdf", blob }]);
      text = (result as any).data ?? (result as any).result ?? "";
    }
  } catch (aiErr) {
    console.warn("[TaxDocs] AI.toMarkdown failed or not bound, falling back to unpdf:", aiErr);
  }

  if (!text) {
    try {
      const { extractText } = await import("unpdf");
      const result = await extractText(new Uint8Array(buffer));
      text = result.text.join("\n");
    } catch (unpdfErr) {
      throw new Error(`Text extraction failed (both AI.toMarkdown and unpdf): ${unpdfErr}`);
    }
  }

  if (text.trim().length < 50) {
    throw new Error(`Text extraction returned insufficient content (< 50 chars) from ${url}`);
  }

  return { text, hash };
}

// ============================================================================
// Step 2: Chunk text into overlapping segments
// ============================================================================

export function chunkText(
  text: string,
  maxChars: number = CHUNK_SIZE,
  overlap: number  = CHUNK_OVERLAP
): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
        current = current.slice(-overlap) + "\n\n" + para;
      } else {
        // Paragraph alone exceeds maxChars — force-split it
        for (let i = 0; i < para.length; i += maxChars - overlap) {
          const slice = para.slice(i, i + maxChars).trim();
          if (slice) chunks.push(slice);
        }
        current = "";
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

// ============================================================================
// Step 3: Generate embeddings via Workers AI REST API
// ============================================================================

export async function generateTaxEmbeddings(
  ai: CloudflareBindings["AI"],
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const embeddings: number[][] = [];
  const batchSize = EMBED_BATCH;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        const result = await (ai as any).run(EMBED_MODEL, {
          text: batch,
        });

        if (result && Array.isArray(result.data)) {
          embeddings.push(...result.data);
          success = true;
        } else {
          throw new Error("Invalid response from embedding API");
        }
      } catch (err: any) {
        if (err.message?.includes("429") || err.message?.includes("exceeded")) {
          retries--;
          console.warn(`[TaxDocs] Rate limit hit, retrying in 2s... (${retries} left)`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }

    if (!success) throw new Error("Embedding API failed after retries");

    // Small delay between batches to be nice to the API
    await new Promise(r => setTimeout(r, 200));
  }

  return embeddings;
}

// ============================================================================
// Step 4: Orchestrate — fetch + hash + extract + chunk a single PDF URL
// ============================================================================

export async function processTaxDocument(
  ai: CloudflareBindings["AI"],
  input: TaxDocumentInput
): Promise<ProcessedTaxDoc> {
  const { text, hash } = await fetchAndExtract(ai, input.url);

  const document: TaxDocument = {
    source_name:   input.source_name,
    source_url:    input.url,
    doc_type:      input.doc_type ?? "guidelines",
    document_hash: hash,
    metadata:      input.metadata ?? {},
  };

  const textChunks = chunkText(text);
  const chunks: TaxChunkData[] = textChunks.map((chunkText, i) => ({
    chunk_index: i,
    text:        chunkText,
    metadata:    {},
  }));

  return { document, chunks };
}

// ============================================================================
// Supabase storage helpers
// ============================================================================

type SupabaseClient = ReturnType<typeof import("@supabase/supabase-js").createClient>;

export async function storeTaxDocument(
  supabase: SupabaseClient,
  doc: TaxDocument
): Promise<string> {
  const { data, error } = await (supabase.from("tax_documents" as any) as any)
    .insert({
      source_name:   doc.source_name,
      source_url:    doc.source_url,
      doc_type:      doc.doc_type,
      document_hash: doc.document_hash,
      metadata:      doc.metadata,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to store tax document: ${error.message}`);
  return data.id as string;
}

export async function storeTaxChunks(
  supabase: SupabaseClient,
  documentId: string,
  chunks: TaxChunkData[],
  embeddings: number[][]
): Promise<number> {
  if (chunks.length === 0) return 0;

  const rows = chunks.map((chunk, i) => ({
    document_id: documentId,
    chunk_index: chunk.chunk_index,
    text:        chunk.text,
    embedding:   embeddings[i],  // Supabase auto-casts to vector(1024)
    metadata:    chunk.metadata,
  }));

  let stored = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error } = await (supabase.from("tax_chunks" as any) as any).insert(batch);
    if (error) throw new Error(`Failed to store tax chunks batch: ${error.message}`);
    stored += batch.length;
  }

  return stored;
}
