import { getSupabaseClient } from "../db";
import { AppContext, errorResponse, successResponse } from "../types";

/**
 * Sectors Controller - Handles sector-related endpoints
 */
export const sectorsController = {
  /**
   * Get all sectors
   */
  getSectors: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);

      const { data, error } = await supabase.from("sectors").select("*");

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get a sector by ID
   */
  getSectorById: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const id = c.req.param("id");

      const { data, error } = await supabase
        .from("sectors")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      if (!data) {
        return c.json({ success: false, error: "Sector not found" }, 404);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Get companies in a sector
   */
  getSectorCompanies: async (c: AppContext) => {
    try {
      const supabase = await getSupabaseClient(c.env);
      const sectorId = c.req.param("sectorId");

      const { data, error } = await supabase
        .from("companies")
        .select("*")
        .eq("sector_id", sectorId);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },
};
