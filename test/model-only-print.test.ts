import { expect, it } from 'vitest';
import { assertPiCredential, piUsage } from '../src/services/constrained-invocation/pi-runtime.js';

it('rejects executable credential helpers before starting the native process', () => {
  expect(() => assertPiCredential('{"anthropic":{"type":"api_key","key":"!touch forbidden"}}')).toThrow('native_auth_helper_unsupported');
  expect(() => assertPiCredential('{"anthropic":{"type":"api_key","key":"fixture","env":{"PATH":"override"}}}')).toThrow('native_auth_helper_unsupported');
  expect(() => assertPiCredential('{"anthropic":{"type":"oauth","access":"fixture","refresh":"fixture","expires":1}}')).not.toThrow();
  expect(() => assertPiCredential('not-json')).toThrow('native_auth_invalid');
});
it('normalizes only complete native usage without fabricating missing cache counts', () => {
  expect(piUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 })).toEqual({ inputTokens: 15, outputTokens: 5, cachedInputTokens: 2, cacheWriteInputTokens: 3 });
  expect(piUsage({ input: 10, output: 5 })).toBeNull();
  expect(piUsage({ input: -1, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});
