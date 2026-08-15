require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payment");
const emailRoutes = require("./routes/email");
const { errorHandler } = require("./middleware/errorHandler");
const { startOrderListener } = require("./utils/orderListener");
const { startPaymentReconciler } = require("./utils/paymentReconciler");

// Last-resort guards. An unhandled promise rejection (e.g. a transient
// Firestore error inside a detached async callback) is logged and survived —
// the individual handlers do their own recovery. An uncaught synchronous
// exception is different: the process is in an undefined state and must NOT
// keep taking payments — log and exit so the platform restarts a clean one.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception — exiting for a clean restart:", err);
  process.exit(1);
});

// Fail fast on missing payment-critical configuration: a deploy without the
// CCAvenue credentials or redirect URLs would otherwise boot "healthy" and
// 500 the first real customer at checkout.
{
  const mode = String(process.env.CCAVENUE_MODE || "live").toLowerCase();
  // "sandbox" counts as test everywhere else (getMerchantConfig, init URL,
  // status API) — the boot check must agree or it validates the wrong creds.
  const isTest = mode === "test" || mode === "sandbox";
  const pick = (live, test, generic) =>
    isTest ? (process.env[test] || process.env[generic]) : (process.env[live] || process.env[generic]);
  const missing = [];
  if (!pick("LIVE_MERCHANT_ID", "TEST_MERCHANT_ID", "MERCHANT_ID")) missing.push("MERCHANT_ID");
  if (!pick("LIVE_ACCESS_CODE", "TEST_ACCESS_CODE", "ACCESS_CODE")) missing.push("ACCESS_CODE");
  if (!pick("LIVE_WORKING_KEY", "TEST_WORKING_KEY", "WORKING_KEY")) missing.push("WORKING_KEY");
  if (!process.env.REDIRECT_URL) missing.push("REDIRECT_URL");
  if (!process.env.CANCEL_URL) missing.push("CANCEL_URL");
  if (missing.length) {
    const msg = `[boot] Missing required payment env (${mode} mode): ${missing.join(", ")}`;
    if (process.env.NODE_ENV === "production") {
      console.error(msg + " — refusing to start.");
      process.exit(1);
    }
    console.warn(msg + " — continuing because NODE_ENV is not production.");
  }
  if (!process.env.MAIL_FROM) {
    console.warn("[boot] MAIL_FROM is not set — order emails will fail loudly when attempted.");
  }
}

const app = express();

// So req.protocol / URLs are correct behind a reverse proxy (optional)
app.set("trust proxy", 1);

// Step 0: CORS — browsers on another port (or opening file://) can call this API. Set CORS_ORIGIN in production.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Never reflect arbitrary origins in production: if CORS_ORIGIN is unset there,
// fall back to the known storefront origins instead of `origin: true` (which
// would let any website script this payment API from a browser).
const PROD_FALLBACK_ORIGINS = ["https://www.visionkart.online", "https://visionkart.online"];
const isProduction = process.env.NODE_ENV === "production";
let corsOriginSetting;
if (corsOrigins.length > 0) {
  corsOriginSetting = corsOrigins;
} else if (isProduction) {
  console.warn(`[cors] CORS_ORIGIN not set — defaulting to ${PROD_FALLBACK_ORIGINS.join(", ")}`);
  corsOriginSetting = PROD_FALLBACK_ORIGINS;
} else {
  corsOriginSetting = true; // dev convenience only
}
app.use(
  cors({
    origin: corsOriginSetting,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Step 1: parse JSON bodies (React / RN clients)
app.use(express.json({ limit: "1mb" }));

// Step 2: parse URL-encoded bodies (CCAvenue server-to-server may POST encResp as form data)
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Step 3: mount payment APIs under /
app.use(paymentRoutes);
app.use(emailRoutes);

// Health check for uptime probes / Render.
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// Step 3b: test checkout page (same origin as API — avoids file:// fetch
// issues). Dev-only: the sample page has no place on the live payment API.
if (!isProduction) {
  app.use(express.static(path.join(__dirname, "sample")));
}

// Step 4: 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` });
});

// Step 5: centralized error handling
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`CCAvenue backend listening on http://localhost:${port}`);
  console.log(`Test checkout page: http://localhost:${port}/ccavenue-auto-submit.html`);
  
  // Start listening to the database for order confirmations to send emails
  startOrderListener();

  // Server-to-server safety net: periodically reconcile 'Awaiting Payment'
  // orders against CCAvenue's Order Status API, so a paid order whose browser
  // never completed the redirect still gets fulfilled.
  startPaymentReconciler();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Either stop the other process or run on a free port, e.g.:\n` +
        `  PORT=3001 npm start\n` +
        `On macOS you can see what holds the port: lsof -iTCP:${port} -sTCP:LISTEN`
    );
    process.exit(1);
  }
  throw err;
});
// Nudge to restart server and pick up new .env (CORS) changes
