/**
 * PSX Closing Rate PDF Service
 * Downloads and parses daily Closing Rate PDFs from PSX into structured OHLCV data
 *
 * PDF source: https://dps.psx.com.pk/download/closing_rates/{YYYY-MM-DD}.pdf
 *
 * Uses unpdf's getDocumentProxy for position-based text extraction to correctly
 * handle tabular column alignment (simple text extraction merges columns).
 */

// ============================================================================
// Types
// ============================================================================

export interface ParsedStockRow {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, x, y]
  width: number;
  height: number;
}

// ============================================================================
// Configuration
// ============================================================================

const PSX_PDF_BASE_URL = "https://dps.psx.com.pk/download/closing_rates";

/**
 * Sections in the PDF that should be excluded from stock data parsing.
 * Rows under these headers are bonds/futures, not equities.
 */
const EXCLUDED_SECTIONS = ["FUTURE CONTRACTS", "BONDS"];

// ============================================================================
// PDF Download
// ============================================================================

/**
 * Download the closing rate PDF for a given date from PSX
 * @returns PDF as Uint8Array, or null if not found (404)
 */
export async function downloadClosingRatePDF(
  date: string
): Promise<Uint8Array | null> {
  const url = `${PSX_PDF_BASE_URL}/${date}.pdf`;

  const response = await fetch(url, {
    headers: {
      "user-agent": "finasaan-marrow/1.0",
    },
  });

  if (response.status === 404) {
    return null; // No PDF for this date (weekend / holiday)
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download PSX PDF for ${date}: HTTP ${response.status}`
    );
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// ============================================================================
// Position-Based PDF Parsing
// ============================================================================

/**
 * Extract text items with positions from all pages of a PDF
 */
async function extractTextItemsFromPDF(
  pdfData: Uint8Array
): Promise<TextItem[][]> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(pdfData);

  const allPages: TextItem[][] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();

    const items: TextItem[] = textContent.items
      .filter((item: any) => typeof item.str === "string" && item.str.trim())
      .map((item: any) => ({
        str: item.str.trim(),
        transform: item.transform,
        width: item.width,
        height: item.height ?? 0,
      }));

    allPages.push(items);
  }

  return allPages;
}

/**
 * Group text items into rows based on Y-coordinate proximity.
 * Items with Y values within `tolerance` pixels are considered on the same row.
 */
function groupIntoRows(
  items: TextItem[],
  tolerance: number = 2
): TextItem[][] {
  if (items.length === 0) return [];

  // Sort by Y descending (PDF coordinates: Y=0 is bottom), then X ascending
  const sorted = [...items].sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > tolerance) return yDiff;
    return a.transform[4] - b.transform[4];
  });

  const rows: TextItem[][] = [];
  let currentRow: TextItem[] = [sorted[0]];
  let currentY = sorted[0].transform[5];

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const itemY = item.transform[5];

    if (Math.abs(itemY - currentY) <= tolerance) {
      // Same row
      currentRow.push(item);
    } else {
      // New row - sort current row by X before pushing
      currentRow.sort((a, b) => a.transform[4] - b.transform[4]);
      rows.push(currentRow);
      currentRow = [item];
      currentY = itemY;
    }
  }

  // Don't forget the last row
  currentRow.sort((a, b) => a.transform[4] - b.transform[4]);
  rows.push(currentRow);

  return rows;
}

/**
 * Detect column boundaries from a header row.
 * Returns a map of column name -> x-position midpoint.
 *
 * Expected columns in PSX Closing Rate PDF:
 * SYMBOL | LDCP | OPEN RATE | HIGHEST | LOWEST | CURRENT | CHANGE | TURNOVER
 *
 * We need: SYMBOL, OPEN RATE, HIGHEST, LOWEST, LAST RATE (or CURRENT), TURNOVER
 */
interface ColumnMap {
  symbolX: number;
  openX: number;
  highX: number;
  lowX: number;
  closeX: number;
  volumeX: number;
}

/**
 * Known header label patterns for each column we care about.
 * The PDF sometimes uses "CURRENT" or "LAST RATE" for close price.
 */
const HEADER_PATTERNS: Record<keyof ColumnMap, RegExp> = {
  symbolX: /^SYMBOL$/i,
  openX: /^OPEN\s*(?:RATE)?$/i,
  highX: /^HIGH(?:EST)?$/i,
  lowX: /^LOW(?:EST)?$/i,
  closeX: /^(?:CURRENT|LAST\s*RATE|CLOSE)$/i,
  volumeX: /^TURNOVER$/i,
};

/**
 * Find the header row and extract column X positions.
 * Scans through rows looking for a row that contains "SYMBOL" and "TURNOVER".
 */
function detectColumns(rows: TextItem[][]): ColumnMap | null {
  for (const row of rows) {
    const texts = row.map((item) => item.str.toUpperCase());
    const hasSymbol = texts.some((t) => /^SYMBOL$/i.test(t));
    const hasTurnover = texts.some((t) => /^TURNOVER$/i.test(t));

    if (!hasSymbol || !hasTurnover) continue;

    // This is the header row - extract X positions
    const columnMap: Partial<ColumnMap> = {};

    for (const item of row) {
      const text = item.str.toUpperCase();
      for (const [key, pattern] of Object.entries(HEADER_PATTERNS)) {
        if (pattern.test(text)) {
          columnMap[key as keyof ColumnMap] = item.transform[4];
        }
      }
    }

    // Validate we found all required columns
    const required: (keyof ColumnMap)[] = [
      "symbolX",
      "openX",
      "highX",
      "lowX",
      "closeX",
      "volumeX",
    ];
    const missing = required.filter((k) => columnMap[k] === undefined);

    if (missing.length > 0) {
      console.warn(
        `[PSX PDF] Header row found but missing columns: ${missing.join(", ")}. ` +
          `Found: ${JSON.stringify(texts)}`
      );
      // Try next potential header row
      continue;
    }

    return columnMap as ColumnMap;
  }

  return null;
}

/**
 * Find the closest text item in a row to a given X position.
 * Used to map data cells to their corresponding column.
 */
function getClosestValue(
  row: TextItem[],
  targetX: number,
  maxDistance: number = 50
): string | null {
  let closest: TextItem | null = null;
  let minDist = Infinity;

  for (const item of row) {
    const dist = Math.abs(item.transform[4] - targetX);
    if (dist < minDist && dist <= maxDistance) {
      minDist = dist;
      closest = item;
    }
  }

  return closest ? closest.str : null;
}

/**
 * Check if a row is a section header (e.g., "FUTURE CONTRACTS", "BONDS")
 * Section headers typically span the full width or are in bold/larger font.
 * We detect them by checking if the row text matches an excluded section name.
 */
function isExcludedSectionHeader(row: TextItem[]): boolean {
  const fullText = row
    .map((item) => item.str)
    .join(" ")
    .toUpperCase()
    .trim();
  return EXCLUDED_SECTIONS.some((section) => fullText.includes(section));
}

/**
 * Check if a row looks like a data row (has a symbol-like first column and numeric values).
 */
function isDataRow(row: TextItem[]): boolean {
  if (row.length < 3) return false;

  // First item should be alphabetic (symbol)
  const firstText = row[0].str;
  if (!/^[A-Z]{2,}/.test(firstText.toUpperCase())) return false;

  // Should have at least one numeric value
  const hasNumeric = row.some((item) => /^[\d,.-]+$/.test(item.str.replace(/,/g, "")));
  return hasNumeric;
}

/**
 * Parse a numeric string from the PDF (handles commas, dashes for zero)
 */
function parseNumber(value: string | null): number {
  if (!value || value === "-" || value === "--" || value.trim() === "") {
    return 0;
  }
  // Remove commas used as thousands separators
  const cleaned = value.replace(/,/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse a PSX Closing Rate PDF into structured stock rows.
 *
 * Strategy:
 * 1. Extract all text items with positions from all pages
 * 2. Group items into rows by Y-coordinate
 * 3. Detect column positions from header row
 * 4. Parse data rows, filtering out excluded sections
 * 5. Return array of ParsedStockRow
 */
export async function parseClosingRatePDF(
  pdfData: Uint8Array
): Promise<ParsedStockRow[]> {
  const pages = await extractTextItemsFromPDF(pdfData);
  const results: ParsedStockRow[] = [];

  let inExcludedSection = false;
  let globalColumnMap: ColumnMap | null = null;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageItems = pages[pageIdx];
    const rows = groupIntoRows(pageItems);

    // Try to detect columns on this page (each page may have its own header)
    const pageColumnMap = detectColumns(rows);
    if (pageColumnMap) {
      globalColumnMap = pageColumnMap;
      // Reset excluded section state when we find a new header
      inExcludedSection = false;
    }

    if (!globalColumnMap) {
      // Haven't found the header yet, skip this page's data rows
      console.warn(
        `[PSX PDF] No column header found yet (page ${pageIdx + 1})`
      );
      continue;
    }

    // Process data rows
    for (const row of rows) {
      // Check for section headers
      if (isExcludedSectionHeader(row)) {
        inExcludedSection = true;
        continue;
      }

      // Check if we encounter a new non-excluded section header
      // (Sections in the PDF are typically: "READY COUNTER", "FUTURE CONTRACTS", "BONDS")
      // If we see a new header row after being in an excluded section, re-evaluate
      const fullRowText = row
        .map((item) => item.str)
        .join(" ")
        .toUpperCase()
        .trim();

      // Detect if this is a header row (column headers re-appearing on a new page)
      if (fullRowText.includes("SYMBOL") && fullRowText.includes("TURNOVER")) {
        inExcludedSection = false;
        continue; // Skip the header row itself
      }

      if (inExcludedSection) continue;
      if (!isDataRow(row)) continue;

      // Extract values by column proximity
      const symbol = getClosestValue(row, globalColumnMap.symbolX);
      const openStr = getClosestValue(row, globalColumnMap.openX);
      const highStr = getClosestValue(row, globalColumnMap.highX);
      const lowStr = getClosestValue(row, globalColumnMap.lowX);
      const closeStr = getClosestValue(row, globalColumnMap.closeX);
      const volumeStr = getClosestValue(row, globalColumnMap.volumeX);

      if (!symbol) continue;

      // Clean symbol: remove any trailing whitespace or special chars
      const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (!cleanSymbol) continue;

      const open = parseNumber(openStr);
      const high = parseNumber(highStr);
      const low = parseNumber(lowStr);
      const close = parseNumber(closeStr);
      const volume = parseNumber(volumeStr);

      // Skip rows where all prices are 0 (no trading activity)
      if (open === 0 && high === 0 && low === 0 && close === 0) continue;

      results.push({
        symbol: cleanSymbol,
        open,
        high,
        low,
        close,
        volume,
      });
    }
  }

  return results;
}
