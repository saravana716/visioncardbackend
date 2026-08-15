/**
 * CCAvenue Order Status API ("orderStatusTracker") client.
 *
 * Used by the payment reconciler to ask CCAvenue — server-to-server — what
 * actually happened to a transaction, independent of the customer's browser
 * completing the redirect. Uses the same AES-128-CBC (MD5-derived key) crypto
 * and the same access code / working key as the transaction flow.
 *
 * Endpoint (per CCAvenue API integration kit, version 1.2):
 *   POST https://api.ccavenue.com/apis/servlet/DoWebTrans        (live)
 *   POST https://apitest.ccavenue.com/apis/servlet/DoWebTrans    (test)
 *   body: enc_request=<hex>&access_code=...&command=orderStatusTracker
 *         &request_type=JSON&response_type=JSON&version=1.2
 *   response text: "status=0&enc_response=<hex>" (0 = ok; decrypt to JSON)
 *                  "status=1&enc_response=<plain error text>"
 */

const { encrypt, decrypt } = require("./ccavenue");

const STATUS_URL_LIVE = "https://api.ccavenue.com/apis/servlet/DoWebTrans";
const STATUS_URL_TEST = "https://apitest.ccavenue.com/apis/servlet/DoWebTrans";

function isTestMode() {
  const mode = String(process.env.CCAVENUE_MODE || "live").toLowerCase();
  return mode === "test" || mode === "sandbox";
}

function getStatusApiUrl() {
  if (process.env.CCAVENUE_STATUS_URL && String(process.env.CCAVENUE_STATUS_URL).trim()) {
    return String(process.env.CCAVENUE_STATUS_URL).trim();
  }
  return isTestMode() ? STATUS_URL_TEST : STATUS_URL_LIVE;
}

/** Same credential fallback chain as getMerchantConfig (redirect URLs not needed here). */
function getStatusCreds() {
  const test = isTestMode();
  const accessCode = test
    ? process.env.TEST_ACCESS_CODE || process.env.ACCESS_CODE
    : process.env.LIVE_ACCESS_CODE || process.env.ACCESS_CODE;
  const workingKey = test
    ? process.env.TEST_WORKING_KEY || process.env.WORKING_KEY
    : process.env.LIVE_WORKING_KEY || process.env.WORKING_KEY;
  return { accessCode, workingKey };
}

function hasStatusApiCreds() {
  const { accessCode, workingKey } = getStatusCreds();
  return Boolean(accessCode && workingKey);
}

/**
 * Depth-first case-insensitive search for the first key matching one of
 * `names` in a nested object. The status API's response envelope has varied
 * across kit versions (wrapper object name / key casing), so we extract the
 * fields we need tolerantly instead of hard-coding one shape.
 */
function findField(obj, names, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.includes(k.toLowerCase()) && (typeof v === "string" || typeof v === "number")) {
      return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findField(v, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Query CCAvenue for the current status of one order.
 * @returns {Promise<{ok: true, status: string, amount: number|null, raw: object}
 *                  | {ok: false, error: string}>}
 * `status` is lowercased (e.g. "successful", "aborted", "awaited", "invalid").
 */
async function fetchCcavenueOrderStatus(orderId) {
  const { accessCode, workingKey } = getStatusCreds();
  if (!accessCode || !workingKey) {
    return { ok: false, error: "CCAvenue credentials not configured" };
  }

  const reqJson = JSON.stringify({ reference_no: "", order_no: String(orderId) });
  const encRequest = encrypt(reqJson, workingKey);
  const body = new URLSearchParams({
    enc_request: encRequest,
    access_code: accessCode,
    command: "orderStatusTracker",
    request_type: "JSON",
    response_type: "JSON",
    version: "1.2",
  }).toString();

  let text;
  try {
    const res = await fetch(getStatusApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `status API request failed: ${e.message}` };
  }

  // Response is key=value&key=value plain text.
  const params = {};
  for (const pair of String(text || "").split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) params[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }

  if (params.status !== "0" || !params.enc_response) {
    const errText = (params.enc_response || text || "empty response").slice(0, 300);
    return { ok: false, error: `status API error: ${errText}` };
  }

  let json;
  try {
    json = JSON.parse(decrypt(params.enc_response.trim(), workingKey));
  } catch (e) {
    return { ok: false, error: `could not decrypt/parse status response: ${e.message}` };
  }

  const rawStatus = findField(json, ["order_status"]);
  if (rawStatus === undefined) {
    return { ok: false, error: "no order_status field in status response" };
  }
  const amountRaw = findField(json, ["order_capt_amt", "order_amt", "order_gross_amt"]);
  const amount = amountRaw !== undefined && Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : null;

  return { ok: true, status: String(rawStatus).trim().toLowerCase(), amount, raw: json };
}

module.exports = { fetchCcavenueOrderStatus, hasStatusApiCreds };
