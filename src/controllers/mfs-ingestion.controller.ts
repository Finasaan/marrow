/**
 * MFS Ingestion Controller
 * Two-phase pipeline for ingesting mutual fund data from Sarmaaya APIs
 */

import { getSupabaseClient } from "../db";
import { AppContext, errorResponse } from "../types";
import {
    sarmaayaService,
    SarmaayaFundListItem,
    unixToDate,
    parseAum,
    chunk,
} from "../services/sarmaaya.service";

// ============================================================================
// Configuration
// ============================================================================

const BATCH_CONFIG = {
    /** Number of funds to process per enrichment transaction */
    FUNDS_PER_ENRICHMENT_BATCH: 15,
    /** Number of NAV rows per INSERT statement */
    NAV_ROWS_PER_INSERT: 1500,
};

// ============================================================================
// Controller
// ============================================================================

export const mfsIngestionController = {
    /**
     * Run the full two-phase ingestion pipeline
     * Phase 1: Bulk sector + fund upsert
     * Phase 2: Enrichment + NAV history (batched)
     */
    runFullPipeline: async (c: AppContext) => {
        const startTime = Date.now();
        const stats = {
            sectorsUpserted: 0,
            fundsUpserted: 0,
            fundsEnriched: 0,
            navRowsInserted: 0,
            errors: [] as string[],
        };

        try {
            const supabase = await getSupabaseClient(c.env);

            // ========================================
            // PHASE 1: Bulk Metadata Upsert
            // ========================================
            console.log("[Ingestion] Starting Phase 1: Bulk Metadata Upsert");

            // 1a. Fetch all funds from Sarmaaya
            const allFunds = await sarmaayaService.fetchAllMutualFunds();
            console.log(`[Ingestion] Fetched ${allFunds.length} funds from Sarmaaya`);

            // 1b. Collect unique sector names (fundType)
            const uniqueSectorNames = [
                ...new Set(
                    allFunds
                        .map((f) => f.fundType?.trim())
                        .filter((name): name is string => !!name)
                ),
            ];
            console.log(
                `[Ingestion] Found ${uniqueSectorNames.length} unique sectors`
            );

            // 1c. Bulk upsert sectors
            if (uniqueSectorNames.length > 0) {
                const sectorsToUpsert = uniqueSectorNames.map((name) => ({ name }));
                const { data: sectorsResult, error: sectorsError } = await supabase
                    .from("sectors")
                    .upsert(sectorsToUpsert, { onConflict: "name" })
                    .select();

                if (sectorsError) {
                    throw new Error(`Sector upsert failed: ${sectorsError.message}`);
                }
                stats.sectorsUpserted = sectorsResult?.length ?? 0;
                console.log(`[Ingestion] Upserted ${stats.sectorsUpserted} sectors`);
            }

            // 1d. Build sector name -> id map
            const { data: allSectors, error: sectorFetchError } = await supabase
                .from("sectors")
                .select("id, name")
                .in("name", uniqueSectorNames);

            if (sectorFetchError) {
                throw new Error(`Sector fetch failed: ${sectorFetchError.message}`);
            }

            const sectorMap = new Map<string, number>();
            allSectors?.forEach((s) => {
                if (s.name && s.id) sectorMap.set(s.name, s.id);
            });

            // 1e. Bulk upsert mutual funds (keyed by external_id)
            const fundsToUpsert = allFunds.map((fund) => ({
                external_id: fund.fundId,
                name: fund.name,
                symbol: fund.symbol || null,
                risk_profile: fund.riskProfile || null,
                aum: parseAum(fund.aum),
                is_shariah_compliant: fund.isShariah ?? false,
                sector_id: fund.fundType ? sectorMap.get(fund.fundType.trim()) : null,
            }));

            const { data: fundsResult, error: fundsError } = await supabase
                .from("mutual_funds")
                .upsert(fundsToUpsert, { onConflict: "external_id" })
                .select("id, external_id");

            if (fundsError) {
                throw new Error(`Fund upsert failed: ${fundsError.message}`);
            }
            stats.fundsUpserted = fundsResult?.length ?? 0;
            console.log(`[Ingestion] Upserted ${stats.fundsUpserted} funds`);

            // Build external_id -> internal id map for NAV history
            const fundIdMap = new Map<string, number>();
            fundsResult?.forEach((f) => {
                if (f.external_id && f.id) fundIdMap.set(f.external_id, f.id);
            });

            // ========================================
            // PHASE 2: Enrichment + NAV History
            // ========================================
            console.log("[Ingestion] Starting Phase 2: Enrichment + NAV History");

            const fundBatches = chunk(allFunds, BATCH_CONFIG.FUNDS_PER_ENRICHMENT_BATCH);
            console.log(
                `[Ingestion] Processing ${fundBatches.length} batches of funds`
            );

            for (let batchIdx = 0; batchIdx < fundBatches.length; batchIdx++) {
                const batch = fundBatches[batchIdx];
                console.log(
                    `[Ingestion] Processing batch ${batchIdx + 1}/${fundBatches.length} (${batch.length} funds)`
                );

                for (const fund of batch) {
                    try {
                        const internalId = fundIdMap.get(fund.fundId);
                        if (!internalId) {
                            console.warn(
                                `[Ingestion] No internal ID found for fund ${fund.fundId}`
                            );
                            continue;
                        }

                        // Fetch enrichment data
                        const { detail, navHistory } =
                            await sarmaayaService.fetchFundEnrichment(fund.fundId);

                        // 2a. Update enrichment metrics
                        if (detail) {
                            const { error: updateError } = await supabase
                                .from("mutual_funds")
                                .update({
                                    onemonthperc: detail.oneMonthPercent ?? null,
                                    ytd: detail.ytdPercent ?? null,
                                })
                                .eq("id", internalId);

                            if (updateError) {
                                stats.errors.push(
                                    `Enrichment update failed for ${fund.fundId}: ${updateError.message}`
                                );
                            } else {
                                stats.fundsEnriched++;
                            }
                        }

                        // 2b. Insert NAV history in batches
                        if (navHistory.length > 0) {
                            const navRows = navHistory.map((nav) => ({
                                fund_id: internalId,
                                nav_date: unixToDate(nav.date),
                                nav_price: nav.nav,
                            }));

                            // Chunk NAV rows for bulk insert
                            const navChunks = chunk(navRows, BATCH_CONFIG.NAV_ROWS_PER_INSERT);
                            for (const navChunk of navChunks) {
                                const { error: navError } = await supabase
                                    .from("mutual_fund_nav_history")
                                    .upsert(navChunk, {
                                        onConflict: "fund_id,nav_date",
                                        ignoreDuplicates: true,
                                    });

                                if (navError) {
                                    stats.errors.push(
                                        `NAV insert failed for ${fund.fundId}: ${navError.message}`
                                    );
                                } else {
                                    stats.navRowsInserted += navChunk.length;
                                }
                            }
                        }
                    } catch (err) {
                        const errorMsg =
                            err instanceof Error ? err.message : "Unknown error";
                        stats.errors.push(`Fund ${fund.fundId} failed: ${errorMsg}`);
                        console.error(`[Ingestion] Error processing fund ${fund.fundId}:`, err);
                        // Continue with next fund - don't roll back
                    }
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[Ingestion] Pipeline completed in ${duration}s`);

            return c.json({
                success: true,
                message: "Ingestion pipeline completed",
                stats: {
                    ...stats,
                    durationSeconds: parseFloat(duration),
                    errorCount: stats.errors.length,
                },
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[Ingestion] Pipeline failed:", err);
            return c.json(errorResponse(err), 500);
        }
    },

    /**
     * Run only Phase 1 (bulk metadata upsert)
     * Useful for quick sync without NAV history
     */
    runPhase1Only: async (c: AppContext) => {
        const startTime = Date.now();

        try {
            const supabase = await getSupabaseClient(c.env);

            // Fetch all funds
            const allFunds = await sarmaayaService.fetchAllMutualFunds();

            // Collect and upsert sectors
            const uniqueSectorNames = [
                ...new Set(
                    allFunds
                        .map((f) => f.fundType?.trim())
                        .filter((name): name is string => !!name)
                ),
            ];

            if (uniqueSectorNames.length > 0) {
                await supabase
                    .from("sectors")
                    .upsert(
                        uniqueSectorNames.map((name) => ({ name })),
                        { onConflict: "name" }
                    );
            }

            // Build sector map
            const { data: allSectors } = await supabase
                .from("sectors")
                .select("id, name")
                .in("name", uniqueSectorNames);

            const sectorMap = new Map<string, number>();
            allSectors?.forEach((s) => {
                if (s.name && s.id) sectorMap.set(s.name, s.id);
            });

            // Upsert funds
            const fundsToUpsert = allFunds.map((fund) => ({
                external_id: fund.fundId,
                name: fund.name,
                symbol: fund.symbol || null,
                risk_profile: fund.riskProfile || null,
                aum: parseAum(fund.aum),
                is_shariah_compliant: fund.isShariah ?? false,
                sector_id: fund.fundType ? sectorMap.get(fund.fundType.trim()) : null,
            }));

            const { data: fundsResult, error: fundsError } = await supabase
                .from("mutual_funds")
                .upsert(fundsToUpsert, { onConflict: "external_id" })
                .select();

            if (fundsError) {
                throw new Error(`Fund upsert failed: ${fundsError.message}`);
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            return c.json({
                success: true,
                message: "Phase 1 completed",
                stats: {
                    sectorsCount: uniqueSectorNames.length,
                    fundsUpserted: fundsResult?.length ?? 0,
                    durationSeconds: parseFloat(duration),
                },
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            return c.json(errorResponse(err), 500);
        }
    },
};
