const nodemailer = require("nodemailer");

/**
 * SMTP settings from environment — generic names first, then Brevo-style aliases.
 * Change host/port/user/pass in `.env` only; no code edits needed to switch providers.
 */
function getSmtpSettings() {
  const host =
    process.env.SMTP_HOST ||
    process.env.BREVO_SMTP_HOST ||
    "smtp-relay.brevo.com";
  const port = Number(
    process.env.SMTP_PORT || process.env.BREVO_SMTP_PORT || 587
  );
  const user = String(
    process.env.SMTP_USER ||
      process.env.BREVO_SMTP_USER ||
      ""
  ).trim();
  const pass = String(
    process.env.SMTP_PASS ||
      process.env.SMTP_PASSWORD ||
      process.env.BREVO_SMTP_PASS ||
      ""
  ).trim();

  return { host, port, user, pass };
}

function maskUser(u) {
  if (!u || u.length < 4) return u ? "***" : "";
  const at = u.indexOf("@");
  if (at === -1) return `${u.slice(0, 2)}***`;
  return `${u.slice(0, 2)}***@${u.slice(at + 1)}`;
}

function isSmtpFullyConfigured() {
  const { user, pass } = getSmtpSettings();
  return Boolean(user && pass);
}

/** Which env vars are still empty (for API errors — no secret values). */
function getSmtpSetupHints() {
  const { user, pass } = getSmtpSettings();
  const missing = [];
  if (!user) missing.push("SMTP_USER or BREVO_SMTP_USER");
  if (!pass) missing.push("SMTP_PASS or BREVO_SMTP_PASS");
  if (!process.env.MAIL_FROM) missing.push("MAIL_FROM");
  return {
    missingEnvVars: missing,
    howToFix:
      "In Brevo: https://app.brevo.com → SMTP & API → SMTP. Copy the SMTP key into BREVO_SMTP_PASS (or SMTP_PASS) in .env. Restart the server. That key is not the same as your Brevo website password.",
  };
}

/** Safe snapshot for GET /email/smtp (never includes password). */
function getSmtpPublicSummary() {
  const { host, port, user } = getSmtpSettings();
  const from = process.env.MAIL_FROM || "";
  return {
    host,
    port,
    userHint: maskUser(user),
    mailFromHint: maskUser(from),
    configured: isSmtpFullyConfigured(),
    mailFromSet: Boolean(from),
  };
}

function createSmtpTransport() {
  // We no longer use nodemailer because Render blocks all SMTP ports (25, 465, 587).
  // We strictly use the Brevo HTTP REST API via fetch.
  return null;
}

function getDefaultFrom() {
  const address = process.env.MAIL_FROM;
  const name = process.env.MAIL_FROM_NAME;
  if (!address) return undefined;
  if (name) return `"${name.replace(/"/g, "")}" <${address}>`;
  return address;
}

/**
 * Send one email using Brevo HTTP API to bypass Render firewall.
 * @param {{ to: string | string[], subject: string, text?: string, html?: string, replyTo?: string }} opts
 */
async function sendMail(opts) {
  const { pass } = getSmtpSettings();
  if (!pass || !pass.startsWith("xkeysib-")) {
    const err = new Error(
      "Mail is not configured: set a valid Brevo API key (starts with xkeysib-) in SMTP_PASS in .env"
    );
    err.code = "MAIL_NOT_CONFIGURED";
    err.details = getSmtpSetupHints();
    throw err;
  }

  // No silent fallback sender: Brevo rejects mail from an unverified address,
  // so a missing MAIL_FROM must fail loudly (the API maps this to 503 and the
  // order listener's retry keeps the email pending) instead of every send
  // dying against an unverified gmail address.
  const from = getDefaultFrom();
  if (!from) {
    const err = new Error("Mail is not configured: set MAIL_FROM to a Brevo-verified sender address");
    err.code = "MAIL_FROM_MISSING";
    err.details = getSmtpSetupHints();
    throw err;
  }
  const { to, subject, text, html, replyTo } = opts;

  if (!text && !html) {
    const err = new Error("Provide text and/or html body");
    err.code = "MAIL_BODY_MISSING";
    throw err;
  }

  // Parse "Name <email>" format if present
  let senderName = "VisionKart";
  let senderEmail = from;
  if (from.includes("<")) {
    const match = from.match(/"?([^"]*)"?\s*<([^>]+)>/);
    if (match) {
      senderName = match[1].trim();
      senderEmail = match[2].trim();
    }
  }

  const toArray = Array.isArray(to) ? to : to.split(",").map(e => e.trim());
  const toObjects = toArray.map(email => ({ email }));

  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: toObjects,
    subject: subject,
  };
  
  if (html) payload.htmlContent = html;
  if (text) payload.textContent = text;
  if (replyTo) payload.replyTo = { email: replyTo };

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": pass,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
    // A hung Brevo call must not stall the order listener indefinitely.
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("[Brevo API Error]", errText);
    throw new Error(`Brevo API Error: ${response.status} ${response.statusText} - ${errText}`);
  }

  return response.json();
}

/**
 * Generates a premium Order Confirmation email with a Download link
 */
// Order data (names, product titles) is customer/admin input — escape it
// before interpolating into email HTML so a crafted value can't inject markup.
function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateOrderConfirmationHTML(order) {
  const { items, billingAddress, amounts, id, invoiceUrl } = order;
  
  // Safe defaults
  const firstName = escapeHtml(billingAddress?.fullName?.split(' ')[0] || "there");
  // Numeric on purpose: toLocaleString() formats numbers (1,234) but returns
  // strings unchanged, and a number needs no HTML escaping.
  const totalAmount = Number(amounts?.total || order.totalAmount || 0);
  const safeItems = items && Array.isArray(items) ? items : [];
  const safeInvoiceUrl = /^https:\/\//.test(String(invoiceUrl || "")) ? escapeHtml(invoiceUrl) : "";
  
  // Create a simple list of items
  const itemsText = safeItems.map(item => 
    escapeHtml(`${item.productName || item.name || 'Product'} (x${item.quantity || 1})`)
  ).join(', ');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f7; }
        .wrapper { width: 100%; padding: 20px 0; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .header { background: #1a1a1a; color: #ffffff; padding: 40px 20px; text-align: center; }
        .content { padding: 40px; text-align: center; }
        .order-box { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 25px 0; text-align: left; }
        .btn { display: inline-block; padding: 16px 32px; background-color: #007bff; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; transition: background 0.3s; }
        .footer { padding: 20px; text-align: center; font-size: 13px; color: #888; }
        .total { font-size: 24px; font-weight: bold; color: #1a1a1a; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 28px; letter-spacing: 1px;">VISION KART</h1>
          </div>
          <div class="content">
            <h2 style="margin: 0 0 10px;">Order Confirmed!</h2>
            <p style="font-size: 16px; color: #555;">Hi ${firstName}, your order has been received and is being processed. Thank you for shopping with us!</p>
            
            <div class="order-box">
              <div style="color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Order ID</div>
              <div style="font-weight: bold; font-size: 18px; margin-bottom: 15px;">#${escapeHtml(id)}</div>
              
              <div style="color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Items</div>
              <div style="margin-bottom: 15px;">${itemsText}</div>

              <div style="color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Total Paid</div>
              <div class="total">₹${totalAmount.toLocaleString()}</div>
            </div>

            ${safeInvoiceUrl ? `
            <p style="margin-top: 30px;">Your tax invoice is ready for download.</p>
            <a href="${safeInvoiceUrl}" class="btn">Download Tax Invoice (PDF)</a>
            
            <p style="font-size: 13px; color: #999; margin-top: 30px;">
              If the button doesn't work, copy this link into your browser:<br>
              <span style="color: #007bff; word-break: break-all;">${safeInvoiceUrl}</span>
            </p>` : `
            <p style="margin-top: 30px;">Your tax invoice will be available from the My Orders page shortly.</p>`}
          </div>
          <div class="footer">
            <p>Questions? Contact us at visionkart.onlinestore@gmail.com</p>
            <p>&copy; ${new Date().getFullYear()} Vision Kart. All rights reserved.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = {
  getSmtpSettings,
  getSmtpPublicSummary,
  getSmtpSetupHints,
  isSmtpFullyConfigured,
  createSmtpTransport,
  sendMail,
  getDefaultFrom,
  generateOrderConfirmationHTML
};
