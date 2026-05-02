import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import catalogRouter from "./routes/catalog.js";
import pluginsRouter from "./routes/plugins.js";
import mcpRouter from "./routes/mcp.js";
import { createAuthMiddleware } from "./middleware/auth.middleware.js";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

// Security & logging middleware
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  })
);

// CORS: the catalog API is a public distribution gateway intentionally accessible
// to external AI platforms (ChatGPT, Claude) — wildcard is required and expected.
// In production, restrict to known AI platform origins via the CORS_ORIGIN env var.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Consumer-Id",
      "X-Sensitivity-Ceiling",
    ],
  })
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());

// JWT auth middleware — validates bearer tokens and populates req.identity.
// Set AUTH_ENFORCE=true to reject requests with missing/invalid tokens.
app.use(createAuthMiddleware());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// Routes
app.use("/catalog", catalogRouter);
app.use("/mcp", mcpRouter);
app.use(pluginsRouter); // handles /.well-known/* and /openapi.json

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

export { app };

// Only start the server when run directly (not when imported in tests)
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`ARIA Distribution Gateway running on port ${PORT}`);
    console.log(`  Catalog API:  http://localhost:${PORT}/catalog/assets`);
    console.log(`  MCP Server:   http://localhost:${PORT}/mcp`);
    console.log(`  OpenAPI:      http://localhost:${PORT}/openapi.json`);
    console.log(`  ChatGPT:      http://localhost:${PORT}/.well-known/ai-plugin.json`);
    console.log(`  Health:       http://localhost:${PORT}/health`);
  });
}

export default app;
