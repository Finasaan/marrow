import { Hono } from "hono";
import { psxRouter } from "./psx.router";
import { mfsRouter } from "./mfs.router";
import { healthRouter } from "./health.router";
import { insuranceRouter } from "./insurance.router";

/**
 * Main Router - Registers all route modules
 * Routes are registered for both production and preview environments
 */
const router = new Hono<{ Bindings: CloudflareBindings }>();

// Production routes (at /admin/api level)
router.route("/admin/api", healthRouter);
router.route("/admin/api/psx", psxRouter);
router.route("/admin/api/mfs", mfsRouter);
router.route("/admin/api/insurance", insuranceRouter);

// Preview routes (at /admin/api/preview level)
router.route("/admin/api/preview", healthRouter);
router.route("/admin/api/preview/psx", psxRouter);
router.route("/admin/api/preview/mfs", mfsRouter);
router.route("/admin/api/preview/insurance", insuranceRouter);

export { router };
