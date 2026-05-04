import "./env.js";
import express from "express";
import { hubspotWebhookHandler } from "./webhooks/hubspot.js";
import { contactsRouter } from "./api/contacts.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Webhook route needs raw buffer for signature verification —
// must be registered BEFORE express.json() which would discard it.
app.use("/webhooks/hubspot", express.raw({ type: "application/json" }));

// All other routes get normal JSON parsing
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post("/webhooks/hubspot", hubspotWebhookHandler);
app.use("/api/contacts", contactsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("[server] shutting down…");
  server.close(() => process.exit(0));
});
