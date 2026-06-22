import axios from 'axios';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Streams a Claude completion and invokes onDelta for each text chunk.
// This calls the real /v1/messages streaming endpoint and re-emits only
// the text deltas — the mobile client never talks to Anthropic directly,
// which is the entire point of this proxy (see backend-api-spec.md §7
// and §1 on why a backend is required at all).
export async function streamClaudeCompletion(params: {
  system: string;
  messages: ClaudeMessage[];
  onDelta: (text: string) => void;
}): Promise<{ outputTokens: number }> {
  const { system, messages, onDelta } = params;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages,
      stream: true,
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      responseType: 'stream',
    },
  );

  let outputTokens = 0;

  return new Promise((resolve, reject) => {
    let buffer = '';
    response.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            onDelta(parsed.delta.text);
          }
          if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
            outputTokens = parsed.usage.output_tokens;
          }
        } catch {
          // Ignore malformed SSE lines rather than aborting the whole stream.
        }
      }
    });
    response.data.on('end', () => resolve({ outputTokens }));
    response.data.on('error', reject);
  });
}
