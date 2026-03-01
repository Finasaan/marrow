/**
 * Insurance Ingestion Controller
 * Orchestrates the insurance PDF ingestion pipeline:
 * 1. Fetch & preprocess PDFs
 * 2. Check Supabase for duplicate hashes
 * 3. Generate embeddings via Workers AI (own AI binding — no spine dependency)
 * 4. Store documents + chunks directly in Supabase
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import {
  processInsurancePDF,
  INSURANCE_PDF_URLS,
  generateEmbeddings,
  storeInsuranceDocument,
  storeInsuranceChunks,
} from "../services/insurance-ingestion.service";

// ============================================================================
// Configuration
// ============================================================================

const INGESTION_CONFIG = {
  /** Number of concurrent PDF downloads */
  CONCURRENCY: 3,
  /** Embedding batch size (Workers AI limit) */
  EMBED_BATCH_SIZE: 20,
};

/**
 * Check if a document hash already exists in insurance_documents
 */
async function documentHashExists(
  supabase: ReturnType<typeof import("@supabase/supabase-js").createClient>,
  hash: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("insurance_documents")
    .select("id")
    .eq("document_hash", hash)
    .limit(1);

  if (error) {
    console.warn(`[Insurance] Hash check error: ${error.message}`);
    return false; // Proceed with ingestion on error
  }

  return (data?.length || 0) > 0;
}

/**
 * Process items with bounded concurrency
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
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((item) => fn(item)));

    settled.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        errors.push({
          item: batch[idx],
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

// ============================================================================
// Controller
// ============================================================================

export const insuranceIngestionController = {
  /**
   * Run full insurance ingestion pipeline
   * POST /admin/api/insurance/ingest/run
   *
   * Processes all 24 PDF URLs:
   * 1. Fetch + preprocess each PDF
   * 2. Check hash deduplication against Supabase
   * 3. Generate embeddings via Workers AI (local)
   * 4. Store documents + chunks in Supabase
   */
  runFullIngestion: async (c: AppContext) => {
    const startTime = Date.now();
    const ai = c.env.AI;

    const stats = {
      totalPDFs: INSURANCE_PDF_URLS.length,
      processed: 0,
      skippedDuplicate: 0,
      skippedError: 0,
      chunksCreated: 0,
      errors: [] as string[],
    };

    try {
      const supabase = await getSupabaseClient(c.env);

      console.log(
        `[Insurance] Starting ingestion of ${INSURANCE_PDF_URLS.length} PDFs`
      );

      const { results, errors } = await processBatched(
        INSURANCE_PDF_URLS,
        INGESTION_CONFIG.CONCURRENCY,
        async (url) => {
          // 1. Process the PDF
          const { document, chunks } = await processInsurancePDF(url);

          // 2. Check for duplicate hash
          const exists = await documentHashExists(
            supabase,
            document.document_hash
          );
          if (exists) {
            console.log(`[Insurance] Skipping duplicate: ${url}`);
            return { url, skipped: true, chunks: 0 };
          }

          // 3. Generate embeddings locally via Workers AI
          const texts = chunks.map((ch) => ch.text);
          const allEmbeddings: number[][] = [];
          for (
            let i = 0;
            i < texts.length;
            i += INGESTION_CONFIG.EMBED_BATCH_SIZE
          ) {
            const batch = texts.slice(i, i + INGESTION_CONFIG.EMBED_BATCH_SIZE);
            const batchEmbeddings = await generateEmbeddings(ai, batch);
            allEmbeddings.push(...batchEmbeddings);
          }

          // 4. Store document + chunks in Supabase
          const documentId = await storeInsuranceDocument(supabase, document);
          const chunksStored = await storeInsuranceChunks(
            supabase,
            documentId,
            document.company_id,
            chunks,
            allEmbeddings
          );

          console.log(
            `[Insurance] Ingested ${chunksStored} chunks from ${url}`
          );
          return { url, skipped: false, chunks: chunksStored };
        }
      );

      // Tally results
      for (const r of results) {
        if (r.skipped) {
          stats.skippedDuplicate++;
        } else {
          stats.processed++;
          stats.chunksCreated += r.chunks;
        }
      }

      for (const e of errors) {
        stats.skippedError++;
        stats.errors.push(`${e.item}: ${e.error}`);
        console.error(`[Insurance] Failed: ${e.item} — ${e.error}`);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[Insurance] Pipeline completed in ${duration}s`);

      return c.json({
        success: true,
        message: "Insurance ingestion pipeline completed",
        stats: {
          ...stats,
          durationSeconds: parseFloat(duration),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[Insurance] Pipeline failed:", err);
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Ingest a single PDF URL
   * POST /admin/api/insurance/ingest/single
   * Body: { url: string, company_id?: string, company_name?: string }
   */
  ingestSingle: async (c: AppContext) => {
    const startTime = Date.now();
    const ai = c.env.AI;

    try {
      const body = await c.req.json<{
        url: string;
        company_id?: string;
        company_name?: string;
        policy_name?: string;
        doc_type?: string;
      }>();

      if (!body.url?.trim()) {
        return c.json(
          {
            success: false,
            error: "No URL provided",
            timestamp: new Date().toISOString(),
          },
          400
        );
      }

      const supabase = await getSupabaseClient(c.env);

      // 1. Process the PDF
      const { document, chunks } = await processInsurancePDF(body.url, {
        company_id: body.company_id,
        company_name: body.company_name,
        policy_name: body.policy_name,
        doc_type: body.doc_type,
      });

      // 2. Check for duplicate hash
      const exists = await documentHashExists(
        supabase,
        document.document_hash
      );
      if (exists) {
        return c.json({
          success: true,
          message: "Document already ingested (duplicate hash)",
          skipped: true,
          document_hash: document.document_hash,
          timestamp: new Date().toISOString(),
        });
      }

      // 3. Generate embeddings locally via Workers AI
      const texts = chunks.map((ch) => ch.text);
      const allEmbeddings: number[][] = [];
      for (
        let i = 0;
        i < texts.length;
        i += INGESTION_CONFIG.EMBED_BATCH_SIZE
      ) {
        const batch = texts.slice(i, i + INGESTION_CONFIG.EMBED_BATCH_SIZE);
        const batchEmbeddings = await generateEmbeddings(ai, batch);
        allEmbeddings.push(...batchEmbeddings);
      }

      // 4. Store document + chunks in Supabase
      const documentId = await storeInsuranceDocument(supabase, document);
      const chunksStored = await storeInsuranceChunks(
        supabase,
        documentId,
        document.company_id,
        chunks,
        allEmbeddings
      );

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      return c.json({
        success: true,
        message: "PDF ingested successfully",
        document: {
          company_id: document.company_id,
          company_name: document.company_name,
          policy_name: document.policy_name,
          doc_type: document.doc_type,
          document_hash: document.document_hash,
        },
        chunks_created: chunksStored,
        durationSeconds: parseFloat(duration),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[Insurance] Single ingestion failed:", err);
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * List all ingested insurance documents
   * GET /admin/api/insurance/documents
   */
  listDocuments: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      const { data, error } = await supabase
        .from("insurance_documents")
        .select(
          "id, company_id, company_name, policy_name, doc_type, source_url, document_hash, created_at"
        )
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(`Failed to list documents: ${error.message}`);
      }

      return c.json({
        success: true,
        documents: data || [],
        count: data?.length || 0,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
