const admin = require("firebase-admin");
const path = require("path");

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (parseError) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT env var:", parseError.message);
  }
}

if (!serviceAccount) {
  const serviceAccountPath = path.join(__dirname, "..", "visionkart---e-commerce-firebase-adminsdk-fbsvc-d9e0415fef.json");
  try {
    serviceAccount = require(serviceAccountPath);
  } catch (fileError) {
    console.error("Error loading service account file:", fileError.message);
  }
}

try {
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } else {
    throw new Error("No service account credentials found (env or file).");
  }
} catch (error) {
  // Fail fast with a clear message. Swallowing this error just deferred the
  // crash to the admin.firestore() call below, which throws a misleading
  // "default Firebase app does not exist" — every payment/email operation
  // would fail anyway, so refuse to boot instead.
  console.error(
    "FATAL: Firebase Admin SDK could not be initialized. " +
      "Set FIREBASE_SERVICE_ACCOUNT (JSON) or provide the service-account file.",
    error.message || error
  );
  process.exit(1);
}

const db = admin.firestore();

module.exports = { db, admin };
