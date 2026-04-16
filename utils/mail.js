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
  const { host, port, user, pass } = getSmtpSettings();
  if (!user || !pass) {
    return null;
  }
  const secure = port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    // Brevo / port 587: STARTTLS (requireTLS avoids plain-text auth before upgrade)
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
  });
}

function getDefaultFrom() {
  const address = process.env.MAIL_FROM;
  const name = process.env.MAIL_FROM_NAME;
  if (!address) return undefined;
  if (name) return `"${name.replace(/"/g, "")}" <${address}>`;
  return address;
}

/**
 * Send one email using env SMTP.
 * @param {{ to: string | string[], subject: string, text?: string, html?: string, replyTo?: string }} opts
 */
async function sendMail(opts) {
  const transport = createSmtpTransport();
  if (!transport) {
    const err = new Error(
      "Mail is not configured: set SMTP user + SMTP password in .env (see missingEnvVars in response)."
    );
    err.code = "MAIL_NOT_CONFIGURED";
    err.details = getSmtpSetupHints();
    throw err;
  }

  const from = getDefaultFrom();
  if (!from) {
    const err = new Error("MAIL_FROM is not set (use a verified sender in your provider)");
    err.code = "MAIL_FROM_MISSING";
    throw err;
  }

  const { to, subject, text, html, replyTo } = opts;
  if (!text && !html) {
    const err = new Error("Provide text and/or html body");
    err.code = "MAIL_BODY_MISSING";
    throw err;
  }

  return transport.sendMail({
    from,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    text,
    html,
    replyTo,
  });
}

/**
 * Generates a premium Order Confirmation email with a Download link
 */
function generateOrderConfirmationHTML(order) {
  const { items, billingAddress, amounts, id, invoiceUrl } = order;
  
  // Safe defaults
  const firstName = billingAddress?.fullName?.split(' ')[0] || "there";
  const totalAmount = amounts?.total || order.totalAmount || 0;
  const safeItems = items && Array.isArray(items) ? items : [];
  
  // Create a simple list of items
  const itemsText = safeItems.map(item => 
    `${item.productName || item.name || 'Product'} (x${item.quantity || 1})`
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
              <div style="font-weight: bold; font-size: 18px; margin-bottom: 15px;">#${id}</div>
              
              <div style="color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Items</div>
              <div style="margin-bottom: 15px;">${itemsText}</div>

              <div style="color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Total Paid</div>
              <div class="total">₹${totalAmount.toLocaleString()}</div>
            </div>

            <p style="margin-top: 30px;">Your tax invoice is ready for download.</p>
            <a href="${invoiceUrl || '#'}" class="btn">Download Tax Invoice (PDF)</a>
            
            <p style="font-size: 13px; color: #999; margin-top: 30px;">
              If the button doesn't work, copy this link into your browser:<br>
              <span style="color: #007bff; word-break: break-all;">${invoiceUrl || 'Link not available'}</span>
            </p>
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
