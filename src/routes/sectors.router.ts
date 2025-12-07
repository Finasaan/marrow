import { Hono } from "hono";
import { sectorsController } from "../controllers";

/**
 * Sectors Router - Industry sectors routes
 * Base path: /api/sectors
 */
const sectorsRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Sectors endpoints
sectorsRouter.get("/", sectorsController.getSectors);
sectorsRouter.get("/:id", sectorsController.getSectorById);
sectorsRouter.get("/:sectorId/companies", sectorsController.getSectorCompanies);

export { sectorsRouter };
