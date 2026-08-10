type SafeContext = { role: string; answer: string; sessions?: unknown };

export async function polishAssistantAnswer(context: SafeContext): Promise<string> {
  if ((process.env.MODEL_PROVIDER || 'stub') !== 'ollama') return context.answer;
  const base = (process.env.MODEL_BASE_URL || '').replace(/\/$/, '');
  try {
    const url = new URL(base);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return context.answer;
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MODEL_NAME || 'llama3.2:3b',
        stream: false,
        prompt: `Rewrite this answer clearly. Do not add facts or actions. Caller role: ${context.role}. Safe context: ${JSON.stringify(context)}`
      })
    });
    if (!response.ok) return context.answer;
    const payload = await response.json() as { response?: string };
    return payload.response?.trim() || context.answer;
  } catch {
    return context.answer;
  }
}
