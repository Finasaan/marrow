import { Hono } from "hono";
import { psxController } from "../controllers";
import { psxIngestionController } from "../controllers/psx-ingestion.controller";

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

psxRouter.post("/companies/update/symbol", psxController.updateSymbols);

// Daily stock ingestion endpoints
psxRouter.post("/ingest/daily", psxIngestionController.runDailyIngestion);
psxRouter.post("/ingest/backfill", psxIngestionController.runForDate);
psxRouter.post("/ingest/backfill/range", psxIngestionController.runForDateRange);

export { psxRouter };
