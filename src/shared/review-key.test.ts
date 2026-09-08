import { afterEach, expect, it } from 'bun:test';
import { keyUsage, requestApiKey } from "./review-key";
import { config } from '../config';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it('keeps a supplied key request-local and never substitutes the server key', () => {
  const original = config.openRouterApiKey;
  expect(requestApiKey({ 'x-openrouter-key': 'key-a' })).toBe('key-a');
  expect(requestApiKey({ 'x-openrouter-key': 'key-b' })).toBe('key-b');
  expect(() => requestApiKey({})).toThrow('required');
  expect(() => requestApiKey({ 'x-openrouter-key': ' ' })).toThrow('required');
  expect(config.openRouterApiKey).toBe(original);
});

it('isolates simultaneous key usage checks and returns only usage fields', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get('authorization')!;
    seen.push(key);
    await new Promise(resolve => setTimeout(resolve, key.endsWith('a') ? 10 : 1));
    return Response.json({ data: { usage: key.endsWith('a') ? 1 : 2, limit_remaining: null, secret: key } });
  }) as unknown as typeof fetch;
  const values = await Promise.all([keyUsage('key-a'), keyUsage('key-b')]);
  expect(values).toEqual([{ usage: 1, limit_remaining: null }, { usage: 2, limit_remaining: null }]);
  expect(seen).toEqual(['Bearer key-a', 'Bearer key-b']);
});

it('rejects missing and invalid usage credentials without echoing upstream secrets', async () => {
  await expect(keyUsage(undefined)).rejects.toThrow('Save an OpenRouter key');
  globalThis.fetch = (async () => new Response('private upstream content', { status: 401 })) as unknown as typeof fetch;
  await expect(keyUsage('invalid-key')).rejects.toThrow('OpenRouter rejected this key.');
});
