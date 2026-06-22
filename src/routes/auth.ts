import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '../db/pool';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../middleware/auth';

export const authRouter = Router();

const googleClient = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);

async function findOrCreateUser(provider: 'apple' | 'google' | 'anonymous', providerId: string, email?: string) {
  const existing = await queryOne(
    `SELECT id FROM users WHERE auth_provider = $1 AND auth_provider_id = $2`,
    [provider, providerId],
  );
  if (existing) return existing.id as string;

  const created = await queryOne(
    `INSERT INTO users (id, email, auth_provider, auth_provider_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [uuidv4(), email ?? null, provider, providerId],
  );
  return created.id as string;
}

function issueSession(res: any, userId: string) {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  res.json({ access_token: accessToken, refresh_token: refreshToken, user_id: userId });
}

// POST /v1/auth/apple — body: { identity_token }
// Verifies the Apple-issued identity token. In production this should
// validate the signature against Apple's published JWKS
// (https://appleid.apple.com/auth/keys) and check `aud` matches
// APPLE_BUNDLE_ID — using jwt.decode (no verification) here only to keep
// the scaffold runnable without pulling in apple-signin-auth; swap before
// shipping.
authRouter.post('/apple', async (req, res) => {
  try {
    const { identity_token } = req.body;
    if (!identity_token) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'identity_token is required', status: 400 } });
    }
    const decoded = jwt.decode(identity_token) as any;
    if (!decoded?.sub) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Could not decode identity token', status: 400 } });
    }
    // TODO: verify signature + aud === APPLE_BUNDLE_ID + exp before trusting `decoded`.
    const userId = await findOrCreateUser('apple', decoded.sub, decoded.email);
    issueSession(res, userId);
  } catch (err) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Apple sign-in failed', status: 401 } });
  }
});

// POST /v1/auth/google — body: { id_token }
authRouter.post('/google', async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'id_token is required', status: 400 } });
    }
    const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: process.env.GOOGLE_OAUTH_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid Google token', status: 401 } });
    }
    const userId = await findOrCreateUser('google', payload.sub, payload.email);
    issueSession(res, userId);
  } catch (err) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Google sign-in failed', status: 401 } });
  }
});

// POST /v1/auth/anonymous — creates a device-bound user with no email.
// NOTE (see backend-api-spec.md §14 open questions): an anonymous user who
// later buys ad-free and reinstalls has no reliable way to prove it's the
// same person — restore-on-reinstall for anonymous accounts only works
// because the App Store / Play Store purchase token itself is tied to the
// platform account, not to our `users.id`. That's good enough for restoring
// the *purchase*, but means anonymous users can't recover anything else
// (selected crops, schedule) if they lose the device. Flag this to product
// before launch rather than assuming it's fully solved by this endpoint.
authRouter.post('/anonymous', async (req, res) => {
  const deviceId = req.body?.device_id || uuidv4();
  const userId = await findOrCreateUser('anonymous', deviceId);
  issueSession(res, userId);
});

authRouter.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const userId = verifyRefreshToken(refresh_token);
    const user = await queryOne(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!user) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User no longer exists', status: 401 } });
    }
    res.json({ access_token: signAccessToken(userId) });
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token', status: 401 } });
  }
});

authRouter.post('/logout', async (_req, res) => {
  // Stateless JWTs can't be revoked server-side without a denylist. If
  // that's needed later, store revoked refresh-token IDs in Redis with a
  // TTL matching REFRESH_TOKEN_TTL and check it in verifyRefreshToken.
  res.status(204).send();
});
