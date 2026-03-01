/**
 * Insurance Ingestion Controller
 * Orchestrates the insurance PDF ingestion pipeline:
 * 1. Fetch & preprocess PDFs (marrow)
 * 2. Check Supabase for duplicate hashes (marrow)
 * 3. Send chunks to spine for embedding + storage (spine is AI gatekeeper)
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import {
  processInsurancePDF,
  INSURANCE_PDF_URLS,
} from "../services/insurance-ingestion.service";

// ============================================================================
// Configuration
// ============================================================================

const INGESTION_CONFIG = {
  /** Number of concurrent PDF downloads */
  CONCURRENCY: 3,
  /** Spine URL for embedding — set SPINE_URL in .dev.vars or wrangler vars */
  DEFAULT_SPINE_URL: "http://localhost:8787",
};

/**
 * Get spine URL from environment
 */
function getSpineUrl(env: Record<string, unknown>): string {
  return (
    (env.SPINE_URL as string) || INGESTION_CONFIG.DEFAULT_SPINE_URL
  );
}

/**
 * Send preprocessed document + chunks to spine for embedding and storage
 */
async function sendToSpineForEmbedding(
  spineUrl: string,
  document: {
    company_id: string;
    company_name: string;
    policy_name: string;
    doc_type: string;
    source_url: string;
    raw_text: string;
    cleaned_text: string;
    document_hash: string;
  },
  chunks: Array<{
    chunk_index: number;
    chunk_type: "body" | "table";
    text: string;
    char_start: number;
    char_end: number;
    metadata: Record<string, unknown>;
  }>
): Promise<{ success: boolean; chunks_stored?: number; error?: string }> {
  const response = await fetch(`${spineUrl}/api/insurance/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, chunks }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      error: `Spine returned ${response.status}: ${errorText}`,
    };
  }

  return (await response.json()) as {
    success: boolean;
    chunks_stored?: number;
    error?: string;
  };
}

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
   * 3. Send new documents to spine for embedding + storage
   */
  runFullIngestion: async (c: AppContext) => {
    const startTime = Date.now();
    const spineUrl = getSpineUrl(c.env as unknown as Record<string, unknown>);

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
      console.log(`[Insurance] Spine URL: ${spineUrl}`);

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

          // 3. Send to spine for embedding + storage
          const result = await sendToSpineForEmbedding(
            spineUrl,
            document,
            chunks
          );

          if (!result.success) {
            throw new Error(result.error || "Spine ingestion failed");
          }

          console.log(
            `[Insurance] Ingested ${result.chunks_stored} chunks from ${url}`
          );
          return {
            url,
            skipped: false,
            chunks: result.chunks_stored || chunks.length,
          };
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
    const spineUrl = getSpineUrl(c.env as unknown as Record<string, unknown>);

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

      // 3. Send to spine for embedding + storage
      const result = await sendToSpineForEmbedding(spineUrl, document, chunks);

      if (!result.success) {
        throw new Error(result.error || "Spine ingestion failed");
      }

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
        chunks_created: result.chunks_stored || chunks.length,
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
