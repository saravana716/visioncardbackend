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
 * Decrement product stock for a paid order, one product per transaction so a
 * concurrent sale can't clobber the write. Floors at 0 and never throws — a
 * per-product failure is logged, not fatal to the payment flow. Quantities come
 * from the order's line items (defaulting to 1 for legacy items).
 */
async function decrementOrderStock(items) {
  for (const item of items || []) {
    if (!item || !item.productId) continue;
    const qty = Math.max(1, Number(item.quantity) || 1);
    const ref = db.collection("products").doc(item.productId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const current = Number(snap.data().stock) || 0;
        tx.update(ref, { stock: Math.max(0, current - qty) });
      });
    } catch (e) {
      console.error(`[stock] decrement failed for product ${item.productId}:`, e.message);
    }
  }
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
async function createOrder(req, res, next) {
  try {
    const errors = validateCreateOrderBody(req.body);
    if (errors.length) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const { merchantId, accessCode, workingKey, redirectUrl, cancelUrl } =
      getMerchantConfig();

    // Step C — the order MUST already exist in Firestore (the storefront writes
    // it as 'Awaiting Payment' before calling this). We key the payment to that
    // record so the amount is authoritative — never trusted from the client.
    const orderId = req.body.order_id;
    if (!orderId || String(orderId).trim() === "") {
      return res.status(400).json({ error: "Validation failed", details: ["order_id is required"] });
    }
    // The id is concatenated into the CCAvenue key=value request string, which
    // has no escaping — an id containing '&' or '=' would inject extra gateway
    // parameters. Real ids are VK-DDMMYY-NNN, so a strict charset costs nothing.
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(orderId))) {
      return res.status(400).json({ error: "Validation failed", details: ["order_id has an invalid format"] });
    }

    const orderSnap = await db.collection("orders").doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No such order to pay for." });
    }
    const orderData = orderSnap.data();

    // Only allow paying for an order that's actually awaiting payment — never
    // re-charge one that's already paid/fulfilled. 'Awaiting Verification' is
    // deliberately NOT payable: that status means money was already collected
    // (an amount-mismatch hold pending manual review), so accepting a fresh
    // payment for it would charge the customer twice.
    const PAYABLE = new Set(["Awaiting Payment", "Payment Failed"]);
    if (orderData.status && !PAYABLE.has(orderData.status)) {
      return res.status(409).json({ error: "ORDER_NOT_PAYABLE", message: `Order is '${orderData.status}', not awaiting payment.` });
    }

    // Step D — SERVER-AUTHORITATIVE amount from the stored order. The client's
    // req.body.amount is ignored: trusting it let a user tamper the total and
    // pay less than the order was worth.
    const serverAmount = Number(orderData?.amounts?.total);
    if (!Number.isFinite(serverAmount) || serverAmount <= 0) {
      return res.status(400).json({ error: "INVALID_ORDER_AMOUNT", message: "Order has no valid total to charge." });
    }
    const amountStr = serverAmount.toFixed(2);
    // Whitelist the currency: it is concatenated into the signed key=value
    // request string, so anything beyond a bare ISO code (e.g. "INR&amount=1")
    // could inject extra fields into what the gateway trusts.
    const currency = String(req.body.currency || 'INR').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ error: "INVALID_CURRENCY", message: "currency must be a 3-letter ISO code." });
    }

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

    // Note: never log `plainRequest` — it contains customer name/address/phone.
    console.log(`[create-order] order ${orderId}: charging ${currency} ${amountStr}`);

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
    const paidAmount = parsed.amount ?? null;
    const payment_mode = parsed.payment_mode ?? null;

    // Exact match — NOT includes("success"), because "Unsuccessful" contains
    // "success" as a substring and would be misread as a paid order.
    const isSuccess = String(order_status || "").trim().toLowerCase() === "success";
    const frontendBaseUrl = process.env.FRONTEND_URL || "https://www.visionkart.online";

    const paymentInfo = {
      gateway: "CCAvenue",
      trackingId: tracking_id,
      bankRefNo: parsed.bank_ref_no || null,
      paymentMode: payment_mode,
      cardName: parsed.card_name || null,
      statusMessage: parsed.status_message || null,
      paidAmount: paidAmount,
      updatedAt: new Date(),
    };

    if (!order_id) {
      return res.redirect(`${frontendBaseUrl}/order-failed?status=${order_status}`);
    }

    const orderRef = db.collection("orders").doc(order_id);

    try {
      // Every guard check and the terminal status write happen in ONE
      // transaction. The reconciler may be acting on this same order
      // concurrently (its status-API answer landing as this callback does),
      // and non-transactional read-then-write let the loser overwrite the
      // winner — worst case a just-paid order regressed to 'Payment Failed',
      // which is re-payable and so exposed the customer to a double charge.
      // Inside a transaction the second writer retries, re-reads the new
      // status, and backs off through the guards below.
      const outcome = await db.runTransaction(async (t) => {
        const snap = await t.get(orderRef);
        const orderData = snap.exists ? snap.data() : null;

        // No such order (forged/mistyped order_id in the callback, or a
        // replay for a deleted doc): nothing to write. Handled explicitly so
        // it doesn't surface as a thrown NOT_FOUND from t.update.
        if (!orderData) {
          return { kind: "missing" };
        }

        // Idempotency / progression guard for the SUCCESS branch — the mirror
        // of the non-success downgrade guard below. A replayed success
        // callback (browser back-button re-POST, CCAvenue re-notify) must not
        // rewrite an order that has already been paid or has moved on: only an
        // order still on its way to being paid may be fulfilled by a success
        // callback.
        const FULFILLABLE = new Set(["Awaiting Payment", "Payment Failed", "Awaiting Verification"]);
        if (isSuccess && orderData && orderData.status && !FULFILLABLE.has(orderData.status)) {
          return { kind: "already-done", status: orderData.status };
        }

        if (!isSuccess) {
          // A stale or replayed non-success callback (CCAvenue re-notifying an
          // old failed txn, or a browser back-button re-POST) must NEVER
          // downgrade an order that has already been paid. Only an order still
          // awaiting payment can transition to "Payment Failed".
          const DOWNGRADABLE = new Set(["Awaiting Payment", "Payment Failed"]);
          const currentStatus = orderData?.status;
          if (orderData && currentStatus && !DOWNGRADABLE.has(currentStatus)) {
            return { kind: "no-downgrade", status: currentStatus };
          }
          t.update(orderRef, { status: "Payment Failed", paymentInfo, updatedAt: new Date() });
          return { kind: "failed" };
        }

        // Verify the amount CCAvenue actually charged matches the stored order
        // total (defence-in-depth on top of the server-authoritative
        // create-order).
        const expected = Number(orderData?.amounts?.total);
        const paid = Number(paidAmount);
        const amountVerifiable = Number.isFinite(expected) && Number.isFinite(paid);
        const amountMismatch = amountVerifiable && Math.abs(paid - expected) > 1;

        if (!amountVerifiable) {
          // Can't confirm what was actually charged (missing stored total or
          // unparsable gateway amount). This is the last money check — hold
          // for manual review rather than fulfilling on trust.
          t.update(orderRef, {
            status: "Awaiting Verification",
            paymentInfo: { ...paymentInfo, amountUnverified: true },
            updatedAt: new Date(),
          });
          return { kind: "held-unverifiable", expected: orderData?.amounts?.total };
        }

        if (amountMismatch) {
          // Paid, but not the right amount — hold for manual review instead of
          // fulfilling. AWAITING_VERIFICATION keeps it out of the paid flow.
          t.update(orderRef, {
            status: "Awaiting Verification",
            paymentInfo: { ...paymentInfo, amountMismatch: true, expectedAmount: expected },
            updatedAt: new Date(),
          });
          return { kind: "held-mismatch", paid, expected };
        }

        // Confirmed paid at the correct amount — commit the terminal state.
        // confirmationEmailSent is re-armed HERE, server-side: checkout
        // creates the order with the flag true and previously only the
        // customer's browser (OrderSuccess invoice pipeline) flipped it, so a
        // closed tab meant a paid order whose confirmation email never sent.
        // stockDecremented is claimed atomically in the same write so
        // concurrent fulfillers can never decrement twice; the actual
        // decrement runs immediately after commit.
        const needStock = !!orderData && !orderData.stockDecremented;
        t.update(orderRef, {
          status: "Ordered",
          stockDecremented: true,
          confirmationEmailSent: false,
          paymentInfo,
          updatedAt: new Date(),
        });
        return { kind: "fulfilled", needStock, items: orderData?.items };
      });

      if (outcome.kind === "missing") {
        console.warn(`[payment] callback for unknown order '${order_id}' (status '${order_status}') — no order doc to update.`);
        // Same destinations the generic Firestore-error path uses: the pages
        // handle an unknown order id gracefully.
        const statusParam = isSuccess ? "success" : "failed";
        return res.redirect(`${frontendBaseUrl}/order-${statusParam}?order_id=${order_id}&status=${order_status}`);
      }
      if (outcome.kind === "already-done") {
        console.warn(
          `[payment] ignoring duplicate success callback for ${order_id}: already '${outcome.status}', not rewriting.`
        );
        return res.redirect(`${frontendBaseUrl}/order-success?order_id=${order_id}&status=${order_status}`);
      }
      if (outcome.kind === "no-downgrade") {
        console.warn(
          `[payment] ignoring '${order_status}' callback for ${order_id}: already '${outcome.status}', not downgrading.`
        );
        // Order is already paid / further along — send the customer to the
        // success view rather than a misleading failure page.
        return res.redirect(`${frontendBaseUrl}/order-success?order_id=${order_id}&status=${order_status}`);
      }
      if (outcome.kind === "failed") {
        return res.redirect(`${frontendBaseUrl}/order-failed?order_id=${order_id}&status=${order_status}`);
      }
      if (outcome.kind === "held-unverifiable") {
        console.warn(`[payment] amount unverifiable on ${order_id}: paid=${paidAmount} expected=${outcome.expected}`);
        return res.redirect(`${frontendBaseUrl}/order-success?order_id=${order_id}&status=${order_status}`);
      }
      if (outcome.kind === "held-mismatch") {
        console.warn(`[payment] amount mismatch on ${order_id}: paid ${outcome.paid} vs expected ${outcome.expected}`);
        return res.redirect(`${frontendBaseUrl}/order-success?order_id=${order_id}&status=${order_status}`);
      }

      // kind === "fulfilled" — decrement stock exactly once (the claim was
      // committed in the transaction). The customer HAS paid: a decrement
      // failure is logged loudly for manual inventory correction, never
      // surfaced to the customer as an error page.
      if (outcome.needStock) {
        try {
          await decrementOrderStock(outcome.items);
        } catch (stockErr) {
          console.error(
            `[payment] STOCK DECREMENT FAILED for paid order ${order_id} — adjust inventory manually:`,
            stockErr.message
          );
        }
      }

      // Confirmation email is sent by utils/orderListener.js on the status → Ordered change.
      return res.redirect(`${frontendBaseUrl}/order-success?order_id=${order_id}&status=${order_status}`);
    } catch (fsError) {
      console.error("Firestore sync error in paymentResponse:", fsError.message);
      // Still redirect the user; the S2S/listener path can reconcile.
      const statusParam = isSuccess ? "success" : "failed";
      return res.redirect(`${frontendBaseUrl}/order-${statusParam}?order_id=${order_id}&status=${order_status}`);
    }
  } catch (e) {
    return next(e);
  }
}

/**
 * GET/POST /payment-cancel — user aborted checkout at CCAvenue; `cancel_url` in the request points here.
 * Redirect to the frontend failure page.
 */
function paymentCancel(req, res) {
  // Same production default as paymentResponse — a missing FRONTEND_URL must
  // never strand a live customer on a localhost redirect.
  const frontendBaseUrl = process.env.FRONTEND_URL || "https://www.visionkart.online";
  return res.redirect(`${frontendBaseUrl}/order-failed?status=Cancelled`);
}

module.exports = {
  createOrder,
  paymentResponse,
  paymentCancel,
  // Shared with utils/paymentReconciler.js so server-to-server reconciliation
  // decrements stock with exactly the same transactional logic as the callback.
  decrementOrderStock,
};
