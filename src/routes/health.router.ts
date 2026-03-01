import { Hono } from "hono";
import { healthController } from "../controllers";

/**
 * Health Router - Health check and utility routes
 * Base path: /api
 */
const healthRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Health check (includes DB connectivity check)
healthRouter.get("/health", healthController.healthCheck);

export { healthRouter };
