import { getSupabaseClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";

/**
 * Health Controller - Handles health check and system status endpoints
 */
export const healthController = {
  /**
   * Basic health check
   */
  healthCheck: (c: AppContext) => {
    return c.json({
      status: "healthy",
      service: "marrow",
      timestamp: new Date().toISOString(),
    });
  },

  /**
   * Database connection test
   */
  dbTest: async (c: AppContext) => {
    try {
      const supabase = getSupabaseClient(c.env);
      const { data, error } = await supabase
        .from("sectors")
        .select("*")
        .limit(5);

      if (error) {
        return c.json({ success: false, error: error.message }, 500);
      }

      return c.json(successResponse(data));
    } catch (err) {
      return c.json(errorResponse(err), 500);
    }
  },

  /**
   * Simple message endpoint
   */
  message: (c: AppContext) => {
    return c.text("Hello from Marrow!");
  },
};
