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
 * Generates a professional HTML invoice layout for Vision Kart
 */
function generateInvoiceHTML(order) {
  const { items, billingAddress, shippingAddress, amounts, id, createdAt } = order;
  const dateStr = createdAt ? new Date(createdAt.seconds * 1000).toLocaleDateString() : new Date().toLocaleDateString();

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #eee;">
        <div style="font-weight: bold; color: #333;">${item.name} ${item.brand || ''}</div>
        <div style="font-size: 12px; color: #666;">${item.category || ''}</div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity || 1}</td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">₹${item.price.toLocaleString()}</td>
      <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">₹${((item.price) * (item.quantity || 1)).toLocaleString()}</td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
        .header { background: #1a1a1a; color: #ffffff; padding: 30px; text-align: center; }
        .content { padding: 30px; }
        .table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .table th { background: #f8f8f8; padding: 12px; text-align: left; font-size: 14px; text-transform: uppercase; }
        .totals { margin-left: auto; width: 250px; }
        .total-row { display: flex; justify-content: space-between; padding: 8px 0; }
        .grand-total { border-top: 2px solid #1a1a1a; margin-top: 10px; padding-top: 10px; font-weight: bold; font-size: 18px; }
        .footer { background: #f9f9f9; padding: 20px; text-align: center; font-size: 12px; color: #888; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; background: #e8f5e9; color: #2e7d32; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; letter-spacing: 2px;">VISION KART</h1>
          <p style="margin: 5px 0 0; opacity: 0.8;">Tax Invoice / Purchase Receipt</p>
        </div>
        <div class="content">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
            <div>
              <div style="font-size: 14px; color: #888;">Order ID</div>
              <div style="font-weight: bold; font-size: 16px;">#${id}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 14px; color: #888;">Date</div>
              <div style="font-weight: bold;">${dateStr}</div>
              <div class="badge">PAID</div>
            </div>
          </div>
          <div style="display: flex; gap: 40px; margin-bottom: 30px;">
            <div style="flex: 1;">
              <h4 style="margin: 0 0 10px; color: #888; font-size: 12px; text-transform: uppercase;">Billed To</h4>
              <div style="font-weight: bold;">${billingAddress.fullName}</div>
              <div>${billingAddress.address}</div>
              <div>${billingAddress.city}, ${billingAddress.state} - ${billingAddress.zip}</div>
              <div>Phone: ${billingAddress.phone}</div>
            </div>
            <div style="flex: 1;">
              <h4 style="margin: 0 0 10px; color: #888; font-size: 12px; text-transform: uppercase;">Shipped To</h4>
              <div style="font-weight: bold;">${shippingAddress.fullName}</div>
              <div>${shippingAddress.address}</div>
              <div>${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.zip}</div>
            </div>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>Item</th>
                <th style="text-align: center;">Qty</th>
                <th style="text-align: right;">Price</th>
                <th style="text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div class="totals">
            <div class="total-row"><span>Subtotal</span><span>₹${amounts.subtotal.toLocaleString()}</span></div>
            ${amounts.discount > 0 ? `<div class="total-row" style="color: #d32f2f;"><span>Discount</span><span>-₹${amounts.discount.toLocaleString()}</span></div>` : ''}
            <div class="total-row"><span>GST (Tax)</span><span>₹${amounts.tax.toLocaleString()}</span></div>
            <div class="total-row grand-total"><span>Grand Total</span><span>₹${amounts.total.toLocaleString()}</span></div>
          </div>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Vision Kart. All rights reserved.</p>
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
  generateInvoiceHTML
};
