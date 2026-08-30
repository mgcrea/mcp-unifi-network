// The primary transport: the official UniFi Network Integration API. Stateless
// (an `X-API-KEY` header, no cookie, no CSRF), and it answers every collection
// with the same `{offset, limit, count, totalCount, data}` envelope.

import type { Logger } from "./auth.js";
import { UnifiApiError } from "./errors.js";
import { buildQuery, encodeSegment, readBodyCapped, safeJsonParse, withRetry } from "./http.js";
import type { Query } from "./http.js";

export type UnifiClientOptions = {
  baseUrl: string;
  apiKey: string;
  maxRetries?: number;
  pageLimit?: number;
  maxPages?: number;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger;
  maxBytes?: number;
};

export type Page<T = unknown> = {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: T[];
};

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  /** Bounds the request; the startup probe sets a short one. */
  signal?: AbortSignal;
  /** Suppress the 404-means-wrong-mount-point heuristics during probing. */
  raw?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Two error envelopes reach this client, and only one of them is documented.
 *
 * The Network app answers with a flat
 * `{statusCode, statusName, code, message, requestId}`. But UniFi OS rejects an
 * unauthenticated request at the proxy, before the Network app ever sees it, and
 * that layer answers `{"error": {"code": 401, "message": "Unauthorized"}}`.
 * Verified against a live console: every 401 takes the nested form. Reading only
 * the documented shape silently discards the detail on the single most common
 * failure anyone will hit.
 */
const errorFields = (parsed: unknown): { message?: string; code?: string; requestId?: string } => {
  if (!isRecord(parsed)) return {};
  const nested = isRecord(parsed.error) ? parsed.error : parsed;
  return {
    ...(typeof nested.message === "string" ? { message: nested.message } : {}),
    // `code` is a dotted string in the documented envelope and a number in the
    // proxy's, so it is normalized to a string either way.
    ...(typeof nested.code === "string"
      ? { code: nested.code }
      : typeof nested.code === "number"
        ? { code: String(nested.code) }
        : {}),
    ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
  };
};

/** Default cap on a single response body. Integration payloads are far smaller. */
const DEFAULT_MAX_BYTES = 25_000_000;

export class UnifiClient {
  readonly baseUrl: string;
  readonly defaultSite: string | undefined;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  readonly pageLimit: number;
  readonly maxPages: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly maxBytes: number;
  /** Set by the server so a 404 on a site path can drop a stale site cache. */
  onSiteNotFound: (() => void) | undefined;

  constructor(opts: UnifiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.maxRetries = opts.maxRetries ?? 3;
    this.pageLimit = opts.pageLimit ?? 50;
    this.maxPages = opts.maxPages ?? 20;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.defaultSite = undefined;
  }

  /** A new client on a different mount point, sharing everything else. */
  withBaseUrl(baseUrl: string): UnifiClient {
    const next = new UnifiClient({
      baseUrl,
      apiKey: this.apiKey,
      maxRetries: this.maxRetries,
      pageLimit: this.pageLimit,
      maxPages: this.maxPages,
      userAgent: this.userAgent,
      fetch: this.fetchImpl,
      ...(this.logger ? { logger: this.logger } : {}),
      maxBytes: this.maxBytes,
    });
    next.onSiteNotFound = this.onSiteNotFound;
    return next;
  }

  sitePath(siteId: string, suffix = ""): string {
    return `/sites/${encodeSegment(siteId)}${suffix}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    const bodyText = hasBody ? JSON.stringify(opts.body) : "";

    const res = await withRetry(
      () =>
        this.fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            "X-API-KEY": this.apiKey,
            "User-Agent": this.userAgent,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasBody ? { body: bodyText } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      {
        maxRetries: this.maxRetries,
        label: `[unifi] ${method} ${path}`,
        logger: this.logger,
        // There is nothing to invalidate: the API key is static, so a 401 means
        // the key is wrong and retrying would only burn the retry budget.
      },
    );

    const text = await readBodyCapped(
      res,
      this.maxBytes,
      "Narrow the request with `filter` or a smaller `limit`.",
    );

    if (!res.ok) {
      const parsed = safeJsonParse(text);
      const fields = errorFields(parsed);
      throw new UnifiApiError(this.errorMessage(res, method, path, fields, opts.raw === true), {
        status: res.status,
        ...(fields.code ? { code: fields.code } : {}),
        ...(fields.requestId ? { requestId: fields.requestId } : {}),
        errors: parsed,
      });
    }

    // 204 and an empty 200 both mean "done, nothing to say" here.
    if (res.status === 204 || text.trim() === "") return null as T;
    return safeJsonParse(text) as T;
  }

  get<T = unknown>(path: string, query?: Query, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, { ...opts, ...(query ? { query } : {}) });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    const opts: RequestOptions = {};
    if (body !== undefined) opts.body = body;
    if (query) opts.query = query;
    return this.request<T>("POST", path, opts);
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body === undefined ? {} : { body });
  }

  del<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, query ? { query } : {});
  }

  /**
   * Follow `offset` pagination until the collection is exhausted, bounded by
   * BOTH a page count and an item count. An unbounded loop against a large site
   * is how a single tool call fills a context window.
   */
  async listAll<T = unknown>(
    path: string,
    query: Query = {},
    opts: { limit?: number; maxItems?: number } = {},
  ): Promise<{ data: T[]; totalCount: number; truncated: boolean }> {
    const limit = Math.min(opts.limit ?? this.pageLimit, 200);
    const maxItems = opts.maxItems ?? limit * this.maxPages;
    const data: T[] = [];
    let offset = 0;
    let totalCount = 0;

    for (let page = 0; page < this.maxPages; page += 1) {
      const res = await this.get<Page<T>>(path, { ...query, offset, limit });
      const items = Array.isArray(res?.data) ? res.data : [];
      totalCount =
        typeof res?.totalCount === "number" ? res.totalCount : data.length + items.length;
      data.push(...items);
      offset += items.length;
      if (items.length === 0 || offset >= totalCount || data.length >= maxItems) break;
    }

    const truncated = data.length < totalCount;
    return { data: data.slice(0, maxItems), totalCount, truncated };
  }

  /** Status-specific remediation, because the model reads this and acts on it. */
  private errorMessage(
    res: Response,
    method: string,
    path: string,
    fields: { message?: string; code?: string },
    raw: boolean,
  ): string {
    const code = fields.code ? ` [${fields.code}]` : "";
    const detail = fields.message ? `: ${fields.message}` : "";
    const base = `UniFi API ${res.status} on ${method} ${path}${code}${detail}`;
    if (raw) return base;

    if (res.status === 401) {
      return (
        `${base} — the API key was rejected. Check UNIFI_API_KEY, and that it was created on ` +
        `THIS console: keys are per-console and are shown only once. The UI moved — on Network ` +
        `10.6+ look for "Integrations" as its own item in the left sidebar (plug icon); on ` +
        `earlier versions it is Settings → Control Plane → Integrations.`
      );
    }
    if (res.status === 403) {
      return (
        `${base} — the key authenticated but its role lacks permission for this resource. ` +
        `An API key inherits the role of the admin who created it; create one from a Full ` +
        `Management admin if this needs to be writable.`
      );
    }
    if (res.status === 404 && path.startsWith("/sites/")) {
      this.onSiteNotFound?.();
      return (
        `${base} — either the site id is wrong or this endpoint does not exist on this ` +
        `console's Network version. On this API \`siteId\` is a UUID, not the legacy ` +
        `8-character site name; call unifi_list_sites to see the real ids. If the site is ` +
        `right, call unifi_get_console_info to check the version tier.`
      );
    }
    if (res.status === 404) {
      return (
        `${base} — no such endpoint on this console. Call unifi_get_console_info: this API ` +
        `gained most of its paths in Network 10.0, and an older console simply does not serve them.`
      );
    }
    if (res.status === 429) {
      return `${base} — rate limited. Wait for the window to reset, or lower \`limit\`.`;
    }
    return base;
  }
}
