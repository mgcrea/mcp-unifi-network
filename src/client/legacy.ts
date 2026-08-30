// The optional second transport: the legacy controller API. Undocumented but
// stable, and the only route to blocking a client, reconnecting one, or reading
// events, alarms and health — none of which the Integration API exposes.
//
// It differs from the primary transport in every dimension that matters:
// cookie + CSRF instead of a header key, `{meta:{rc},data}` instead of the
// paginated envelope, and errors reported in the body while the status line
// says 200. Those differences are contained here and are not allowed to leak
// into `http.ts`, which both transports share.

import type { Logger } from "./auth.js";
import { UnifiLegacyError } from "./errors.js";
import { buildQuery, readBodyCapped, safeJsonParse, withRetry } from "./http.js";
import type { Query } from "./http.js";

export type LegacyClientOptions = {
  baseUrl: string;
  loginUrl: string;
  username: string;
  password: string;
  /**
   * When set, the legacy paths are called with `X-API-KEY` and no login happens
   * at all. UniFi OS proxies the legacy API through the same gateway as the
   * Integration API, and that gateway honours the key on both — so the cookie
   * session, and the full-admin password behind it, is only needed for a
   * self-hosted controller or an older build that rejects the key.
   */
  apiKey?: string | undefined;
  userAgent: string;
  maxRetries?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
  logger?: Logger;
};

type Session = { cookie: string; csrfToken: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Legacy responses are the large ones, so this cap is much tighter than the primary's. */
const DEFAULT_MAX_BYTES = 5_000_000;

/** The `api.err.*` codes people actually hit, with what to do about each. */
const LEGACY_REMEDIES: Record<string, string> = {
  "api.err.NoSiteContext":
    "The site name was not recognised. The legacy API is keyed by the 8-character " +
    '`internalReference` (usually "default"), NOT by the site UUID the Integration API uses — ' +
    "call unifi_list_sites to see both.",
  "api.err.LoginRequired":
    "The console session expired or was invalidated. It is re-established automatically on the " +
    "next call; if this repeats, check UNIFI_USERNAME and UNIFI_PASSWORD.",
  "api.err.Invalid":
    "The controller rejected the payload. Check the command name and its arguments — the legacy " +
    "cmd/* endpoints validate strictly and report nothing more specific than this.",
  "api.err.NoPermission":
    "This console account lacks permission for that operation. The legacy API uses the admin's " +
    "own role, so a read-only admin cannot run cmd/* endpoints.",
  "api.err.InvalidPayload": "The controller could not parse the request body as JSON.",
  "api.err.Ubic2faTokenRequired":
    "This account has two-factor authentication enabled, which cannot be scripted. Create a " +
    "dedicated LOCAL console admin without 2FA and without cloud access, and use that instead.",
};

export class UnifiLegacyClient {
  readonly baseUrl: string;
  private readonly loginUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly apiKey: string | undefined;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  private session: Session | undefined;
  private inflight: Promise<Session> | undefined;

  constructor(opts: LegacyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.loginUrl = opts.loginUrl;
    this.username = opts.username;
    this.password = opts.password;
    this.apiKey = opts.apiKey;
    this.userAgent = opts.userAgent;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /**
   * The session is cached in memory and NEVER written to disk: this cookie is a
   * full console-admin credential, and the process lifetime is the right scope
   * for it. One login per server start.
   */
  private async getSession(): Promise<Session> {
    if (this.session) return this.session;
    this.inflight ??= this.login().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.session = undefined;
  }

  private async login(): Promise<Session> {
    const res = await withRetry(
      () =>
        this.fetchImpl(this.loginUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
          },
          body: JSON.stringify({
            username: this.username,
            password: this.password,
            remember: true,
          }),
        }),
      {
        maxRetries: this.maxRetries,
        label: "[unifi-legacy] POST login",
        logger: this.logger,
        // UniFi rate-limits the login endpoint hard, and retrying a 429 there
        // deepens the lockout rather than recovering from it.
        retryOn429: false,
      },
    );

    const text = await readBodyCapped(res, this.maxBytes, "");
    const body = safeJsonParse(text);

    if (res.status === 429) {
      throw new UnifiLegacyError(
        "The console is rate-limiting logins (HTTP 429). This server logs in once per start and " +
          "reuses the session, so this usually means another client is looping. Wait about a " +
          "minute before restarting.",
        { status: 429 },
      );
    }
    // A 2FA-enabled account answers 499 with this code rather than a 401.
    const msg = isRecord(body) && isRecord(body.meta) ? String(body.meta.msg ?? "") : "";
    if (!res.ok || msg.includes("2fa")) {
      throw new UnifiLegacyError(this.errorMessage(res, msg, "login"), {
        status: res.status,
        rc: "error",
        msg,
      });
    }

    const cookie = (res.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(";")[0])
      .filter((entry): entry is string => Boolean(entry))
      .join("; ");

    if (!cookie) {
      throw new UnifiLegacyError(
        "The console accepted the login but returned no session cookie. This usually means " +
          "UNIFI_HOST points at something other than a UniFi console.",
        { status: res.status },
      );
    }

    const session: Session = {
      cookie,
      csrfToken:
        res.headers.get("x-csrf-token") ?? res.headers.get("x-updated-csrf-token") ?? undefined,
    };
    this.session = session;
    this.logger?.debug?.("[unifi-legacy] session established");
    return session;
  }

  /** Cookie + CSRF headers for one request, establishing the session if needed. */
  private async sessionHeaders(method: string): Promise<Record<string, string>> {
    const session = await this.getSession();
    return {
      Cookie: session.cookie,
      // Missing this on a write yields a bare 403 with no useful body, which is
      // one of the least debuggable failures this API produces.
      ...(session.csrfToken && method !== "GET" ? { "X-CSRF-Token": session.csrfToken } : {}),
    };
  }

  /** A CSRF token may be rotated on any response, so absorb it wherever it appears. */
  private noteCsrf(res: Response): void {
    const updated = res.headers.get("x-updated-csrf-token") ?? res.headers.get("x-csrf-token");
    if (updated && this.session) this.session.csrfToken = updated;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; maxBytes?: number } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    const bodyText = hasBody ? JSON.stringify(opts.body) : "";

    const res = await withRetry(
      async () => {
        // Key auth is stateless: no login round trip, and no CSRF token to
        // carry, because there is no session for a forged request to ride.
        const auth = this.apiKey ? { "X-API-KEY": this.apiKey } : await this.sessionHeaders(method);
        return this.fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
            ...auth,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasBody ? { body: bodyText } : {}),
        });
      },
      {
        maxRetries: this.maxRetries,
        label: `[unifi-legacy] ${method} ${path}`,
        logger: this.logger,
        onUnauthorized: () => this.invalidate(),
      },
    );

    this.noteCsrf(res);
    const text = await readBodyCapped(
      res,
      opts.maxBytes ?? this.maxBytes,
      "Narrow it with `attrs` or `_limit`.",
    );
    return this.unwrap<T>(res, text, path);
  }

  /**
   * The single place where "ok" is decided for this transport.
   *
   * The legacy controller signals failure in the BODY, not the status line: a
   * refused command routinely arrives as HTTP 200 with
   * `{meta:{rc:"error", msg:"api.err.X"}}`. Every read goes through here.
   *
   * Deliberately NOT hoisted into `http.ts`. `meta` is a property of THIS
   * envelope, not of the transport; putting it in the shared layer would make
   * the Integration client carry a shape it will never see, and would misfire
   * the day an Integration payload happens to contain a `meta` key.
   */
  private unwrap<T>(res: Response, text: string, path: string): T {
    const body = safeJsonParse(text);
    const meta = isRecord(body) && isRecord(body.meta) ? body.meta : undefined;
    const rc = typeof meta?.rc === "string" ? meta.rc : undefined;
    const msg = typeof meta?.msg === "string" ? meta.msg : undefined;

    if (!res.ok || rc === "error") {
      if (res.status === 401 || msg === "api.err.LoginRequired") this.invalidate();
      throw new UnifiLegacyError(this.errorMessage(res, msg ?? "", path), {
        status: res.status,
        ...(rc ? { rc } : {}),
        ...(msg ? { msg } : {}),
      });
    }
    if (isRecord(body) && "data" in body) return body.data as T;
    return body as T;
  }

  private errorMessage(res: Response, msg: string, path: string): string {
    const base = `UniFi legacy API ${res.status} on ${path}${msg ? ` [${msg}]` : ""}`;
    const remedy = LEGACY_REMEDIES[msg];
    if (remedy) return `${base} — ${remedy}`;
    if (res.status === 403) {
      return (
        `${base} — a bare 403 from this API almost always means a missing or stale CSRF token. ` +
        `The session is re-established automatically; if it persists, the account may lack the ` +
        `required role.`
      );
    }
    if (res.status === 401) {
      return this.apiKey
        ? `${base} — the console rejected UNIFI_API_KEY on the legacy path. A Site Manager key ` +
            `from unifi.ui.com is NOT accepted here; this needs a key created on the console ` +
            `itself. Older builds may not accept a key on the legacy API at all — set ` +
            `UNIFI_USERNAME and UNIFI_PASSWORD to fall back to a console session.`
        : `${base} — the console session was rejected. Check UNIFI_USERNAME and UNIFI_PASSWORD.`;
    }
    return base;
  }
}
