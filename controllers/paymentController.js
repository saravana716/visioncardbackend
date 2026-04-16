const crypto = require("crypto");
const {
  encrypt,
  decrypt,
  parseKeyValueString,
  buildRequestString,
} = require("../utils/ccavenue");
const { db } = require("../utils/firebase");

/** Live non-seamless POST URL. Sandbox merchants must use test host (see CCAVENUE_INIT_URL in .env). */
const CCAVENUE_INIT_URL_LIVE =
  "https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction";
const CCAVENUE_INIT_URL_TEST =
  "https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction";

function getCcavenueInitUrl() {
  if (process.env.CCAVENUE_INIT_URL && String(process.env.CCAVENUE_INIT_URL).trim()) {
    return String(process.env.CCAVENUE_INIT_URL).trim();
  }
  const mode = String(process.env.CCAVENUE_MODE || "live").toLowerCase();
  return mode === "test" || mode === "sandbox" ? CCAVENUE_INIT_URL_TEST : CCAVENUE_INIT_URL_LIVE;
}

/**
 * Read required env vars once per request path so misconfiguration returns a clear error.
 */
function getMerchantConfig() {
  const mode = String(process.env.CCAVENUE_MODE || "live").toLowerCase();
  const isTest = mode === "test" || mode === "sandbox";

  // Dynamically select credentials based on mode
  const merchantId = isTest 
    ? (process.env.TEST_MERCHANT_ID || process.env.MERCHANT_ID) 
    : (process.env.LIVE_MERCHANT_ID || process.env.MERCHANT_ID);
    
  const accessCode = isTest 
    ? (process.env.TEST_ACCESS_CODE || process.env.ACCESS_CODE) 
    : (process.env.LIVE_ACCESS_CODE || process.env.ACCESS_CODE);
    
  const workingKey = isTest 
    ? (process.env.TEST_WORKING_KEY || process.env.WORKING_KEY) 
    : (process.env.LIVE_WORKING_KEY || process.env.WORKING_KEY);

  const redirectUrl = process.env.REDIRECT_URL;
  const cancelUrl = process.env.CANCEL_URL;

  const missing = [];
  if (!merchantId) missing.push(isTest ? "TEST_MERCHANT_ID" : "LIVE_MERCHANT_ID");
  if (!accessCode) missing.push(isTest ? "TEST_ACCESS_CODE" : "LIVE_ACCESS_CODE");
  if (!workingKey) missing.push(isTest ? "TEST_WORKING_KEY" : "LIVE_WORKING_KEY");
  if (!redirectUrl) missing.push("REDIRECT_URL");
  if (!cancelUrl) missing.push("CANCEL_URL");

  if (missing.length) {
    const err = new Error(`Missing environment variables for ${mode} mode: ${missing.join(", ")}`);
    err.statusCode = 500;
    err.code = "CONFIG_ERROR";
    throw err;
  }

  return { merchantId, accessCode, workingKey, redirectUrl, cancelUrl };
}

/**
 * CCAvenue is extremely sensitive to special characters in address and name fields.
 * This helper strips everything except alphanumeric characters and spaces.
 */
function sanitize(val) {
  if (!val) return "";
  // Keep only alphanumeric and spaces
  return String(val).replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s\s+/g, " ").trim();
}

/**
 * Basic validation for create-order payload (keep messages safe for API clients).
 */
function validateCreateOrderBody(body) {
  const errors = [];
  const { amount, currency, customer_name, email, phone } = body || {};

  if (amount === undefined || amount === null || String(amount).trim() === "") {
    errors.push("amount is required");
  } else if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    errors.push("amount must be a positive number");
  }

  if (!currency || String(currency).trim() === "") {
    errors.push("currency is required");
  }

  if (!customer_name || String(customer_name).trim() === "") {
    errors.push("customer_name is required");
  }

  if (!email || String(email).trim() === "") {
    errors.push("email is required");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    errors.push("email must be valid");
  }

  if (!phone || String(phone).trim() === "") {
    errors.push("phone is required");
  }

  return errors;
}

/**
 * CCAvenue often validates full billing/delivery blocks. Merge client fields with safe defaults
 * (digital / quick-checkout). Override any key via `overrides` from the API body.
 */
function buildBillingDelivery(overrides, billingName, billingEmail, billingTel) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const name = sanitize(billingName || "").slice(0, 60);
  const email = String(billingEmail || "").trim().slice(0, 70);
  const tel = String(billingTel || "").replace(/\D/g, "").slice(0, 20) || "9999999999";

  const billing_address = sanitize(o.billing_address ?? "Not provided").slice(0, 150);
  const billing_city = sanitize(o.billing_city ?? "Not provided").slice(0, 30);
  const billing_state = sanitize(o.billing_state ?? "Not provided").slice(0, 30);
  const billing_zip = String(o.billing_zip ?? "000000").replace(/\D/g, "").slice(0, 15);
  const billing_country = sanitize(o.billing_country ?? "India").slice(0, 50);

  const delivery_name = sanitize(o.delivery_name ?? name).slice(0, 60);
  const delivery_address = sanitize(o.delivery_address ?? billing_address).slice(0, 150);
  const delivery_city = sanitize(o.delivery_city ?? billing_city).slice(0, 30);
  const delivery_state = sanitize(o.delivery_state ?? billing_state).slice(0, 30);
  const delivery_zip = String(o.delivery_zip ?? billing_zip).replace(/\D/g, "").slice(0, 15);
  const delivery_country = sanitize(o.delivery_country ?? billing_country).slice(0, 50);
  const delivery_tel = String(o.delivery_tel ?? tel).replace(/\D/g, "").slice(0, 22);

  return {
    billing_name: name,
    billing_email: email,
    billing_tel: tel,
    billing_address,
    billing_city,
    billing_state,
    billing_zip,
    billing_country,
    delivery_name,
    delivery_address,
    delivery_city,
    delivery_state,
    delivery_zip,
    delivery_country,
    delivery_tel,
  };
}

/**
 * POST /create-order
 *
 * Step A — Validate the JSON body so we never build a broken request string.
 * Step B — Read merchant credentials from the environment (never from the client).
 * Step C — Generate a unique `order_id` that your own DB can mirror later.
 * Step D — Normalize `amount`/`currency` to the formats CCAvenue expects.
 * Step E — Concatenate all gateway fields as `key=value&key=value` (strict CCAvenue format).
 * Step F — Encrypt the entire string with AES-128-CBC using the working key.
 * Step G — Respond with `encRequest` + `access_code` + gateway URL for the browser form POST.
 */
function createOrder(req, res, next) {
  try {
    const errors = validateCreateOrderBody(req.body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const { merchantId, accessCode, workingKey, redirectUrl, cancelUrl } =
      getMerchantConfig();

    // Step C — Use Firestore order ID from client, or fallback to generation
    const orderId = req.body.order_id || `VK_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

    // Step D — amount must be a decimal string; currency is uppercased (e.g. INR)
    const amountStr = Number(req.body.amount).toFixed(2);
    const currency = (req.body.currency || 'INR').trim().toUpperCase();

    // Step E — merchant fields + full billing/delivery (many accounts reject missing address fields)
    const addr = buildBillingDelivery(
      req.body.address,
      req.body.customer_name,
      req.body.email,
      req.body.phone
    );

    const requestFields = {
      merchant_id: merchantId,
      order_id: orderId,
      currency,
      amount: amountStr,
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
      language: "EN",
      ...addr,
    };

    const plainRequest = buildRequestString(requestFields);

    console.log("---------------------------------------");
    console.log("DEBUG: Plain CCAvenue Request String:");
    console.log(plainRequest);
    console.log("---------------------------------------");

    // Step F — encrypt before any data leaves your server toward CCAvenue
    const encRequest = encrypt(plainRequest, workingKey);

    // Step G — client builds an auto-submit HTML form posting `access_code` + `encRequest` to `ccavenue_url`
    return res.status(201).json({
      encRequest,
      access_code: accessCode,
      merchant_id: merchantId,
      ccavenue_url: getCcavenueInitUrl(),
    });
  } catch (e) {
    return next(e);
  }
}

/**
 * POST /payment-response
 *
 * Step A — Accept `encResp` from JSON or standard form POST (CCAvenue uses `encResp`).
 * Step B — Decrypt using the same AES scheme as `encrypt`.
 * Step C — Split the decrypted `k=v&k=v` string into a map.
 * Step D — Return only the fields your React / RN UI needs for receipts and navigation.
 */
async function paymentResponse(req, res, next) {
  try {
    const { workingKey } = getMerchantConfig();

    // Step A — support both JSON APIs and `application/x-www-form-urlencoded` callbacks
    const encResp =
      req.body?.encResp ??
      req.body?.encresp ??
      (typeof req.body === "string" ? req.body : undefined);

    if (!encResp || typeof encResp !== "string" || encResp.trim() === "") {
      return res.status(400).json({
        error: "Missing encResp",
        message: "Provide encResp in JSON body or as form field encResp",
      });
    }

    let decrypted;
    try {
      // Step B — `encResp` is hex-encoded ciphertext from CCAvenue
      decrypted = decrypt(encResp.trim(), workingKey);
    } catch {
      const err = new Error("Failed to decrypt encResp — invalid payload or working key");
      err.statusCode = 400;
      err.code = "DECRYPT_ERROR";
      throw err;
    }

    // Step C — decrypted payload is still plain text in CCAvenue's wire format
    const parsed = parseKeyValueString(decrypted);

    const order_id = parsed.order_id ?? null;
    const order_status = parsed.order_status ?? null;
    const tracking_id = parsed.tracking_id ?? null;
    const amount = parsed.amount ?? null;
    const payment_mode = parsed.payment_mode ?? null;

    // Step D — Determine final status for tracking
    const isSuccess = order_status?.toLowerCase().includes("success");
    const statusParam = isSuccess ? "success" : "failed";
    const finalFirestoreStatus = isSuccess ? "Ordered" : "Payment Failed";

    // Step E — Update Firestore synchronously before redirecting the user
    if (order_id) {
      try {
        console.log(`Updating Firestore Order ${order_id} to ${finalFirestoreStatus}...`);
        await db.collection("orders").doc(order_id).update({
          status: finalFirestoreStatus,
          paymentInfo: {
            gateway: "CCAvenue",
            trackingId: tracking_id,
            bankRefNo: parsed.bank_ref_no || null,
            paymentMode: payment_mode,
            cardName: parsed.card_name || null,
            statusMessage: parsed.status_message || null,
            updatedAt: new Date(),
          },
        });
        console.log("Firestore update complete.");
      } catch (fsError) {
        console.error("Firestore sync error in paymentResponse:", fsError.message);
        // We continue to redirect even if Firestore update fails locally (S2S handles this differently)
      }
    }

    // Step F — Redirect back to the React frontend with the result
    const frontendBaseUrl = process.env.FRONTEND_URL || "https://www.visionkart.online";
    
    return res.redirect(`${frontendBaseUrl}/order-${statusParam}?order_id=${order_id}&status=${order_status}`);
  } catch (e) {
    return next(e);
  }
}

/**
 * GET/POST /payment-cancel — user aborted checkout at CCAvenue; `cancel_url` in the request points here.
 * Redirect to the frontend failure page.
 */
function paymentCancel(req, res) {
  const frontendBaseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  return res.redirect(`${frontendBaseUrl}/order-failed?status=Cancelled`);
}

module.exports = {
  createOrder,
  paymentResponse,
  paymentCancel,
};
