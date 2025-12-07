import { Hono } from "hono";
import { psxController } from "../controllers";

/**
 * PSX Router - Pakistan Stock Exchange routes
 * Base path: /api/psx
 */
const psxRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Companies endpoints
psxRouter.get("/companies", psxController.getCompanies);
psxRouter.get("/companies/:id", psxController.getCompanyById);
psxRouter.get("/companies/symbol/:symbol", psxController.getCompanyBySymbol);

// Stock data endpoints
psxRouter.get("/companies/:companyId/stock-data", psxController.getStockData);

export { psxRouter };
