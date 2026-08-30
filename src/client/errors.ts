/**
 * A failure reported by the Network Integration API, whose error envelope is
 * `{statusCode, statusName, code, message, timestamp, requestPath, requestId}`.
 *
 * `requestId` is kept because it is the only handle on a request once it has
 * left this process: it is what correlates a 500 with a line in the console's
 * own log, and it is the first thing anyone debugging the console will ask for.
 */
export class UnifiApiError extends Error {
  override readonly name = "UnifiApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      code?: string | undefined;
      requestId?: string | undefined;
      errors?: unknown;
    },
  ) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.errors = opts.errors;
  }
}

/**
 * A failure reported by the legacy controller API, which signals errors in the
 * body rather than the status line: `{meta: {rc: "error", msg: "api.err.X"}}`,
 * routinely arriving with HTTP 200. `rc` and `msg` are carried separately from
 * `status` precisely because the status is so often a lie here.
 */
export class UnifiLegacyError extends Error {
  override readonly name = "UnifiLegacyError";
  readonly status: number;
  readonly rc: string | undefined;
  readonly msg: string | undefined;

  constructor(
    message: string,
    opts: { status: number; rc?: string | undefined; msg?: string | undefined },
  ) {
    super(message);
    this.status = opts.status;
    this.rc = opts.rc;
    this.msg = opts.msg;
  }
}

/**
 * Thrown when a site could not be resolved. Carries the candidates so the tool
 * layer can render them without a second lookup.
 */
export class SiteResolutionError extends Error {
  override readonly name = "SiteResolutionError";
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

/** Thrown when a write path is reached while UNIFI_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set UNIFI_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}

/** Thrown when a response is too large to parse into a tool result. */
export class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";

  constructor(bytes: number, maxBytes: number, hint: string) {
    super(
      `That response is ${Math.round(bytes / 1_000_000)} MB, over the ${Math.round(
        maxBytes / 1_000_000,
      )} MB limit, and was not parsed. ${hint}`,
    );
  }
}
