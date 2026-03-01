import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, paginatedResponse } from "../types";

/**
 * PSX Controller - Handles Pakistan Stock Exchange related endpoints
 */
export const psxController = {
  /**
   * Get list of companies
   */
  getCompanies: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const limit = parseInt(c.req.query("limit") || "10");
      const offset = parseInt(c.req.query("offset") || "0");

      const { data, error, count } = await supabase
        .from("companies")
        .select("*", { count: "exact" })
        .range(offset, offset + limit - 1);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(paginatedResponse(data, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get a single company by ID
   */
  getCompanyById: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return c.json({ success: false, error: `Company with id '${id}' not found` }, 404);
        }
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get company by symbol
   */
  getCompanyBySymbol: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const symbol = c.req.param("symbol");

      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("symbol", symbol.toUpperCase())
        .single();

      // PGRST116 = no rows found — .single() throws this when 0 results
      if (error) {
        if (error.code === "PGRST116") {
          return c.json({ success: false, error: `Company with symbol '${symbol.toUpperCase()}' not found` }, 404);
        }
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json({
        success: true,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get daily stock data for a company
   */
  getStockData: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const companyId = c.req.param("companyId");
      const limit = parseInt(c.req.query("limit") || "30");
      const offset = parseInt(c.req.query("offset") || "0");

      const { data, error, count } = await supabase
        .from("daily_stock_data")
        .select("*", { count: "exact" })
        .eq("company_id", companyId)
        .order("trade_date", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(paginatedResponse(data, { limit, offset, total: count }));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  updateSymbols: async (c: AppContext) => {
    try {
      const response = await fetch("https://dps.psx.com.pk/symbols");
      if (!response.ok) {
        return c.json(
          { success: false, error: "Failed to fetch symbols from PSX" },
          500
        );
      }
      const symbolsData: any = await response.json();
      const supabase = await getSupabaseClient(c.env);

      const uniqueSectorNames = Array.from(
        new Set(
          symbolsData
            .map((symbolEntry: any) =>
              symbolEntry.sectorName
                ? String(symbolEntry.sectorName).trim()
                : null
            )
            .filter((name: string | null) => name !== null)
        )
      ) as string[];

      const sectorsToUpsert = uniqueSectorNames.map((name: string) => {
        return { name: name };
      });

      const { data: sectorsResult, error: sectorsError } = await supabase
        .from("sectors")
        .upsert(sectorsToUpsert, { onConflict: "name" })
        .select();

      if (sectorsError) {
        return c.json({ success: false, error: sectorsError.message }, 500);
      }

      const sectorMap = new Map<string, string>();
      if (sectorsResult) {
        sectorsResult.forEach((sector: any) => {
          if (sector.name && sector.id) {
            sectorMap.set(sector.name, sector.id);
          }
        });
      }

      const companiesToUpsert = symbolsData.map((symbolEntry: any) => {
        const sectorName = symbolEntry.sectorName
          ? String(symbolEntry.sectorName).trim()
          : null;
        return {
          symbol: symbolEntry.symbol.toUpperCase(),
          company_name: symbolEntry.name,
          sector_id: sectorName ? sectorMap.get(sectorName) || null : null,
        };
      });

      const { data: companiesResult, error: companiesError } = await supabase
        .from("companies")
        .upsert(companiesToUpsert, { onConflict: "symbol" })
        .select();

      if (companiesError) {
        return c.json({ success: false, error: companiesError.message }, 500);
      }

      return c.json({
        success: true,
        data: companiesResult,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
