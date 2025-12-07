import { Hono } from "hono";
import { healthController } from "../controllers";

/**
 * Health Router - Health check and utility routes
 * Base path: /api
 */
const healthRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Health and utility endpoints
healthRouter.get("/health", healthController.healthCheck);
healthRouter.get("/message", healthController.message);
healthRouter.get("/financial-tips", healthController.financialTips);

export { healthRouter };
