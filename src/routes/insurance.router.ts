/**
 * Insurance Router — Marrow (ingestion side)
 * Base path: /admin/api/insurance
 */

import { Hono } from "hono";
import { insuranceIngestionController } from "../controllers/insurance-ingestion.controller";

const insuranceRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Run full ingestion pipeline (all 24 PDFs)
insuranceRouter.post(
  "/ingest/run",
  insuranceIngestionController.runFullIngestion
);

// Ingest a single PDF URL
insuranceRouter.post(
  "/ingest/single",
  insuranceIngestionController.ingestSingle
);

// List all ingested documents
insuranceRouter.get("/documents", insuranceIngestionController.listDocuments);

export { insuranceRouter };
