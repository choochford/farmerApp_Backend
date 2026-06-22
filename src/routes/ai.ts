import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { buildSystemPrompt } from '../services/systemPrompt';
import { streamClaudeCompletion } from '../services/claudeClient';
import { checkAndIncrementUsage, recordTokenUsage } from '../services/aiUsage';

export const aiRouter = Router();

const MAX_HISTORY_MESSAGES = 20; // trim long-running conversations before they blow the context window / cost budget

// POST /v1/ai/chat — see backend-api-spec.md §7.
//
// Wire format: newline-delimited JSON objects, each `{ "delta": "text" }`,
// matching what src/services/api.ts on the React Native side expects from
// its XMLHttpRequest-based reader. This is deliberately NOT the raw
// Anthropic SSE format — the client should never need to know the shape
// of Anthropic's API, only ours, so we re-encode here.
aiRouter.post('/chat', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { conversation_id, message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'message is required', status: 400 } });
  }

  const usage = await checkAndIncrementUsage(userId);
  if (!usage.allowed) {
    return res.status(429).json({
      error: { code: 'AI_LIMIT_EXCEEDED', message: 'Monthly AI message limit reached', status: 429 },
    });
  }

  let conversationId = conversation_id;
  if (!conversationId) {
    const created = await queryOne(
      `INSERT INTO ai_conversations (id, user_id) VALUES ($1, $2) RETURNING id`,
      [uuidv4(), userId],
    );
    conversationId = created.id;
  } else {
    // Verify the conversation actually belongs to this user before
    // appending to it or returning its history — otherwise a user could
    // pass an arbitrary conversation_id and read/extend someone else's chat.
    const owned = await queryOne(`SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`, [conversationId, userId]);
    if (!owned) {
      return res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown conversation_id', status: 404 } });
    }
  }

  await query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, [conversationId, message]);

  const history = await query(
    `SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );
  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

  const systemPrompt = await buildSystemPrompt(userId);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  // Disables compression middleware buffering the whole response before
  // sending — if compression is added globally later, this route needs to
  // be excluded from it or streaming breaks (the client would see nothing
  // until the full response arrives, defeating the point of streaming).
  res.setHeader('X-Accel-Buffering', 'no');

  let fullText = '';
  try {
    const { outputTokens } = await streamClaudeCompletion({
      system: systemPrompt,
      messages: trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
      onDelta: (text) => {
        fullText += text;
        res.write(JSON.stringify({ delta: text }) + '\n');
      },
    });

    await query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`, [conversationId, fullText]);
    await recordTokenUsage(userId, outputTokens);
    res.end();
  } catch (err) {
    console.error('Claude streaming error', err);
    // The client has already received a 200 + partial body by this point
    // (streaming responses can't retroactively become a 4xx/5xx), so
    // signal failure in-band rather than trying to set a status code.
    res.write(JSON.stringify({ error: 'AI request failed mid-stream' }) + '\n');
    res.end();
  }
});

aiRouter.get('/conversations/:id', requireAuth, async (req: AuthedRequest, res) => {
  const convo = await queryOne(`SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  if (!convo) {
    return res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown conversation_id', status: 404 } });
  }
  const messages = await query(`SELECT role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [req.params.id]);
  res.json({ id: convo.id, messages });
});

aiRouter.delete('/conversations/:id', requireAuth, async (req: AuthedRequest, res) => {
  await query(`DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  res.status(204).send();
});
