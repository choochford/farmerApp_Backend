import { query, queryOne } from '../db/pool';
import { redis } from '../db/redis';

const FREE_LIMIT = Number(process.env.AI_FREE_MESSAGES_PER_MONTH ?? 20);
const AD_FREE_LIMIT = Number(process.env.AI_AD_FREE_MESSAGES_PER_MONTH ?? 100);

// Two layers, per backend-api-spec.md §7: a monthly message budget (the
// product-level limit users actually experience) and a short sliding-window
// burst limit in Redis (purely an abuse guard, not something a normal user
// should ever hit).
const BURST_LIMIT = 10;
const BURST_WINDOW_SECONDS = 60;

export async function checkAndIncrementUsage(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const burstKey = `ai_burst:${userId}`;
  const burstCount = await redis.incr(burstKey);
  if (burstCount === 1) {
    await redis.expire(burstKey, BURST_WINDOW_SECONDS);
  }
  if (burstCount > BURST_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  const user = await queryOne(`SELECT ad_free FROM users WHERE id = $1`, [userId]);
  const limit = user?.ad_free ? AD_FREE_LIMIT : FREE_LIMIT;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const usage = await queryOne(`SELECT * FROM ai_usage WHERE user_id = $1`, [userId]);

  if (!usage || new Date(usage.period_start) < monthStart) {
    await query(
      `INSERT INTO ai_usage (user_id, token_count_month, message_count_month, period_start)
       VALUES ($1, 0, 1, $2)
       ON CONFLICT (user_id) DO UPDATE SET token_count_month = 0, message_count_month = 1, period_start = $2`,
      [userId, monthStart.toISOString().slice(0, 10)],
    );
    return { allowed: true, remaining: limit - 1 };
  }

  if (usage.message_count_month >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await query(
    `UPDATE ai_usage SET message_count_month = message_count_month + 1 WHERE user_id = $1`,
    [userId],
  );
  return { allowed: true, remaining: limit - usage.message_count_month - 1 };
}

export async function recordTokenUsage(userId: string, outputTokens: number) {
  await query(`UPDATE ai_usage SET token_count_month = token_count_month + $1 WHERE user_id = $2`, [outputTokens, userId]);
}
