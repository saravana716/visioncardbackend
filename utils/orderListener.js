const { db } = require("./firebase");
const { sendMail, generateOrderConfirmationHTML } = require("./mail");

function startOrderListener() {
  console.log("[EmailListener] Starting Firestore order listener...");
  
  let isInitialLoad = true;

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
          // We only care if an order was just added (new order placed) or modified (status updated in Admin Panel)
          if (change.type === "added" || change.type === "modified") {
            const orderData = change.doc.data();
            const orderId = change.doc.id;
            
            // If the server just woke up (initial load), skip old historical orders (> 30 mins old)
            // to prevent spamming past customers, while still catching fresh orders that caused the wake-up.
            if (initialLoadFlag) {
               const orderTime = orderData.updatedAt?.toMillis?.() || orderData.createdAt?.toMillis?.() || 0;
               if (Date.now() - orderTime > 30 * 60 * 1000) {
                  return; // Skip old orders on initial load
               }
            }

            // Only send the email if it hasn't already been sent
            if (!orderData.confirmationEmailSent && orderData.billingAddress && orderData.billingAddress.email) {
              
              // Immediately flag it as sent to prevent duplicate triggers
              await db.collection("orders").doc(orderId).update({ confirmationEmailSent: true });
              
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

              try {
                await sendMail({
                  to: finalOrderData.billingAddress.email,
                  subject: `Order Confirmed - #${orderId} | Vision Kart`,
                  html: html
                });
                console.log(`[EmailListener] Success: Sent confirmation email to ${finalOrderData.billingAddress.email} for ${orderId}.`);
              } catch (err) {
                console.error(`[EmailListener] Failed to send email for ${orderId}:`, err.message);
                // Revert flag so it can be attempted again if manually triggered
                await db.collection("orders").doc(orderId).update({ confirmationEmailSent: false });
              }
            }
          }
        });
      },
      (error) => {
        console.error("[EmailListener] Firestore listener error:", error);
      }
    );
}

module.exports = { startOrderListener };
