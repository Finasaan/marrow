import { Hono } from "hono";
import { healthController } from "../controllers";

/**
 * Health Router - Health check and utility routes
 * Base path: /api
 */
const healthRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Health and utility endpoints
healthRouter.get("/health", healthController.healthCheck);
healthRouter.get("/db-test", healthController.dbTest);
healthRouter.get("/message", healthController.message);

export { healthRouter };
