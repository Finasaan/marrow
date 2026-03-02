/**
 * PSX Stock Ingestion Controller
 * Daily job to fetch intraday trades and aggregate into daily OHLCV rows
 * 
 * Design:
 * - NO temporary tables
 * - NO storing intraday ticks in DB
 * - Aggregate entirely in memory
 * - Insert one row per company
 * - Bounded async concurrency
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import { SupabaseClient } from "@supabase/supabase-js";
import {
    psxIntradayService,
    aggregateIntradayToDaily,
    processBatched,
    getTodayKarachi,
    getDateFromTicks,
    DailyOHLCV,
} from "../services/psx-intraday.service";
import {
    downloadClosingRatePDF,
    parseClosingRatePDF,
} from "../services/psx-pdf.service";

// ============================================================================
// Configuration
// ============================================================================

const INGESTION_CONFIG = {
    /** Number of concurrent API calls (default: 5) */
    CONCURRENCY: 5,
    /** Batch size for DB inserts */
    DB_BATCH_SIZE: 100,
};

// ============================================================================
// Helpers
// ============================================================================

interface BackfillDateResult {
    date: string;
    skipped: boolean;
    skipReason?: string;
    pdfRowsParsed: number;
    rowsMatched: number;
    rowsUpserted: number;
    rowsSkippedNoMatch: number;
    durationSeconds: number;
    error?: string;
}

/**
 * Core single-date backfill logic, reused by both runForDate and runForDateRange.
 * Companies map is pre-loaded by the caller to avoid redundant DB queries.
 */
async function backfillDateCore(
    supabase: SupabaseClient,
    tradeDate: string,
    symbolToId: Map<string, string>,
    dbBatchSize: number
): Promise<BackfillDateResult> {
    const startTime = Date.now();
    const EXPECTED_MINIMUM = symbolToId.size;

    // Idempotency check
    const { count: existingCount } = await supabase
        .from("daily_stock_data")
        .select("*", { count: "exact", head: true })
        .eq("trade_date", tradeDate);

    if (existingCount !== null && existingCount !== undefined && existingCount >= EXPECTED_MINIMUM) {
        return {
            date: tradeDate,
            skipped: true,
            skipReason: `Already have ${existingCount} rows (expected ~${EXPECTED_MINIMUM})`,
            pdfRowsParsed: 0,
            rowsMatched: 0,
            rowsUpserted: 0,
            rowsSkippedNoMatch: 0,
            durationSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
        };
    }

    // Download PDF
    const pdfData = await downloadClosingRatePDF(tradeDate);
    if (!pdfData) {
        return {
            date: tradeDate,
            skipped: true,
            skipReason: "No PDF available (weekend or holiday)",
            pdfRowsParsed: 0,
            rowsMatched: 0,
            rowsUpserted: 0,
            rowsSkippedNoMatch: 0,
            durationSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
        };
    }

    // Parse PDF
    const parsedRows = await parseClosingRatePDF(pdfData);
    if (parsedRows.length === 0) {
        return {
            date: tradeDate,
            skipped: false,
            pdfRowsParsed: 0,
            rowsMatched: 0,
            rowsUpserted: 0,
            rowsSkippedNoMatch: 0,
            durationSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
            error: "PDF parsed but contained no stock rows",
        };
    }

    // Map to DB rows
    interface BackfillRow {
        company_id: string;
        trade_date: string;
        open_price: number;
        high_price: number;
        low_price: number;
        close_price: number;
        adjusted_close_price: number;
        volume: number;
    }

    const dailyRows: BackfillRow[] = [];
    let rowsSkippedNoMatch = 0;

    for (const row of parsedRows) {
        const companyId = symbolToId.get(row.symbol.toUpperCase());
        if (!companyId) { rowsSkippedNoMatch++; continue; }
        dailyRows.push({
            company_id: companyId,
            trade_date: tradeDate,
            open_price: row.open,
            high_price: row.high,
            low_price: row.low,
            close_price: row.close,
            adjusted_close_price: row.close,
            volume: row.volume,
        });
    }

    // Upsert
    let rowsUpserted = 0;
    const errors: string[] = [];
    for (let i = 0; i < dailyRows.length; i += dbBatchSize) {
        const batch = dailyRows.slice(i, i + dbBatchSize);
        const { error: insertError } = await supabase
            .from("daily_stock_data")
            .upsert(batch, { onConflict: "company_id,trade_date", ignoreDuplicates: false });
        if (insertError) {
            errors.push(insertError.message);
        } else {
            rowsUpserted += batch.length;
        }
    }

    return {
        date: tradeDate,
        skipped: false,
        pdfRowsParsed: parsedRows.length,
        rowsMatched: dailyRows.length,
        rowsUpserted,
        rowsSkippedNoMatch,
        durationSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
        error: errors.length > 0 ? errors.join("; ") : undefined,
    };
}

/**
 * Generate all calendar dates (YYYY-MM-DD) between from and to inclusive,
 * excluding weekends (Saturday=6, Sunday=0).
 */
function getWeekdaysInRange(from: string, to: string): string[] {
    const dates: string[] = [];
    const current = new Date(from + "T12:00:00Z");
    const end = new Date(to + "T12:00:00Z");
    while (current <= end) {
        const day = current.getUTCDay();
        if (day !== 0 && day !== 6) {
            dates.push(current.toISOString().slice(0, 10));
        }
        current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
}

// ============================================================================
// Controller
// ============================================================================

export const psxIngestionController = {
    /**
     * Run daily stock ingestion pipeline
     * 
     * Flow:
     * 1. Load all companies from DB
     * 2. Check first company to detect stale data (non-trading day)
     * 3. Fetch intraday data for each (bounded concurrency)
     * 4. Aggregate to daily OHLCV in memory
     * 5. Bulk insert all rows with ON CONFLICT DO NOTHING
     */
    runDailyIngestion: async (c: AppContext) => {
        const startTime = Date.now();
        const today = getTodayKarachi();

        const stats = {
            companiesTotal: 0,
            companiesProcessed: 0,
            companiesSkipped: 0,
            companiesFailed: 0,
            rowsInserted: 0,
            errors: [] as string[],
        };

        try {
            const supabase = await getSupabaseClient(c.env);

            // ========================================
            // Step 1: Load all companies
            // ========================================
            console.log("[PSX Ingestion] Loading companies...");

            const { data: companies, error: companiesError } = await supabase
                .from("companies")
                .select("id, symbol");

            if (companiesError) {
                throw new Error(`Failed to load companies: ${companiesError.message}`);
            }

            if (!companies || companies.length === 0) {
                return c.json({
                    success: false,
                    error: "No companies found in database",
                    timestamp: new Date().toISOString(),
                }, 400);
            }

            stats.companiesTotal = companies.length;
            console.log(`[PSX Ingestion] Loaded ${companies.length} companies`);

            // ========================================
            // Step 2: Early stale data detection
            // Use a well-known active stock to check what date the API is returning
            // Then check if we already have data for that date
            // ========================================
            console.log("[PSX Ingestion] Checking for fresh data...");

            // Use OGDC as sample - always actively traded. Fallback to first company.
            const sampleCompany = companies.find(c => c.symbol === "OGDC") ?? companies[0];
            const sampleTicks = await psxIntradayService.fetchIntradayTrades(sampleCompany.symbol);
            const dataDate = getDateFromTicks(sampleTicks);

            if (!dataDate) {
                console.log(`[PSX Ingestion] No trades found for sample company ${sampleCompany.symbol}`);
                // Continue anyway - might just be this specific company
            } else {
                // Check if we already have data for this date in the database
                const { count, error: countError } = await supabase
                    .from("daily_stock_data")
                    .select("*", { count: "exact", head: true })
                    .eq("trade_date", dataDate);

                if (countError) {
                    console.warn(`[PSX Ingestion] Could not check existing data: ${countError.message}`);
                } else if (count && count > 0) {
                    // We already have data for this date - skip
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                    console.log(`[PSX Ingestion] Data for ${dataDate} already exists (${count} rows). Skipping.`);

                    return c.json({
                        success: true,
                        message: "Data already exists for this trading day",
                        skipped: true,
                        reason: `Already have ${count} rows for ${dataDate}`,
                        stats: {
                            ...stats,
                            durationSeconds: parseFloat(duration),
                        },
                        timestamp: new Date().toISOString(),
                    });
                }
            }

            console.log(`[PSX Ingestion] Will ingest data for ${dataDate}`);
            const tradeDate = dataDate || today;

            // ========================================
            // Step 3: Fetch and aggregate (in memory)
            // ========================================
            console.log(`[PSX Ingestion] Processing with concurrency=${INGESTION_CONFIG.CONCURRENCY}...`);

            const dailyRows: DailyOHLCV[] = [];

            // Process remaining companies (skip the sample we already fetched)
            const remainingCompanies = companies.slice(1);

            // Add the sample company's data if valid
            const sampleDailyData = aggregateIntradayToDaily(sampleCompany.id, tradeDate, sampleTicks);
            if (sampleDailyData) {
                dailyRows.push(sampleDailyData);
                stats.companiesProcessed++;
            } else {
                stats.companiesSkipped++;
            }

            const { results, errors } = await processBatched(
                remainingCompanies,
                INGESTION_CONFIG.CONCURRENCY,
                async (company) => {
                    // Fetch intraday data
                    const ticks = await psxIntradayService.fetchIntradayTrades(company.symbol);

                    // Aggregate immediately (ticks are discarded after this)
                    const dailyData = aggregateIntradayToDaily(company.id, tradeDate, ticks);

                    return { company, dailyData };
                }
            );

            // Collect successful aggregations
            for (const { company, dailyData } of results) {
                if (dailyData) {
                    dailyRows.push(dailyData);
                    stats.companiesProcessed++;
                } else {
                    stats.companiesSkipped++;
                    console.log(`[PSX Ingestion] No trades for ${company.symbol}, skipping`);
                }
            }

            // Log errors but continue
            for (const { item, error } of errors) {
                stats.companiesFailed++;
                stats.errors.push(`${item.symbol}: ${error}`);
                console.error(`[PSX Ingestion] Failed for ${item.symbol}: ${error}`);
            }

            console.log(`[PSX Ingestion] Aggregated ${dailyRows.length} daily rows`);

            // ========================================
            // Step 3: Bulk insert with conflict handling
            // ========================================
            if (dailyRows.length > 0) {
                console.log("[PSX Ingestion] Inserting daily rows...");

                // Insert in batches to avoid payload limits
                for (let i = 0; i < dailyRows.length; i += INGESTION_CONFIG.DB_BATCH_SIZE) {
                    const batch = dailyRows.slice(i, i + INGESTION_CONFIG.DB_BATCH_SIZE);

                    const { error: insertError } = await supabase
                        .from("daily_stock_data")
                        .upsert(batch, {
                            onConflict: "company_id,trade_date",
                            ignoreDuplicates: true, // ON CONFLICT DO NOTHING
                        });

                    if (insertError) {
                        stats.errors.push(`DB insert batch ${i}: ${insertError.message}`);
                        console.error(`[PSX Ingestion] Insert error:`, insertError);
                    } else {
                        stats.rowsInserted += batch.length;
                    }
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[PSX Ingestion] Completed in ${duration}s`);

            return c.json({
                success: true,
                message: "Daily stock ingestion completed",
                tradeDate,
                stats: {
                    ...stats,
                    durationSeconds: parseFloat(duration),
                    errorCount: stats.errors.length,
                },
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[PSX Ingestion] Pipeline failed:", err);
            return c.json(errorResponse(err), 500);
        }
    },

    /**
     * Run backfill for a specific date using PSX Closing Rate PDF
     * Date must be provided as query param: ?date=2025-12-17
     *
     * Flow:
     * 1. Count-based idempotency check (skip if already fully backfilled)
     * 2. Fetch valid symbols from DB (companies table)
     * 3. Download & parse Closing Rate PDF from PSX
     * 4. Filter: only rows whose symbol exists in DB, skip FUTURE CONTRACTS & BONDS
     * 5. Upsert into daily_stock_data (overwrites partial data on retry)
     */
    runForDate: async (c: AppContext) => {
        const dateParam = c.req.query("date");

        if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
            return c.json({
                success: false,
                error: "Invalid date format. Use ?date=YYYY-MM-DD",
                timestamp: new Date().toISOString(),
            }, 400);
        }

        try {
            const supabase = await getSupabaseClient(c.env);

            const { data: companies, error: companiesError } = await supabase
                .from("companies")
                .select("id, symbol");

            if (companiesError || !companies?.length) {
                return c.json({ success: false, error: "Failed to load companies", timestamp: new Date().toISOString() }, 500);
            }

            const symbolToId = new Map<string, string>();
            for (const company of companies) {
                symbolToId.set(company.symbol.toUpperCase(), company.id);
            }

            console.log(`[PSX Backfill] Running for ${dateParam}...`);
            const result = await backfillDateCore(supabase, dateParam, symbolToId, INGESTION_CONFIG.DB_BATCH_SIZE);

            if (result.error) {
                return c.json({ success: false, ...result, timestamp: new Date().toISOString() }, 422);
            }

            return c.json({
                success: true,
                message: result.skipped
                    ? `Skipped: ${result.skipReason}`
                    : `Backfill for ${dateParam} completed`,
                ...result,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[PSX Backfill] Pipeline failed:", err);
            return c.json(errorResponse(err), 500);
        }
    },

    /**
     * Backfill a date range
     * POST /admin/api/psx/ingest/backfill/range?from=YYYY-MM-DD&to=YYYY-MM-DD
     *
     * Iterates every weekday in the range, skips weekends + holidays (no PDF),
     * skips already-filled dates. Max 60 weekdays per request.
     */
    runForDateRange: async (c: AppContext) => {
        const fromParam = c.req.query("from");
        const toParam = c.req.query("to");
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;

        if (!fromParam || !toParam || !dateRe.test(fromParam) || !dateRe.test(toParam)) {
            return c.json({
                success: false,
                error: "Use ?from=YYYY-MM-DD&to=YYYY-MM-DD",
                timestamp: new Date().toISOString(),
            }, 400);
        }

        if (fromParam > toParam) {
            return c.json({ success: false, error: "'from' must be before or equal to 'to'", timestamp: new Date().toISOString() }, 400);
        }

        // PDF parsing is CPU-intensive (~500ms CPU per date).
        // Cloudflare Workers paid tier has a 30s CPU limit.
        // Cap at 7 dates (~3.5s CPU) to stay well within limits.
        const MAX_DAYS = 7;
        const weekdays = getWeekdaysInRange(fromParam, toParam);
        if (weekdays.length > MAX_DAYS) {
            return c.json({
                success: false,
                error: `Date range spans ${weekdays.length} weekdays. Max is ${MAX_DAYS} per request (PDF parsing is CPU-intensive). Split into smaller ranges.`,
                timestamp: new Date().toISOString(),
            }, 400);
        }

        const overallStart = Date.now();

        try {
            const supabase = await getSupabaseClient(c.env);

            // Load companies once for the whole range
            const { data: companies, error: companiesError } = await supabase
                .from("companies")
                .select("id, symbol");

            if (companiesError || !companies?.length) {
                return c.json({ success: false, error: "Failed to load companies", timestamp: new Date().toISOString() }, 500);
            }

            const symbolToId = new Map<string, string>();
            for (const company of companies) {
                symbolToId.set(company.symbol.toUpperCase(), company.id);
            }

            console.log(`[PSX Range Backfill] Processing ${weekdays.length} weekdays from ${fromParam} to ${toParam}`);

            const results: BackfillDateResult[] = [];
            for (const date of weekdays) {
                console.log(`[PSX Range Backfill] → ${date}`);
                const result = await backfillDateCore(supabase, date, symbolToId, INGESTION_CONFIG.DB_BATCH_SIZE);
                results.push(result);
            }

            const summary = {
                totalDates: weekdays.length,
                processed: results.filter(r => !r.skipped && !r.error).length,
                skipped: results.filter(r => r.skipped).length,
                failed: results.filter(r => !r.skipped && r.error).length,
                totalRowsUpserted: results.reduce((sum, r) => sum + r.rowsUpserted, 0),
                durationSeconds: parseFloat(((Date.now() - overallStart) / 1000).toFixed(2)),
            };

            console.log(`[PSX Range Backfill] Done. ${summary.processed} processed, ${summary.skipped} skipped, ${summary.failed} failed in ${summary.durationSeconds}s`);

            return c.json({
                success: true,
                message: `Range backfill ${fromParam} → ${toParam} completed`,
                summary,
                results,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[PSX Range Backfill] Failed:", err);
            return c.json(errorResponse(err), 500);
        }
    },
};
