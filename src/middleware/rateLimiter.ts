import rateLimit from 'express-rate-limit';

// Per backend-api-spec.md §13: rate limit auth and AI endpoints
// aggressively. These are in addition to (not instead of) the
// per-user monthly AI message budget in services/aiUsage.ts — this
// limiter is IP-based and catches abuse before it even reaches auth.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', status: 429 } },
});

export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', status: 429 } },
});
