require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const paymentRoutes = require("./routes/payment");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

// Step 0: CORS — browsers on another port (or opening file://) can call this API. Set CORS_ORIGIN in production.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
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

// Step 3b: test checkout page (same origin as API — avoids file:// fetch issues)
app.use(express.static(path.join(__dirname, "sample")));

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
