/**
 * Tax Document Ingestion Controller
 * Orchestrates the taxation PDF ingestion pipeline:
 * 1. Fetch & extract text via AI.toMarkdown() (handles OCR automatically)
 * 2. Check Supabase for duplicate hashes
 * 3. Generate embeddings via Workers AI REST API
 * 4. Store documents + chunks directly in Supabase
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import {
  TAX_DOCUMENT_URLS,
  TaxDocumentInput,
  generateTaxEmbeddings,
  processTaxDocument,
  storeTaxDocument,
  storeTaxChunks,
} from "../services/tax-ingestion.service";

// ============================================================================
// Configuration
// ============================================================================

const INGESTION_CONFIG = {
  CONCURRENCY:     3,   // concurrent PDF downloads
  EMBED_BATCH_SIZE: 20, // Workers AI embedding batch limit
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a document hash already exists in tax_documents.
 * Returns false on error (proceed with ingestion rather than silently skip).
 */
async function documentHashExists(
  supabase: any,
  hash: string
): Promise<boolean> {
  const { data, error } = await (supabase.from("tax_documents" as any) as any)
    .select("id")
    .eq("document_hash", hash)
    .limit(1);

  if (error) {
    console.warn(`[TaxDocs] Hash check error: ${error.message}`);
    return false;
  }

  return (data?.length || 0) > 0;
}

/**
 * Process items with bounded concurrency.
 * Identical pattern to the insurance ingestion controller.
 */
async function processBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<{
  results: R[];
  errors: Array<{ item: T; error: string }>;
}> {
  const results: R[] = [];
  const errors: Array<{ item: T; error: string }> = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch   = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((item) => fn(item)));

    settled.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        errors.push({
          item:  batch[idx],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
  }

  return { results, errors };
}

/**
 * Core pipeline: process + embed + store a single document input.
 * Shared by both runBulkIngestion and ingestSingle.
 */
async function ingestDocument(
  supabase: any,
  ai: CloudflareBindings["AI"],
  apiToken: string,
  input: TaxDocumentInput
): Promise<{ skipped: boolean; chunksStored: number }> {
  // 1. Fetch + hash + extract text
  const { document, chunks } = await processTaxDocument(ai, input);

  // 2. Deduplication check
  const exists = await documentHashExists(supabase, document.document_hash);
  if (exists) {
    console.log(`[TaxDocs] Skipping duplicate: ${input.source_name}`);
    return { skipped: true, chunksStored: 0 };
  }

  // 3. Generate embeddings in batches (delegated to service for rate-limit handling)
  const texts = chunks.map((ch) => ch.text);
  const allEmbeddings = await generateTaxEmbeddings(ai, texts);

  // 4. Store document + chunks
  const documentId    = await storeTaxDocument(supabase, document);
  const chunksStored  = await storeTaxChunks(supabase, documentId, chunks, allEmbeddings);

  console.log(
    `[TaxDocs] Ingested "${input.source_name}": ${chunksStored} chunks stored`
  );

  return { skipped: false, chunksStored };
}

// ============================================================================
// Controller
// ============================================================================

export const taxIngestionController = {
  /**
   * Run full bulk ingestion from TAX_DOCUMENT_URLS list
   * POST /admin/api/tax-docs/ingest/run
   *
   * Processes all entries in TAX_DOCUMENT_URLS:
   * 1. Concurrent fetch + AI.toMarkdown() extraction (handles OCR)
   * 2. Hash deduplication
   * 3. Embedding generation
   * 4. Supabase storage
   */
  runBulkIngestion: async (c: AppContext) => {
    const startTime = Date.now();
    const apiToken  = c.env.AI_GATEWAY_TOKEN;

    const stats = {
      totalDocuments:   TAX_DOCUMENT_URLS.length,
      processed:        0,
      skippedDuplicate: 0,
      skippedError:     0,
      chunksCreated:    0,
      errors:           [] as string[],
    };

    if (TAX_DOCUMENT_URLS.length === 0) {
      return c.json({
        success: false,
        error:   "TAX_DOCUMENT_URLS is empty — populate the list in tax-ingestion.service.ts before running",
        timestamp: new Date().toISOString(),
      }, 400);
    }

    try {
      const supabase = await getSupabaseClient(c.env);

      console.log(`[TaxDocs] Starting bulk ingestion of ${TAX_DOCUMENT_URLS.length} documents`);

      const { results, errors } = await processBatched(
        TAX_DOCUMENT_URLS,
        INGESTION_CONFIG.CONCURRENCY,
        (input) => ingestDocument(supabase, c.env.AI, apiToken, input as any)
      );

      for (const r of results) {
        if (r.skipped) {
          stats.skippedDuplicate++;
        } else {
          stats.processed++;
          stats.chunksCreated += r.chunksStored;
        }
      }

      for (const e of errors) {
        stats.skippedError++;
        const label = (e.item as TaxDocumentInput).source_name ?? String(e.item);
        stats.errors.push(`${label}: ${e.error}`);
        console.error(`[TaxDocs] Failed: ${label} — ${e.error}`);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[TaxDocs] Bulk ingestion completed in ${duration}s`);

      return c.json({
        success:   true,
        message:   "Tax document bulk ingestion completed",
        stats:     { ...stats, durationSeconds: parseFloat(duration) },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[TaxDocs] Bulk ingestion failed:", err);
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Ingest a single PDF by URL
   * POST /admin/api/tax-docs/ingest/single
   *
   * Body: {
   *   url:         string   (required)
   *   source_name: string   (required)
   *   doc_type?:   string   (optional, default: "guidelines")
   *   metadata?:   object   (optional)
   * }
   */
  ingestSingle: async (c: AppContext) => {
    const startTime = Date.now();
    const apiToken  = c.env.AI_GATEWAY_TOKEN;

    try {
      const body = await c.req.json<{
        url:          string;
        source_name:  string;
        doc_type?:    string;
        metadata?:    Record<string, unknown>;
      }>();

      if (!body.url?.trim()) {
        return c.json({ success: false, error: "url is required", timestamp: new Date().toISOString() }, 400);
      }
      if (!body.source_name?.trim()) {
        return c.json({ success: false, error: "source_name is required", timestamp: new Date().toISOString() }, 400);
      }

      const supabase = await getSupabaseClient(c.env);

      const result = await ingestDocument(supabase, c.env.AI, apiToken, {
        url:         body.url.trim(),
        source_name: body.source_name.trim(),
        doc_type:    body.doc_type as any,
        metadata:    body.metadata,
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      if (result.skipped) {
        return c.json({
          success:   true,
          message:   "Document already ingested (duplicate hash)",
          skipped:   true,
          timestamp: new Date().toISOString(),
        });
      }

      return c.json({
        success:         true,
        message:         "Tax document ingested successfully",
        source_name:     body.source_name,
        chunks_created:  result.chunksStored,
        durationSeconds: parseFloat(duration),
        timestamp:       new Date().toISOString(),
      });
    } catch (err) {
      console.error("[TaxDocs] Single ingestion failed:", err);
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * List all ingested tax documents
   * GET /admin/api/tax-docs/documents
   */
  listDocuments: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      const { data, error } = await (supabase.from("tax_documents" as any) as any)
        .select("id, source_name, source_url, doc_type, document_hash, metadata, created_at")
        .order("created_at", { ascending: false });

      if (error) throw new Error(`Failed to list documents: ${error.message}`);

      return c.json({
        success:   true,
        documents: data || [],
        count:     data?.length || 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
