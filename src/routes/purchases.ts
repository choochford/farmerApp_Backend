import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { verifyAppleReceipt, verifyGooglePurchase } from '../services/receiptVerification';

export const purchasesRouter = Router();
export const webhooksRouter = Router();

// POST /v1/purchases/verify — see backend-api-spec.md §10.
// The client never sets adFree itself; this endpoint is the only path
// that can.
purchasesRouter.post('/verify', requireAuth, async (req: AuthedRequest, res) => {
  const { platform, receipt_data, product_id } = req.body;
  if (!platform || !receipt_data || !product_id) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'platform, receipt_data, and product_id are required', status: 400 } });
  }

  try {
    const result = platform === 'apple' ? await verifyAppleReceipt(receipt_data) : await verifyGooglePurchase(receipt_data);

    if (!result.valid) {
      return res.status(400).json({ error: { code: 'INVALID_RECEIPT', message: 'Receipt could not be verified', status: 400 } });
    }

    // transaction_id has a unique constraint — re-verifying the same
    // receipt (e.g. a retried request after a flaky network response) is
    // idempotent rather than erroring or creating a duplicate row.
    const existing = await queryOne(`SELECT id FROM purchases WHERE transaction_id = $1`, [result.transactionId]);
    let purchaseId = existing?.id;

    if (!existing) {
      const created = await queryOne(
        `INSERT INTO purchases (id, user_id, platform, product_id, transaction_id, receipt_data, verified_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 'valid') RETURNING id`,
        [uuidv4(), req.userId, platform, product_id, result.transactionId, receipt_data],
      );
      purchaseId = created.id;
    }

    await query(`UPDATE users SET ad_free = true, ad_free_purchase_id = $1 WHERE id = $2`, [purchaseId, req.userId]);

    const user = await queryOne(`SELECT id, ad_free FROM users WHERE id = $1`, [req.userId]);
    res.json(user);
  } catch (err) {
    console.error('Receipt verification error', err);
    res.status(502).json({ error: { code: 'INVALID_RECEIPT', message: 'Could not reach verification provider', status: 502 } });
  }
});

// POST /v1/purchases/restore — same verification path, used after a
// reinstall or a new device, when the client has a receipt/token from
// the platform's purchase history but no local record of having verified
// it with our backend before.
purchasesRouter.post('/restore', requireAuth, async (req: AuthedRequest, res) => {
  const { platform, receipt_data } = req.body;
  if (!platform || !receipt_data) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'platform and receipt_data are required', status: 400 } });
  }

  try {
    const result = platform === 'apple' ? await verifyAppleReceipt(receipt_data) : await verifyGooglePurchase(receipt_data);
    if (!result.valid) {
      return res.status(400).json({ error: { code: 'INVALID_RECEIPT', message: 'No valid purchase found to restore', status: 400 } });
    }

    let purchase = await queryOne(`SELECT id FROM purchases WHERE transaction_id = $1`, [result.transactionId]);
    if (!purchase) {
      purchase = await queryOne(
        `INSERT INTO purchases (id, user_id, platform, product_id, transaction_id, receipt_data, verified_at, status)
         VALUES ($1, $2, $3, 'growguide_remove_ads', $4, $5, now(), 'valid') RETURNING id`,
        [uuidv4(), req.userId, platform, result.transactionId, receipt_data],
      );
    }

    await query(`UPDATE users SET ad_free = true, ad_free_purchase_id = $1 WHERE id = $2`, [purchase.id, req.userId]);
    const user = await queryOne(`SELECT id, ad_free FROM users WHERE id = $1`, [req.userId]);
    res.json(user);
  } catch (err) {
    console.error('Restore verification error', err);
    res.status(502).json({ error: { code: 'INVALID_RECEIPT', message: 'Could not reach verification provider', status: 502 } });
  }
});

// POST /v1/webhooks/apple and /v1/webhooks/google (mounted separately in
// index.ts as webhooksRouter) — server-to-server notifications for
// refunds/chargebacks (App Store Server Notifications V2, Google Play
// Real-time Developer Notifications). Both are stubbed: the real payloads
// are signed JWTs (Apple) / Pub/Sub messages (Google) that need signature
// verification before trusting `body.transaction_id` — do NOT ship this
// as-is, it's here to show where revocation plugs in.
webhooksRouter.post('/apple', async (req, res) => {
  const transactionId = req.body?.transaction_id;
  if (transactionId) {
    await query(`UPDATE purchases SET status = 'revoked' WHERE transaction_id = $1`, [transactionId]);
    await query(`UPDATE users SET ad_free = false WHERE ad_free_purchase_id = (SELECT id FROM purchases WHERE transaction_id = $1)`, [transactionId]);
  }
  res.status(200).send();
});

webhooksRouter.post('/google', async (req, res) => {
  const transactionId = req.body?.transaction_id;
  if (transactionId) {
    await query(`UPDATE purchases SET status = 'revoked' WHERE transaction_id = $1`, [transactionId]);
    await query(`UPDATE users SET ad_free = false WHERE ad_free_purchase_id = (SELECT id FROM purchases WHERE transaction_id = $1)`, [transactionId]);
  }
  res.status(200).send();
});
