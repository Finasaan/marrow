import { Hono } from "hono";
import { mfsController, mfsIngestionController } from "../controllers";

/**
 * MFS Router - Mutual Funds routes
 * Base path: /api/mfs
 */
const mfsRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Fund providers
mfsRouter.get("/providers", mfsController.getFundProviders);

// Mutual funds endpoints
mfsRouter.get("/funds", mfsController.getMutualFunds);
mfsRouter.get("/funds/:id", mfsController.getMutualFundById);
mfsRouter.get("/funds/symbol/:symbol", mfsController.getMutualFundBySymbol);

// NAV history
mfsRouter.get("/funds/:fundId/nav", mfsController.getNavHistory);

// Ingestion endpoints (Sarmaaya pipeline)
mfsRouter.post("/ingest", mfsIngestionController.runFullPipeline);
mfsRouter.post("/ingest/phase1", mfsIngestionController.runPhase1Only);

export { mfsRouter };
