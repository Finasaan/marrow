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

        const startTime = Date.now();
        const tradeDate = dateParam;

        const stats = {
            pdfRowsParsed: 0,
            rowsMatched: 0,
            rowsSkippedNoMatch: 0,
            rowsUpserted: 0,
            errors: [] as string[],
        };

        try {
            const supabase = await getSupabaseClient(c.env);

            // ========================================
            // Step 1: Count-based idempotency check
            // ========================================
            console.log(`[PSX Backfill] Checking existing data for ${tradeDate}...`);

            const { count: existingCount, error: countError } = await supabase
                .from("daily_stock_data")
                .select("*", { count: "exact", head: true })
                .eq("trade_date", tradeDate);

            if (countError) {
                console.warn(`[PSX Backfill] Could not check existing data: ${countError.message}`);
            }

            // ========================================
            // Step 2: Fetch valid symbols from DB
            // ========================================
            console.log("[PSX Backfill] Loading companies...");

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

            // Build symbol -> company_id lookup map
            const symbolToId = new Map<string, string>();
            for (const company of companies) {
                symbolToId.set(company.symbol.toUpperCase(), company.id);
            }

            const EXPECTED_MINIMUM = symbolToId.size;

            // Check idempotency: fully backfilled if count >= expected minimum
            if (existingCount !== null && existingCount !== undefined && existingCount >= EXPECTED_MINIMUM) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[PSX Backfill] Already have ${existingCount} rows for ${tradeDate} (expected ~${EXPECTED_MINIMUM}). Skipping.`);

                return c.json({
                    success: true,
                    message: "Data already fully backfilled for this date",
                    skipped: true,
                    reason: `Already have ${existingCount} rows for ${tradeDate} (expected ~${EXPECTED_MINIMUM})`,
                    tradeDate,
                    stats: {
                        ...stats,
                        existingRows: existingCount,
                        durationSeconds: parseFloat(duration),
                    },
                    timestamp: new Date().toISOString(),
                });
            }

            if (existingCount && existingCount > 0) {
                console.log(`[PSX Backfill] Partial data found (${existingCount}/${EXPECTED_MINIMUM} rows). Will upsert to fill gaps.`);
            }

            // ========================================
            // Step 3: Download & parse PDF
            // ========================================
            console.log(`[PSX Backfill] Downloading PDF for ${tradeDate}...`);

            const pdfData = await downloadClosingRatePDF(tradeDate);

            if (!pdfData) {
                return c.json({
                    success: false,
                    error: `No closing rate PDF available for ${tradeDate} (possibly a weekend or holiday)`,
                    timestamp: new Date().toISOString(),
                }, 404);
            }

            console.log(`[PSX Backfill] Parsing PDF (${pdfData.length} bytes)...`);

            const parsedRows = await parseClosingRatePDF(pdfData);
            stats.pdfRowsParsed = parsedRows.length;

            console.log(`[PSX Backfill] Parsed ${parsedRows.length} rows from PDF`);

            if (parsedRows.length === 0) {
                return c.json({
                    success: false,
                    error: `No stock data could be parsed from PDF for ${tradeDate}`,
                    timestamp: new Date().toISOString(),
                }, 422);
            }

            // ========================================
            // Step 4: Filter to DB-known symbols only
            // ========================================
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

            for (const row of parsedRows) {
                const companyId = symbolToId.get(row.symbol.toUpperCase());
                if (!companyId) {
                    stats.rowsSkippedNoMatch++;
                    continue;
                }

                stats.rowsMatched++;

                dailyRows.push({
                    company_id: companyId,
                    trade_date: tradeDate,
                    open_price: row.open,
                    high_price: row.high,
                    low_price: row.low,
                    close_price: row.close,
                    adjusted_close_price: row.close, // Same as close for now
                    volume: row.volume,
                });
            }

            console.log(`[PSX Backfill] Matched ${dailyRows.length} rows to DB companies, skipped ${stats.rowsSkippedNoMatch} unknown symbols`);

            // ========================================
            // Step 5: Upsert into daily_stock_data
            // Uses actual upsert (NOT ignoreDuplicates) to overwrite partial data
            // ========================================
            if (dailyRows.length > 0) {
                console.log(`[PSX Backfill] Upserting ${dailyRows.length} rows...`);

                for (let i = 0; i < dailyRows.length; i += INGESTION_CONFIG.DB_BATCH_SIZE) {
                    const batch = dailyRows.slice(i, i + INGESTION_CONFIG.DB_BATCH_SIZE);

                    const { error: insertError } = await supabase
                        .from("daily_stock_data")
                        .upsert(batch, {
                            onConflict: "company_id,trade_date",
                            ignoreDuplicates: false, // Overwrite on conflict (for partial failure recovery)
                        });

                    if (insertError) {
                        stats.errors.push(`DB upsert batch ${Math.floor(i / INGESTION_CONFIG.DB_BATCH_SIZE)}: ${insertError.message}`);
                        console.error(`[PSX Backfill] Upsert error:`, insertError);
                    } else {
                        stats.rowsUpserted += batch.length;
                    }
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[PSX Backfill] Completed in ${duration}s`);

            return c.json({
                success: true,
                message: `Backfill for ${tradeDate} completed`,
                tradeDate,
                stats: {
                    ...stats,
                    existingRows: existingCount ?? 0,
                    durationSeconds: parseFloat(duration),
                    errorCount: stats.errors.length,
                },
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[PSX Backfill] Pipeline failed:", err);
            return c.json(errorResponse(err), 500);
        }
    },
};
