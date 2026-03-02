/**
 * Insurance Ingestion Controller
 * Orchestrates the insurance PDF ingestion pipeline:
 * 1. Fetch & preprocess PDFs
 * 2. Check Supabase for duplicate hashes
 * 3. Generate embeddings via Workers AI for BODY chunks only
 * 4. Send TABLE chunks to spine for LLM structuring (not vectorized)
 * 5. Store documents + body chunks directly in Supabase
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import {
  processInsurancePDF,
  INSURANCE_PDF_URLS,
  generateEmbeddings,
  storeInsuranceDocument,
  storeInsuranceChunks,
  InsuranceChunkData,
  CleanedDocument,
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
// Spine Integration — Table Extraction
// ============================================================================

/**
 * Get the spine URL from environment, fail-fast if missing.
 */
function getSpineUrl(env: CloudflareBindings): string {
  const url = (env as unknown as { SPINE_URL: string }).SPINE_URL;
  if (!url) {
    throw new Error("SPINE_URL is not configured — cannot call spine for table extraction");
  }
  return url;
}

/**
 * Send a raw table chunk to spine's extraction endpoint for LLM structuring.
 * Returns the structured table data, or null if extraction fails (non-fatal).
 */
async function sendTableToSpine(
  spineUrl: string,
  chunk: InsuranceChunkData,
  document: CleanedDocument,
  documentId: string
): Promise<{ table_id: string } | null> {
  try {
    const response = await fetch(`${spineUrl}/api/extract/structure-table`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_table_text: chunk.text,
        source_document_id: documentId,
        source_type: "insurance",
        company_id: document.company_id,
        company_name: document.company_name,
        policy_name: document.policy_name,
        doc_type: document.doc_type,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(
        `[Insurance] Table extraction failed (${response.status}): ${errorText}`
      );
      return null;
    }

    const result = (await response.json()) as {
      success: boolean;
      table_id?: string;
      error?: string;
    };

    if (!result.success) {
      console.warn(`[Insurance] Table extraction returned error: ${result.error}`);
      return null;
    }

    return { table_id: result.table_id! };
  } catch (err) {
    console.warn(
      `[Insurance] Table extraction call failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
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
      bodyChunksCreated: 0,
      tablesExtracted: 0,
      tablesFailed: 0,
      errors: [] as string[],
    };

    try {
      const supabase = await getSupabaseClient(c.env);
      const spineUrl = getSpineUrl(c.env);

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
            return { url, skipped: true, bodyChunks: 0, tables: 0, tablesFailed: 0 };
          }

          // 3. Separate body chunks from table chunks
          const bodyChunks = chunks.filter((ch) => ch.chunk_type === "body");
          const tableChunks = chunks.filter((ch) => ch.chunk_type === "table");

          console.log(
            `[Insurance] ${url}: ${bodyChunks.length} body chunks, ${tableChunks.length} table chunks`
          );

          // 4. Generate embeddings ONLY for body chunks
          const bodyTexts = bodyChunks.map((ch) => ch.text);
          const allEmbeddings: number[][] = [];
          for (
            let i = 0;
            i < bodyTexts.length;
            i += INGESTION_CONFIG.EMBED_BATCH_SIZE
          ) {
            const batch = bodyTexts.slice(i, i + INGESTION_CONFIG.EMBED_BATCH_SIZE);
            const batchEmbeddings = await generateEmbeddings(ai, batch);
            allEmbeddings.push(...batchEmbeddings);
          }

          // 5. Store document + body chunks in Supabase
          const documentId = await storeInsuranceDocument(supabase, document);
          const bodyChunksStored = await storeInsuranceChunks(
            supabase,
            documentId,
            document.company_id,
            bodyChunks,
            allEmbeddings
          );

          // 6. Send table chunks to spine for LLM structuring (non-fatal on failure)
          let tablesOk = 0;
          let tablesFail = 0;
          for (const tableChunk of tableChunks) {
            const result = await sendTableToSpine(
              spineUrl,
              tableChunk,
              document,
              documentId
            );
            if (result) {
              tablesOk++;
            } else {
              tablesFail++;
            }
          }

          console.log(
            `[Insurance] Ingested ${bodyChunksStored} body chunks, ${tablesOk}/${tableChunks.length} tables from ${url}`
          );
          return {
            url,
            skipped: false,
            bodyChunks: bodyChunksStored,
            tables: tablesOk,
            tablesFailed: tablesFail,
          };
        }
      );

      // Tally results
      for (const r of results) {
        if (r.skipped) {
          stats.skippedDuplicate++;
        } else {
          stats.processed++;
          stats.bodyChunksCreated += r.bodyChunks;
          stats.tablesExtracted += r.tables;
          stats.tablesFailed += r.tablesFailed;
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
      const spineUrl = getSpineUrl(c.env);

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

      // 3. Separate body chunks from table chunks
      const bodyChunks = chunks.filter((ch) => ch.chunk_type === "body");
      const tableChunks = chunks.filter((ch) => ch.chunk_type === "table");

      // 4. Generate embeddings ONLY for body chunks
      const bodyTexts = bodyChunks.map((ch) => ch.text);
      const allEmbeddings: number[][] = [];
      for (
        let i = 0;
        i < bodyTexts.length;
        i += INGESTION_CONFIG.EMBED_BATCH_SIZE
      ) {
        const batch = bodyTexts.slice(i, i + INGESTION_CONFIG.EMBED_BATCH_SIZE);
        const batchEmbeddings = await generateEmbeddings(ai, batch);
        allEmbeddings.push(...batchEmbeddings);
      }

      // 5. Store document + body chunks in Supabase
      const documentId = await storeInsuranceDocument(supabase, document);
      const bodyChunksStored = await storeInsuranceChunks(
        supabase,
        documentId,
        document.company_id,
        bodyChunks,
        allEmbeddings
      );

      // 6. Send table chunks to spine for LLM structuring
      let tablesExtracted = 0;
      let tablesFailed = 0;
      for (const tableChunk of tableChunks) {
        const result = await sendTableToSpine(
          spineUrl,
          tableChunk,
          document,
          documentId
        );
        if (result) {
          tablesExtracted++;
        } else {
          tablesFailed++;
        }
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
        body_chunks_created: bodyChunksStored,
        tables_extracted: tablesExtracted,
        tables_failed: tablesFailed,
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
