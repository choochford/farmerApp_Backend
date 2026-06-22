import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthedRequest extends Request {
  userId?: string;
}

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '90d';

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'access' }, requireEnv('JWT_ACCESS_SECRET'), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function signRefreshToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'refresh' }, requireEnv('JWT_REFRESH_SECRET'), {
    expiresIn: REFRESH_TOKEN_TTL,
  });
}

export function verifyRefreshToken(token: string): string {
  const decoded = jwt.verify(token, requireEnv('JWT_REFRESH_SECRET')) as jwt.JwtPayload;
  if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string') {
    throw new Error('Invalid refresh token');
  }
  return decoded.sub;
}

// Express middleware — every authenticated route in routes/ uses this.
// Per backend-api-spec.md §3: all authenticated endpoints expect
// `Authorization: Bearer <access_token>`.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing access token', status: 401 } });
  }
  const token = header.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, requireEnv('JWT_ACCESS_SECRET')) as jwt.JwtPayload;
    if (decoded.type !== 'access' || typeof decoded.sub !== 'string') {
      throw new Error('Wrong token type');
    }
    req.userId = decoded.sub;
    next();
  } catch {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired access token', status: 401 } });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail loudly at startup rather than signing tokens with `undefined`,
    // which jsonwebtoken would otherwise accept and which would make every
    // token trivially forgeable.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
