/**
 * Sarmaaya API Service
 * Handles all interactions with Sarmaaya's REST APIs for mutual fund data
 */

// ============================================================================
// Types for Sarmaaya API Responses
// ============================================================================

export interface SarmaayaFundListItem {
    fundId: string;
    name: string;
    symbol: string;
    riskProfile: string;
    nav: number;
    aum: string;
    changePercent1d: number;
    logo: string;
    isShariah: boolean;
    fundType: string;
}

interface SarmaayaFundListResponse {
    success: boolean;
    message: string;
    response: {
        data: SarmaayaFundListItem[];
        currentPage: number;
        pageSize: number;
        totalItems: number;
        totalPages: number;
        next: string | null;
        previous: string | null;
    };
}

interface SarmaayaNavHistoryItem {
    fundId: string;
    name: string;
    nav: number;
    date: string; // Unix timestamp in seconds
}

interface SarmaayaFundDetail {
    fundId: string;
    name: string;
    aum: string;
    nav: string;
    symbol: string;
    oneMonthPercent: number;
    threeMonthsPercent: number;
    sixMonthsPercent: number;
    ytdPercent: number;
    oneYearPercent: number;
}

interface SarmaayaEnrichmentResponse {
    success: boolean;
    message: string;
    response: {
        mutualFundSeriesHistory: SarmaayaNavHistoryItem[][];
        mutualFundDetail: SarmaayaFundDetail[];
    };
}

// ============================================================================
// Configuration
// ============================================================================

const SARMAAYA_BASE_URL = "https://beta-restapi.sarmaaya.pk/api";
const DEFAULT_PAGE_SIZE = 700;
const NAV_HISTORY_DAYS = 5 * 365; // ~5 years of history

// ============================================================================
// API Client
// ============================================================================

export const sarmaayaService = {
    /**
     * Fetch all mutual funds from Sarmaaya's paginated API
     * Handles pagination automatically and returns all funds
     */
    fetchAllMutualFunds: async (): Promise<SarmaayaFundListItem[]> => {
        const allFunds: SarmaayaFundListItem[] = [];
        let currentPage = 1;
        let totalPages = 1;

        do {
            const url = `${SARMAAYA_BASE_URL}/mutual-funds?page=${currentPage}&limit=${DEFAULT_PAGE_SIZE}`;
            console.log(`[Sarmaaya] Fetching page ${currentPage} of funds...`);

            const response = await fetch(url, {
                headers: {
                    accept: "application/json",
                    "user-agent": "finasaan-marrow/1.0",
                },
            });

            if (!response.ok) {
                throw new Error(
                    `Sarmaaya API error: ${response.status} ${response.statusText}`
                );
            }

            const data: SarmaayaFundListResponse = await response.json();

            if (!data.success) {
                throw new Error(`Sarmaaya API returned error: ${data.message}`);
            }

            allFunds.push(...data.response.data);
            totalPages = data.response.totalPages;
            currentPage++;

            console.log(
                `[Sarmaaya] Fetched ${data.response.data.length} funds (page ${data.response.currentPage}/${totalPages})`
            );
        } while (currentPage <= totalPages);

        console.log(`[Sarmaaya] Total funds fetched: ${allFunds.length}`);
        return allFunds;
    },

    /**
     * Fetch enrichment data and NAV history for a specific fund
     * Returns enrichment metrics and full NAV time series
     */
    fetchFundEnrichment: async (
        fundId: string
    ): Promise<{
        detail: SarmaayaFundDetail | null;
        navHistory: SarmaayaNavHistoryItem[];
    }> => {
        const url = `${SARMAAYA_BASE_URL}/mutual-funds/peers-change/${fundId}`;

        const response = await fetch(url, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                "user-agent": "finasaan-marrow/1.0",
            },
            body: JSON.stringify({
                fundIds: [],
                days: NAV_HISTORY_DAYS,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Sarmaaya enrichment API error for ${fundId}: ${response.status}`
            );
        }

        const data: SarmaayaEnrichmentResponse = await response.json();

        if (!data.success) {
            throw new Error(
                `Sarmaaya enrichment API returned error for ${fundId}: ${data.message}`
            );
        }

        // Extract detail (first item if exists)
        const detail = data.response.mutualFundDetail?.[0] ?? null;

        // Flatten NAV history (it's an array of arrays)
        const navHistory = data.response.mutualFundSeriesHistory?.flat() ?? [];

        return { detail, navHistory };
    },
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert Unix timestamp (seconds) to ISO date string (YYYY-MM-DD)
 */
export function unixToDate(unixSeconds: string | number): string {
    const timestamp =
        typeof unixSeconds === "string" ? parseInt(unixSeconds, 10) : unixSeconds;
    const date = new Date(timestamp * 1000);
    return date.toISOString().split("T")[0];
}

/**
 * Convert AUM string to bigint (removing any non-numeric characters)
 */
export function parseAum(aum: string | null | undefined): number | null {
    if (!aum) return null;
    const cleaned = aum.replace(/[^0-9.-]/g, "");
    const parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? null : parsed;
}

/**
 * Chunk an array into smaller arrays of specified size
 */
export function chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
