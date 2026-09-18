/**
 * Generic sliding-window rate limiter and provider quota-error detection.
 *
 * No knowledge of Gemini, notes, or any other domain concept lives here —
 * this is pure "how many calls happened in the last N ms" bookkeeping, kept
 * separate so it can be reused or unit-tested on its own.
 */

export interface SlidingWindowLimiter {
  hasBudget(): boolean;
  recordCall(): void;
}

export function createSlidingWindowLimiter(limit: number, windowMs = 60_000): SlidingWindowLimiter {
  const timestamps: number[] = [];

  return {
    hasBudget(): boolean {
      const now = Date.now();
      while (timestamps.length > 0 && now - timestamps[0]! > windowMs) {
        timestamps.shift();
      }
      return timestamps.length < limit;
    },
    recordCall(): void {
      timestamps.push(Date.now());
    },
  };
}

/** True if `err` looks like a provider rate-limit rejection (HTTP 429 / RESOURCE_EXHAUSTED). */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429");
}
