/**
 * Tax Documents Router — Marrow (ingestion side)
 * Base path: /admin/api/tax-docs
 */

import { Hono } from "hono";
import { taxIngestionController } from "../controllers/tax-ingestion.controller";

const taxDocsRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Run bulk ingestion from TAX_DOCUMENT_URLS list
taxDocsRouter.post("/ingest/run", taxIngestionController.runBulkIngestion);

// Ingest a single PDF by URL
taxDocsRouter.post("/ingest/single", taxIngestionController.ingestSingle);

// List all ingested tax documents
taxDocsRouter.get("/documents", taxIngestionController.listDocuments);

export { taxDocsRouter };
