/**
 * PSX Intraday API Service
 * Handles fetching intraday trade data from PSX for daily aggregation
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Raw intraday tick from PSX API
 * Format: [timestamp, price, quantity]
 */
export type IntradayTick = [number, number, number];

interface PSXIntradayResponse {
    status: number;
    message: string;
    data: IntradayTick[];
}

/**
 * Aggregated daily OHLCV data for a single company
 */
export interface DailyOHLCV {
    company_id: number;
    trade_date: string;
    open_price: number;
    high_price: number;
    low_price: number;
    close_price: number;
    adjusted_close_price: number;
    volume: number;
    value_traded: number;
}

// ============================================================================
// Configuration
// ============================================================================

const PSX_BASE_URL = "https://dps.psx.com.pk";

// ============================================================================
// API Client
// ============================================================================

/**
 * Raw EOD tick from PSX API (fallback endpoint)
 * Format: [timestamp, price, volume, value]
 */
type EODTick = [number, number, number, number];

interface PSXEODResponse {
    status: number;
    message: string;
    data: EODTick[];
}

/**
 * Result from fetching trade data, includes source indicator
 */
export interface TradeDataResult {
    ticks: IntradayTick[];
    source: 'intraday' | 'eod';
}

export const psxIntradayService = {
    /**
     * Fetch trades for a single symbol
     * Tries intraday endpoint first, falls back to EOD if intraday fails
     * Returns raw tick data ordered descending by timestamp (latest first)
     */
    fetchIntradayTrades: async (symbol: string): Promise<IntradayTick[]> => {
        const result = await psxIntradayService.fetchTradesWithFallback(symbol);
        return result.ticks;
    },

    /**
     * Fetch trades with source info (useful for debugging/logging)
     */
    fetchTradesWithFallback: async (symbol: string): Promise<TradeDataResult> => {
        // Try intraday endpoint first
        const intradayUrl = `${PSX_BASE_URL}/timeseries/int/${symbol}`;

        const intradayResponse = await fetch(intradayUrl, {
            headers: {
                accept: "application/json",
                "user-agent": "finasaan-marrow/1.0",
            },
        });

        if (intradayResponse.ok) {
            const intradayData: PSXIntradayResponse = await intradayResponse.json();

            if (intradayData.status === 1) {
                return {
                    ticks: intradayData.data ?? [],
                    source: 'intraday',
                };
            }
        }

        // Fallback to EOD endpoint (for TFCs, bonds, etc. that don't have intraday data)
        const eodUrl = `${PSX_BASE_URL}/timeseries/eod/${symbol}`;

        const eodResponse = await fetch(eodUrl, {
            headers: {
                accept: "application/json",
                "user-agent": "finasaan-marrow/1.0",
            },
        });

        if (!eodResponse.ok) {
            throw new Error(`PSX API error for ${symbol}: intraday and EOD both failed (EOD status: ${eodResponse.status})`);
        }

        const eodData: PSXEODResponse = await eodResponse.json();

        if (eodData.status !== 1) {
            throw new Error(`PSX API returned error for ${symbol}: ${eodData.message}`);
        }

        // Convert EOD format [timestamp, price, volume, value] to intraday format [timestamp, price, quantity]
        // For EOD data, the third element is already volume
        const convertedTicks: IntradayTick[] = (eodData.data ?? []).map(
            ([timestamp, price, volume, _value]) => [timestamp, price, volume] as IntradayTick
        );

        return {
            ticks: convertedTicks,
            source: 'eod',
        };
    },
};

// ============================================================================
// Aggregation Logic
// ============================================================================

/**
 * Aggregate intraday ticks into a single daily OHLCV row
 * 
 * CRITICAL: API returns data ordered descending by timestamp
 * - data[0] = LATEST trade (close price)
 * - data[data.length - 1] = EARLIEST trade (open price)
 * 
 * This function processes the array in a single pass for efficiency.
 */
export function aggregateIntradayToDaily(
    companyId: number,
    tradeDate: string,
    ticks: IntradayTick[]
): DailyOHLCV | null {
    if (ticks.length === 0) {
        return null;
    }

    // API guarantees: data[0] is latest, data[last] is earliest
    const closePrice = ticks[0][1];
    const openPrice = ticks[ticks.length - 1][1];

    // Single pass aggregation
    let highPrice = -Infinity;
    let lowPrice = Infinity;
    let totalVolume = 0;
    let totalValue = 0;

    for (const [_timestamp, price, quantity] of ticks) {
        if (price > highPrice) highPrice = price;
        if (price < lowPrice) lowPrice = price;
        totalVolume += quantity;
        totalValue += price * quantity;
    }

    return {
        company_id: companyId,
        trade_date: tradeDate,
        open_price: openPrice,
        high_price: highPrice,
        low_price: lowPrice,
        close_price: closePrice,
        adjusted_close_price: closePrice, // Same as close for now
        volume: totalVolume,
        value_traded: totalValue,
    };
}

// ============================================================================
// Concurrency Control
// ============================================================================

/**
 * Process items in batches with bounded concurrency
 * Batches are processed sequentially, items within a batch run in parallel
 */
export async function processBatched<T, R>(
    items: T[],
    batchSize: number,
    processor: (item: T) => Promise<R>
): Promise<{ results: R[]; errors: { item: T; error: string }[] }> {
    const results: R[] = [];
    const errors: { item: T; error: string }[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);

        const batchResults = await Promise.allSettled(batch.map(processor));

        batchResults.forEach((result, idx) => {
            if (result.status === "fulfilled") {
                results.push(result.value);
            } else {
                errors.push({
                    item: batch[idx],
                    error: result.reason?.message ?? "Unknown error",
                });
            }
        });
    }

    return { results, errors };
}

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Get today's date in Asia/Karachi timezone as YYYY-MM-DD
 */
export function getTodayKarachi(): string {
    const now = new Date();
    // Format in Asia/Karachi timezone
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Karachi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return formatter.format(now);
}

/**
 * Extract the trade date from intraday ticks
 * Uses the first tick (latest trade) to determine the date
 * Returns date in YYYY-MM-DD format (Asia/Karachi timezone)
 */
export function getDateFromTicks(ticks: IntradayTick[]): string | null {
    if (ticks.length === 0) return null;

    // First tick is the latest trade (API returns descending order)
    const latestTimestamp = ticks[0][0];
    const date = new Date(latestTimestamp * 1000);

    // Format in Asia/Karachi timezone
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Karachi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });

    return formatter.format(date);
}

/**
 * Check if the data is from today (not stale)
 * Returns true if data is fresh, false if stale (from previous trading day)
 */
export function isDataFresh(ticks: IntradayTick[]): boolean {
    const dataDate = getDateFromTicks(ticks);
    if (!dataDate) return false;

    const today = getTodayKarachi();
    return dataDate === today;
}

