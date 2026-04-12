const express = require("express");
const {
  createOrder,
  paymentResponse,
  paymentCancel,
} = require("../controllers/paymentController");

const router = express.Router();

// Step: route definitions only — logic lives in the controller layer
router.post("/create-order", createOrder);
router.post("/payment-response", paymentResponse);
router.get("/payment-cancel", paymentCancel);
router.post("/payment-cancel", paymentCancel);

module.exports = router;
