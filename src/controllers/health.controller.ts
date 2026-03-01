import { getSupabaseClient } from "../db";
import { AppContext } from "../types";

/**
 * Health Controller - Handles health check and system status endpoints
 */
export const healthController = {
  /**
   * Health check — includes lightweight DB connectivity check
   */
  healthCheck: async (c: AppContext) => {
    const base = {
      status: "healthy",
      service: "spine",
      timestamp: new Date().toISOString(),
    };

    // include a lightweight DB check in the health response
    try {
      const supabase = await getSupabaseClient(c.env);
      const { data, error } = await supabase
        .from("sectors")
        .select("id")
        .limit(1);

      if (error) {
        return c.json(
          { ...base, db: { ok: false, error: error.message } },
          200
        );
      }

      return c.json(
        {
          ...base,
          db: { ok: true, sampleCount: Array.isArray(data) ? data.length : 0 },
        },
        200
      );
    } catch (err) {
      return c.json({ ...base, db: { ok: false, error: String(err) } }, 200);
    }
  },
};
