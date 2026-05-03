/**
 * Exponential backoff with full jitter. Returns the number of ms a caller
 * should sleep before the given retry attempt.
 *
 * `retryNumber` is 1-indexed:
 *   - retryNumber = 1 → ~250ms (the wait before the *second* attempt overall)
 *   - retryNumber = 2 → ~500ms
 *   - retryNumber = 3 → ~1000ms
 *   - ... capped at maxMs (default 4s)
 *
 * 20% jitter on either side prevents thundering-herd retries when many
 * jobs were rate-limited or 500'd at the same time.
 */
export function backoffMs(
  retryNumber: number,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 4000;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, retryNumber - 1));
  // 0.8x – 1.2x
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

/**
 * HubSpot returns Retry-After as a number of seconds (int). Spec also
 * permits an HTTP date — we handle both, falling back to undefined.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
