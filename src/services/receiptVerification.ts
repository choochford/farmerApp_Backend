import axios from 'axios';
import { google } from 'googleapis';

const APPLE_PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

interface VerifyResult {
  valid: boolean;
  transactionId?: string;
}

// Verifies an iOS receipt against Apple's servers. Per Apple's docs, you
// must try production first and only fall back to sandbox on status 21007
// (receipt is from the sandbox environment) — trying sandbox first would
// incorrectly reject real production receipts.
export async function verifyAppleReceipt(receiptData: string): Promise<VerifyResult> {
  const body = {
    'receipt-data': receiptData,
    password: process.env.APPLE_SHARED_SECRET,
    'exclude-old-transactions': true,
  };

  let response = await axios.post(APPLE_PRODUCTION_URL, body);
  if (response.data.status === 21007) {
    response = await axios.post(APPLE_SANDBOX_URL, body);
  }

  if (response.data.status !== 0) {
    return { valid: false };
  }

  const latestReceipt = response.data.latest_receipt_info?.[0] ?? response.data.receipt?.in_app?.[0];
  return { valid: true, transactionId: latestReceipt?.transaction_id };
}

// Verifies an Android purchase token against the Google Play Developer
// API. Requires a service-account JSON key with access to the Play
// Console's API — see .env.example.
export async function verifyGooglePurchase(purchaseToken: string): Promise<VerifyResult> {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const androidpublisher = google.androidpublisher({ version: 'v3', auth });

  const productId = 'growguide_remove_ads';
  const response = await androidpublisher.purchases.products.get({
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME!,
    productId,
    token: purchaseToken,
  });

  // purchaseState: 0 = purchased, 1 = canceled, 2 = pending
  const valid = response.data.purchaseState === 0;
  return { valid, transactionId: purchaseToken };
}
