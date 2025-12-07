import { getSupabaseClient } from "../db";
import { AppContext, successResponse, errorResponse } from "../types";

/**
 * Health Controller - Handles health check and system status endpoints
 */
export const healthController = {
  /**
   * Basic health check
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

  // dbTest removed — its check is included in `healthCheck`

  /**
   * Simple message endpoint
   */
  message: (c: AppContext) => {
    return c.text("Hello from Spine API!");
  },

  /**
   * Financial tips endpoint
   */
  financialTips: (c: AppContext) => {
    const tips = [
      {
        id: 1,
        title: "Start an Emergency Fund",
        description: "Save 3-6 months of expenses for unexpected situations",
        category: "savings",
        priority: "high",
      },
      {
        id: 2,
        title: "Track Your Expenses",
        description:
          "Monitor where your money goes each month to identify saving opportunities",
        category: "budgeting",
        priority: "high",
      },
      {
        id: 3,
        title: "Invest Early",
        description:
          "Start investing as early as possible to benefit from compound interest",
        category: "investing",
        priority: "medium",
      },
    ];

    return c.json(successResponse(tips));
  },
};
