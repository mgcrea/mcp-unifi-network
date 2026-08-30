// Everything here is envelope-agnostic: it knows about HTTP status codes and
// nothing about UniFi's two very different response shapes. Both clients use it;
// neither leaks its own envelope into it.

import type { Logger } from "#/client/auth";
import { ResponseTooLargeError } from "#/client/errors";

export type Query = Record<string, string | number | boolean | undefined | (string | number)[]>;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const encodeSegment = (value: string): string => encodeURIComponent(value);

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
};

export type RetryPolicy = {
  maxRetries: number;
  label: string;
  logger?: Logger | undefined;
  /** Invalidate a cached credential so the retry re-authenticates. */
  onUnauthorized?: (() => void) | undefined;
  /**
   * Retry a 429. Defaults to true, and is set false for the legacy login call:
   * UniFi rate-limits `/api/auth/login` hard, and hammering it deepens the
   * lockout instead of recovering from it.
   */
  retryOn429?: boolean | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
export const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  const retryOn429 = policy.retryOn429 ?? true;
  let attempt = 0;
  for (;;) {
    policy.logger?.debug?.(`${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if (res.status === 401 && policy.onUnauthorized && attempt < policy.maxRetries) {
      policy.logger?.warn?.(`${policy.label} — HTTP 401, re-authenticating and retrying`);
      policy.onUnauthorized();
      attempt += 1;
      continue;
    }
    const retryable = (res.status === 429 && retryOn429) || res.status >= 500;
    if (retryable && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      policy.logger?.warn?.(`${policy.label} — HTTP ${res.status}, retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }
    return res;
  }
};

/**
 * Read a body, refusing to buffer more than `maxBytes`. Checked against the
 * declared length first and then while streaming, because a controller dumping
 * a 47 MB device table sends no useful Content-Length and would otherwise be
 * parsed into the process before anyone noticed.
 */
export const readBodyCapped = async (
  res: Response,
  maxBytes: number,
  hint: string,
): Promise<string> => {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(declared, maxBytes, hint);
  }
  if (!res.body) return res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(total, maxBytes, hint);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};
