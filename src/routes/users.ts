import { Router } from 'express';
import { queryOne, query } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';

export const usersRouter = Router();

// GET /v1/users/me — the client checks this on launch to decide whether
// to initialize the ad SDK at all that session (see backend-api-spec.md §11).
usersRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const user = await queryOne(
    `SELECT id, email, ad_free, notification_push, notification_frost_alerts, notification_watering
     FROM users WHERE id = $1`,
    [req.userId],
  );
  if (!user) {
    return res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'User not found', status: 404 } });
  }
  res.json(user);
});

usersRouter.patch('/me', requireAuth, async (req: AuthedRequest, res) => {
  const { notification_push, notification_frost_alerts, notification_watering, push_token } = req.body;
  await query(
    `UPDATE users SET
       notification_push = COALESCE($1, notification_push),
       notification_frost_alerts = COALESCE($2, notification_frost_alerts),
       notification_watering = COALESCE($3, notification_watering),
       push_token = COALESCE($4, push_token)
     WHERE id = $5`,
    [notification_push, notification_frost_alerts, notification_watering, push_token, req.userId],
  );
  res.status(204).send();
});
