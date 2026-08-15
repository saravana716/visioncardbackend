const { sendMail, getSmtpPublicSummary, getSmtpSetupHints } = require("../utils/mail");

function publicBaseUrl(req) {
  const xf = req.get("x-forwarded-proto");
  const proto = xf ? xf.split(",")[0].trim() : req.protocol;
  return `${proto}://${req.get("host")}`;
}

/**
 * GET /email/smtp — Postman helper: full URL + sample JSON (no secrets).
 */
function getSmtpInfo(req, res) {
  const baseUrl = publicBaseUrl(req);
  const sendUrl = `${baseUrl}/email/send`;
  const smtp = getSmtpPublicSummary();

  return res.status(200).json({
    smtp,
    setup: smtp.configured ? undefined : getSmtpSetupHints(),
    postman: {
      description: "POST JSON to sendUrl with Content-Type: application/json",
      sendUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      bodyExample: {
        to: "recipient@example.com",
        subject: "VisionKart SMTP test",
        text: "If you receive this, SMTP is working.",
      },
    },
  });
}

/**
 * POST /email/send
 * Body: { to, subject, text?, html? }
 */
async function postSend(req, res, next) {
  try {
    // This endpoint can send arbitrary email through the SMTP account, so it is
    // gated by a shared secret. Order-confirmation emails are sent internally by
    // utils/orderListener.js (not via HTTP), so locking this does not affect the
    // storefront. Fails closed when EMAIL_API_KEY is unset.
    const requiredKey = process.env.EMAIL_API_KEY;
    if (!requiredKey) {
      return res.status(503).json({ error: "DISABLED", message: "Email API is disabled. Set EMAIL_API_KEY to enable." });
    }
    if (req.get("x-api-key") !== requiredKey) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or missing x-api-key." });
    }

    const { to, subject, text, html, replyTo } = req.body || {};

    if (!to || !subject) {
      return res.status(400).json({ error: "Validation failed", message: "`to` and `subject` are required" });
    }
    if (!text && !html) {
      return res.status(400).json({ error: "Validation failed", message: "Provide `text` and/or `html`" });
    }

    const info = await sendMail({
      to: String(to).trim(),
      subject: String(subject).trim(),
      text: text != null ? String(text) : undefined,
      html: html != null ? String(html) : undefined,
      replyTo: replyTo ? String(replyTo).trim() : undefined,
    });

    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
    });
  } catch (e) {
    if (e.code === "MAIL_NOT_CONFIGURED" || e.code === "MAIL_FROM_MISSING") {
      const body = { error: e.code, message: e.message };
      if (e.details) Object.assign(body, e.details);
      return res.status(503).json(body);
    }
    return next(e);
  }
}

module.exports = { postSend, getSmtpInfo };
