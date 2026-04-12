const crypto = require("crypto");

/**
 * Fixed 16-byte IV used by CCAvenue's AES-128-CBC scheme (same across integration kits).
 * Each byte increments from 0x00 through 0x0f.
 */
const FIXED_IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);

/**
 * Derive the 128-bit AES key from the working key string (CCAvenue uses MD5 digest as key material).
 * @param {string} workingKey
 * @returns {Buffer}
 */
function deriveKey(workingKey) {
  return crypto.createHash("md5").update(workingKey, "utf8").digest();
}

/**
 * Encrypt plain request/response text for CCAvenue (AES-128-CBC, PKCS#7 padding, hex output).
 * @param {string} text - UTF-8 string to encrypt (e.g. merchant_id=...&order_id=...)
 * @param {string} workingKey - Merchant working key from dashboard
 * @returns {string} Hex-encoded ciphertext
 */
function encrypt(text, workingKey) {
  const key = deriveKey(workingKey);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, FIXED_IV);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

/**
 * Decrypt hex-encoded payload from CCAvenue using the same key/IV scheme.
 * @param {string} encText - Hex string from encResp
 * @param {string} workingKey
 * @returns {string} Decrypted UTF-8 string (key=value pairs joined by &)
 */
function decrypt(encText, workingKey) {
  const key = deriveKey(workingKey);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, FIXED_IV);
  let decrypted = decipher.update(encText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Parse CCAvenue-style query string into a plain object (values are strings; URL decoding applied).
 * @param {string} raw - e.g. "order_id=1&amount=10.00"
 * @returns {Record<string, string>}
 */
function parseKeyValueString(raw) {
  const params = {};
  if (!raw || typeof raw !== "string") return params;
  const pairs = raw.split("&");
  for (const pair of pairs) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return params;
}

/**
 * Build the non-encrypted request body: strict key=value&key=value format for CCAvenue.
 * @param {Record<string, string>} fields
 * @returns {string}
 */
function buildRequestString(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

module.exports = {
  encrypt,
  decrypt,
  parseKeyValueString,
  buildRequestString,
};
