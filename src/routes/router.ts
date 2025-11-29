import { Hono } from "hono";
import { healthRouter } from "./health.router";

/**
 * Main Router - Registers all route modules
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Health and utility routes (at /admin/api level)
router.route("/admin/api", healthRouter);

export { router };
