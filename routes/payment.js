const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  createOrder,
  paymentResponse,
  paymentCancel,
} = require("../controllers/paymentController");

const router = express.Router();

// Both endpoints are unauthenticated and do Firestore reads, so cap per-IP
// bursts (enumeration / quota burn). Limits are generous for real shoppers —
// nobody legitimately starts 30 checkouts in 15 minutes — and the gateway's
// server-to-server callbacks come from a small IP set well under the cap.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a few minutes and try again." },
});

// Step: route definitions only — logic lives in the controller layer
router.post("/create-order", paymentLimiter, createOrder);
router.post("/payment-response", paymentLimiter, paymentResponse);
router.get("/payment-cancel", paymentCancel);
router.post("/payment-cancel", paymentCancel);

module.exports = router;
