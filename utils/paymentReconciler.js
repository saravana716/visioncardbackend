/**
 * Payment reconciler — closes the "paid but browser never came back" gap.
 *
 * Order fulfillment normally rides on the customer's browser completing the
 * CCAvenue redirect to /payment-response. If the tab is closed (or the network
 * drops) after paying, the money is captured but the order sits in
 * 'Awaiting Payment' forever: no stock decrement, no confirmation email.
 *
 * This job periodically finds stuck 'Awaiting Payment' orders and asks
 * CCAvenue's Order Status API (server-to-server) what actually happened:
 *   - paid    -> fulfil exactly like a success callback (amount verify, stock
 *                decrement, status -> Ordered) and re-arm the confirmation
 *                email; idempotent with /payment-response.
 *   - failed  -> mark 'Payment Failed' (only from 'Awaiting Payment').
 *   - pending/unknown/no transaction -> leave untouched for the next sweep.
 *
 * Every step is guarded: one bad order or one API hiccup only skips that
 * order, and the whole run is wrapped so the interval can never crash the
 * process or overlap itself.
 */

const { db } = require("./firebase");
const { fetchCcavenueOrderStatus, hasStatusApiCreds } = require("./ccavenueStatus");
const { decrementOrderStock } = require("../controllers/paymentController");

// CCAvenue order_status values (lowercased). "shipped" is CCAvenue's own
// post-capture fulfilment state — still money-in-hand for us.
const PAID_STATUSES = new Set(["successful", "shipped", "success"]);
const FAILED_STATUSES = new Set([
  "aborted",
  "unsuccessful",
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "auto-cancelled",
  "auto cancelled",
  "auto-canceled",
  "timeout",
  "fraud",
]);
// Anything else ("awaited", "initiated", "invalid", ...) means no final
// outcome yet (or no transaction at all) — leave the order for a later sweep.

const MIN_AGE_MS = 10 * 60 * 1000; // give the normal browser redirect time to land
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // stop polling CCAvenue about ancient orders
const BATCH_LIMIT = 25; // bound status-API calls per sweep

function orderCreatedAtMs(orderData) {
  const v = orderData?.createdAt;
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function reconcileOrder(orderId) {
  const check = await fetchCcavenueOrderStatus(orderId);
  if (!check.ok) {
    console.warn(`[reconciler] ${orderId}: ${check.error}`);
    return;
  }

  const orderRef = db.collection("orders").doc(orderId);

  // Guard-and-write inside ONE transaction: the browser callback may land
  // while the status API call is in flight. A plain re-read narrowed but did
  // not close that race — the callback could commit 'Ordered' between our
  // read and write, and a stale 'aborted' from the status API would then
  // overwrite a PAID order with 'Payment Failed' (re-payable → double-charge
  // exposure), or both writers could decrement stock. In a transaction the
  // second writer retries, sees the order is no longer 'Awaiting Payment',
  // and backs off.
  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists) return { kind: "missing" };
    const orderData = snap.data();
    if (orderData.status !== "Awaiting Payment") return { kind: "skip" };

    const paymentInfo = {
      gateway: "CCAvenue",
      reconciled: true,
      statusApiStatus: check.status,
      paidAmount: check.amount,
      updatedAt: new Date(),
    };

    if (PAID_STATUSES.has(check.status)) {
      // Same amount defence as /payment-response: this is the last money
      // check, so an amount that can't be verified (status API returned no
      // amount, or the stored total is missing/invalid) is held for manual
      // review exactly like a mismatch — never fulfilled on trust.
      const expected = Number(orderData?.amounts?.total);
      const amountVerifiable = Number.isFinite(expected) && check.amount != null;
      if (!amountVerifiable) {
        t.update(orderRef, {
          status: "Awaiting Verification",
          paymentInfo: { ...paymentInfo, amountUnverified: true },
          updatedAt: new Date(),
        });
        return { kind: "held-unverifiable", expected: orderData?.amounts?.total };
      }
      if (Math.abs(check.amount - expected) > 1) {
        t.update(orderRef, {
          status: "Awaiting Verification",
          paymentInfo: { ...paymentInfo, amountMismatch: true, expectedAmount: expected },
          updatedAt: new Date(),
        });
        return { kind: "held", expected };
      }

      // confirmationEmailSent is set true at checkout and re-armed on
      // fulfilment so the email listener sends the confirmation (it tolerates
      // a missing invoice link). stockDecremented is claimed atomically here;
      // the actual decrement runs right after commit, so two concurrent
      // fulfillers can never both decrement.
      const needStock = !orderData.stockDecremented;
      t.update(orderRef, {
        status: "Ordered",
        stockDecremented: true,
        confirmationEmailSent: false,
        paymentInfo,
        updatedAt: new Date(),
      });
      return { kind: "fulfilled", needStock, items: orderData.items };
    }

    if (FAILED_STATUSES.has(check.status)) {
      t.update(orderRef, { status: "Payment Failed", paymentInfo, updatedAt: new Date() });
      return { kind: "failed" };
    }

    // Pending / unknown / no transaction — nothing to do yet.
    return { kind: "pending" };
  });

  if (outcome.kind === "held-unverifiable") {
    console.warn(
      `[reconciler] ${orderId}: paid but amount unverifiable (api=${check.amount} expected=${outcome.expected}) — holding as Awaiting Verification`
    );
    return;
  }
  if (outcome.kind === "held") {
    console.warn(
      `[reconciler] ${orderId}: paid ${check.amount} vs expected ${outcome.expected} — holding as Awaiting Verification`
    );
    return;
  }
  if (outcome.kind === "fulfilled") {
    if (outcome.needStock) {
      try {
        await decrementOrderStock(outcome.items);
      } catch (stockErr) {
        console.error(
          `[reconciler] STOCK DECREMENT FAILED for paid order ${orderId} — adjust inventory manually:`,
          stockErr.message
        );
      }
    }
    console.log(`[reconciler] ${orderId}: confirmed paid via status API — marked Ordered.`);
    return;
  }
  if (outcome.kind === "failed") {
    console.log(`[reconciler] ${orderId}: status '${check.status}' — marked Payment Failed.`);
  }
}

let sweepInFlight = false;

async function reconcileOnce() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    // Equality-only query (no orderBy) so no composite index is required;
    // the age window is applied in code.
    const snap = await db
      .collection("orders")
      .where("status", "==", "Awaiting Payment")
      .limit(200)
      .get();

    const now = Date.now();
    const due = [];
    snap.forEach((doc) => {
      const age = now - orderCreatedAtMs(doc.data());
      if (age >= MIN_AGE_MS && age <= MAX_AGE_MS) due.push(doc.id);
    });

    if (!due.length) return;
    const batch = due.slice(0, BATCH_LIMIT);
    console.log(`[reconciler] checking ${batch.length}/${due.length} stuck order(s) with CCAvenue...`);
    for (const orderId of batch) {
      try {
        await reconcileOrder(orderId);
      } catch (e) {
        console.error(`[reconciler] error reconciling ${orderId}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[reconciler] sweep failed:", e.message);
  } finally {
    sweepInFlight = false;
  }
}

function startPaymentReconciler() {
  if (String(process.env.RECONCILE_DISABLED || "").toLowerCase() === "true") {
    console.log("[reconciler] disabled via RECONCILE_DISABLED.");
    return;
  }
  if (!hasStatusApiCreds()) {
    console.warn("[reconciler] CCAvenue credentials not configured — reconciler not started.");
    return;
  }
  const intervalMs = Math.max(60 * 1000, Number(process.env.RECONCILE_INTERVAL_MS) || 5 * 60 * 1000);
  console.log(`[reconciler] started — sweeping every ${Math.round(intervalMs / 1000)}s.`);
  // First sweep shortly after boot (catches orders stranded during downtime),
  // then on the interval. unref() so the timer never holds the process open.
  const first = setTimeout(() => reconcileOnce(), 30 * 1000);
  const timer = setInterval(() => reconcileOnce(), intervalMs);
  if (typeof first.unref === "function") first.unref();
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = { startPaymentReconciler, reconcileOnce };
