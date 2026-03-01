import { Hono } from "hono";
import { cors } from "hono/cors";
import { apiReference } from "@scalar/hono-api-reference";
import { router } from "./routes";

/**
 * Marrow API - Finasaan Admin/Ingestion Backend Service
 * Main application entry point
 */
const app = new Hono<{ Bindings: CloudflareBindings }>();

// ============================================
// Global Middleware
// ============================================

// Enable CORS for cross-origin requests
app.use(
  "/*",
  cors({
    origin: ["http://localhost:3000", "https://*.finasaan.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ============================================
// Routes
// ============================================

// Serve Scalar documentation at /docs
// openapi.yaml is served statically by Cloudflare ASSETS at /openapi.yaml
app.get("/docs", apiReference({
  pageTitle: "Finasaan Marrow Admin API Docs",
  url: "/openapi.yaml",
}));

// Mount all routes from router
app.route("/", router);

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
      path: c.req.path,
      timestamp: new Date().toISOString(),
    },
    404
  );
});

// ============================================
// Error Handler
// ============================================

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      success: false,
      error: "Internal Server Error",
      message: err.message,
      timestamp: new Date().toISOString(),
    },
    500
  );
});

export default app;
