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
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Company not found" }, 404);
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

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Company not found" }, 404);
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
};
