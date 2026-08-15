const { db } = require("./firebase");
const { sendMail, generateOrderConfirmationHTML } = require("./mail");

function startOrderListener() {
  console.log("[EmailListener] Starting Firestore order listener...");

  let isInitialLoad = true;

  // Orders whose send is in flight IN THIS PROCESS. The claim flag alone
  // can't prevent a concurrent duplicate: while a claimed send waits for the
  // invoice below, the browser's OrderSuccess step may flip
  // confirmationEmailSent back to false, which re-fires this listener and
  // would start a second, parallel send for the same order.
  const inFlight = new Set();

  // Listen for changes on all orders that have a Confirmed or Processing status
  db.collection("orders")
    .where("status", "in", ["Ordered", "Processing"])
    .onSnapshot(
      (snapshot) => {
        const initialLoadFlag = isInitialLoad;
        if (isInitialLoad) {
          isInitialLoad = false;
          console.log(`[EmailListener] Initial load. Actively checking for recently placed orders...`);
        }

        snapshot.docChanges().forEach(async (change) => {
          // The whole handler is guarded: it runs as a detached async callback,
          // so any rejection that escapes here is an unhandled promise rejection
          // and would crash the entire process on Node >= 15. A transient
          // Firestore/network error on one order must never take the service down.
          try {
            // We only care if an order was just added (new order placed) or modified (status updated in Admin Panel)
            if (change.type === "added" || change.type === "modified") {
              const orderData = change.doc.data();
              const orderId = change.doc.id;

              const MAX_EMAIL_ATTEMPTS = 3;
              const attemptsSoFar = Number(orderData.confirmationEmailAttempts) || 0;

              // Stale-claim recovery. A claim (confirmationEmailSent: true)
              // that never produced a confirmationEmailedAt stamp is a send
              // that died with the process (deploy/crash during the invoice
              // wait below) — without recovery that order's email is lost
              // forever. Revert the flag so this listener re-fires and the
              // next pass retries. Only claims stamped by this code
              // (confirmationEmailClaimedAt present) are recovered: historical
              // orders whose flag was set at checkout must never be re-mailed.
              // Deliberately BEFORE the initial-load age skip — a dead claim
              // is usually only discovered on a later boot, past that window.
              const STALE_CLAIM_MS = 5 * 60 * 1000; // > invoice wait (~55s) + mail timeout (20s)
              const claimedAtMs = orderData.confirmationEmailClaimedAt?.toMillis?.() || 0;
              if (
                orderData.confirmationEmailSent &&
                !orderData.confirmationEmailedAt &&
                claimedAtMs > 0 &&
                Date.now() - claimedAtMs > STALE_CLAIM_MS &&
                attemptsSoFar < MAX_EMAIL_ATTEMPTS &&
                !inFlight.has(orderId)
              ) {
                console.warn(
                  `[EmailListener] Recovering stale email claim for order ${orderId} (claimed ${Math.round((Date.now() - claimedAtMs) / 1000)}s ago, never sent).`
                );
                await db.collection("orders").doc(orderId).update({ confirmationEmailSent: false });
                return; // that update re-fires this listener; the next pass sends
              }

              // If the server just woke up (initial load), skip old historical orders (> 30 mins old)
              // to prevent spamming past customers, while still catching fresh orders that caused the wake-up.
              if (initialLoadFlag) {
                 const orderTime = orderData.updatedAt?.toMillis?.() || orderData.createdAt?.toMillis?.() || 0;
                 if (Date.now() - orderTime > 30 * 60 * 1000) {
                    return; // Skip old orders on initial load
                 }
              }

              // Send only if never actually emailed (confirmationEmailedAt is
              // the authoritative record, stamped after Brevo accepts the
              // mail), not currently claimed, not already sending in this
              // process, and under the attempt cap: reverting the flag on
              // failure re-fires this listener, so a persistent mail-provider
              // failure would otherwise loop forever hammering Brevo.
              if (
                !orderData.confirmationEmailSent &&
                !orderData.confirmationEmailedAt &&
                !inFlight.has(orderId) &&
                attemptsSoFar < MAX_EMAIL_ATTEMPTS &&
                orderData.billingAddress &&
                orderData.billingAddress.email
              ) {
                inFlight.add(orderId);
                try {

                  // Claim the send before the slow invoice wait so other
                  // snapshot changes don't start a duplicate. The claim is
                  // recoverable (see above) because confirmationEmailedAt is
                  // only stamped after the mail is actually accepted.
                  await db.collection("orders").doc(orderId).update({
                    confirmationEmailSent: true,
                    confirmationEmailAttempts: attemptsSoFar + 1,
                    confirmationEmailClaimedAt: new Date(),
                  });

                  console.log(`[EmailListener] Detected confirmation for order ${orderId}. Checking for invoice...`);

                  // Wait for invoice URL to be generated (max 12 attempts, 5 seconds each, total 60s)
                  const MAX_ATTEMPTS = 12;
                  const DELAY_MS = 5000;
                  let finalOrderData = { id: orderId, ...orderData };

                  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    if (finalOrderData.invoiceUrl) {
                      console.log(`[EmailListener] Found invoice link on attempt ${attempt}.`);
                      break;
                    }
                    if (attempt < MAX_ATTEMPTS) {
                      await new Promise(r => setTimeout(r, DELAY_MS));
                      const freshDoc = await db.collection("orders").doc(orderId).get();
                      if (freshDoc.exists) {
                        finalOrderData = { id: orderId, ...freshDoc.data() };
                      }
                    }
                  }

                  if (!finalOrderData.invoiceUrl) {
                    console.warn(`[EmailListener] WARNING: Proceeding without invoice link for ${orderId} after timeout.`);
                  }

                  const html = generateOrderConfirmationHTML(finalOrderData);

                  let mailSent = false;
                  try {
                    await sendMail({
                      to: finalOrderData.billingAddress.email,
                      subject: `Order Confirmed - #${orderId} | Vision Kart`,
                      html: html
                    });
                    mailSent = true;
                  } catch (err) {
                    console.error(`[EmailListener] Failed to send email for ${orderId} (attempt ${attemptsSoFar + 1}/${MAX_EMAIL_ATTEMPTS}):`, err.message);
                    // Revert the flag so the next change re-attempts, up to the cap.
                    await db.collection("orders").doc(orderId).update({ confirmationEmailSent: false });
                  }

                  if (mailSent) {
                    // Authoritative "actually sent" record — permanently blocks
                    // re-sends no matter how the boolean flag is flipped later
                    // (e.g. by the browser's OrderSuccess step). Stamped in its
                    // own retry loop, NOT in the send try/catch: the mail is
                    // already out, so a stamp failure must never revert the
                    // flag and trigger a duplicate send.
                    for (let stampTry = 1; stampTry <= 3; stampTry++) {
                      try {
                        await db.collection("orders").doc(orderId).update({ confirmationEmailedAt: new Date() });
                        break;
                      } catch (stampErr) {
                        console.error(`[EmailListener] Failed to stamp confirmationEmailedAt for ${orderId} (try ${stampTry}/3):`, stampErr.message);
                        if (stampTry === 3) {
                          console.error(`[EmailListener] CRITICAL: ${orderId} was emailed but the sent-stamp could not be written — stale-claim recovery may cause a duplicate email later.`);
                        } else {
                          await new Promise(r => setTimeout(r, 2000));
                        }
                      }
                    }
                    console.log(`[EmailListener] Success: Sent confirmation email to ${finalOrderData.billingAddress.email} for ${orderId}.`);
                  }

                } finally {
                  inFlight.delete(orderId);
                }
              }
            }
          } catch (err) {
            console.error(`[EmailListener] Error handling change for order ${change?.doc?.id || "unknown"}:`, err);
          }
        });
      },
      (error) => {
        console.error("[EmailListener] Firestore listener error:", error);
      }
    );
}

module.exports = { startOrderListener };
