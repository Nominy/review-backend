export function requestApiKey(headers: Record<string, string | undefined>): string {
  const supplied = headers['x-openrouter-key'];
  if (!supplied?.trim() || supplied.length > 512) throw new Error('An OpenRouter key is required.');
  return supplied.trim();
}

export async function keyUsage(key: string | undefined) {
  if (!key?.trim() || key.length > 512) throw new Error('Save an OpenRouter key first.');
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key.trim()}` },
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'OpenRouter rejected this key.' : `OpenRouter usage check failed (${response.status}).`);
  const { data } = await response.json() as { data: Record<string, unknown> };
  const result: Record<string, number | string | boolean | null> = {};
  for (const field of ['usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'limit', 'limit_remaining', 'limit_reset', 'is_free_tier']) {
    const value = data?.[field];
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[field] = value;
  }
  return result;
}
