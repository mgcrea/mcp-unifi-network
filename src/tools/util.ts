import { z } from "zod";

import {
  ResponseTooLargeError,
  SiteResolutionError,
  UnifiApiError,
  UnifiLegacyError,
  WritesDisabledError,
} from "#/client/errors";
import { FILTER_ARG_DESCRIPTION } from "#/filter";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds 19-41% to every response — worst
 * on wide lists of short-keyed objects, which are exactly the replies already
 * big enough to hurt. No model needs the indentation, and every tool returns
 * through here. Files written to disk for humans stay pretty.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof UnifiApiError) {
    return fail(err.message, {
      status: err.status,
      ...(err.code ? { code: err.code } : {}),
      // The only handle on this request once it left the process.
      ...(err.requestId ? { requestId: err.requestId } : {}),
    });
  }
  if (err instanceof UnifiLegacyError) {
    return fail(err.message, {
      status: err.status,
      ...(err.rc ? { rc: err.rc } : {}),
      ...(err.msg ? { msg: err.msg } : {}),
    });
  }
  if (err instanceof SiteResolutionError) return fail(err.message, err.details);
  if (err instanceof WritesDisabledError) return fail(err.message);
  if (err instanceof ResponseTooLargeError) return fail(err.message);
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", err);
};

/** What a secret is replaced with. A write carrying it back is refused, see below. */
export const REDACTED = "[redacted]";

/**
 * Field names whose string values are credentials. Both APIs hand them out to
 * any reader: the legacy `rest/wlanconf` returns every SSID's `x_passphrase`
 * (the controller's `x_` prefix marks its stored secrets — `x_iapp_key`,
 * `x_authkey`, `x_vwirekey`), and the Integration API's single-broadcast GET
 * returns `securityConfiguration.passphrase`. Tool results end up in
 * transcripts, logs and prompt caches, so they leave this process masked.
 * Only string values are masked: `x_aes_gcm: true` is a capability flag.
 */
const SECRET_KEY =
  /^x_|^(passphrase|password|passwd|psk|pre_?shared_?key|shared_?secret|secret|private_?key)$/i;

/** Deep copy of `value` with every credential string replaced by {@link REDACTED}. */
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      SECRET_KEY.test(key) && typeof v === "string" && v !== "" ? REDACTED : redactSecrets(v),
    ]),
  );
};

const carriesRedacted = (value: unknown): boolean =>
  value === REDACTED ||
  (typeof value === "object" && value !== null && Object.values(value).some(carriesRedacted));

/**
 * The trap redaction opens: read a WLAN, change one field, write it back — and
 * the passphrase is now literally `[redacted]`, taking every client offline.
 * A write body still carrying the marker is refused rather than sent.
 */
export const assertNoRedactedSecrets = (body: unknown): void => {
  if (carriesRedacted(body)) {
    throw new Error(
      `The request body contains "${REDACTED}" — a secret masked when it was read. Sending it ` +
        "would set that credential to the literal text. Drop the field from the body — the " +
        "legacy rest/* endpoints leave an omitted field as it is — or, where the endpoint needs " +
        "the whole object, re-read with `revealSecrets: true` and send the real value.",
    );
  }
};

/**
 * Run a tool body, JSON-formatting the result and turning throws into tool
 * errors. Secrets are masked unless the tool explicitly opts out.
 */
export const wrap = async <T>(
  fn: () => Promise<T>,
  opts: { revealSecrets?: boolean } = {},
): Promise<ToolResult> => {
  try {
    const data = await fn();
    return ok(opts.revealSecrets === true ? data : redactSecrets(data));
  } catch (err) {
    return toFailure(err);
  }
};

export const revealSecretsArg = z
  .boolean()
  .default(false)
  .describe(
    "Return passphrases and keys in clear instead of masked as `[redacted]`. Only when the user " +
      "has explicitly asked to see or work with the real value — results land in transcripts.",
  );

/** Drop undefined values so we never send `{"filter": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ---------------------------------------------------------------- arg atoms --

export const siteArg = z
  .string()
  .optional()
  .describe(
    "Which site to act on. Accepts the site UUID, its `internalReference` (the legacy " +
      '8-character name, usually "default") or its display name ("Default") — all three are ' +
      "resolved for you, so a guess costs nothing. Defaults to UNIFI_SITE, or to the only site " +
      "when this console has just one. `unifi_list_sites` shows all three for every site.",
  );

/** The API rejects anything above 200 with a 400, so the ceiling is real. */
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Maximum items to return (1-200; the console rejects more). Defaults to UNIFI_PAGE_LIMIT " +
      "(50). Prefer narrowing with `filter` over raising this — the console filters server-side, " +
      "so a filtered request is both smaller and faster than a large page read here.",
  );

export const filterArg = z.string().optional().describe(FILTER_ARG_DESCRIPTION);

/** Destructive tools require this, so an agent can never change something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes live network state.");

export const macArg = z
  .string()
  .describe(
    'A MAC address. Any common format is accepted — "aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF" ' +
      'or "aabbccddeeff" — and normalized before it is sent.',
  );

export const deviceIdArg = z
  .string()
  .min(1)
  .describe(
    "The device's `id` from `unifi_list_devices` — a UUID, NOT its MAC address and NOT its name.",
  );

export const clientIdArg = z
  .string()
  .min(1)
  .describe(
    "The client's `id` from `unifi_list_clients` — a UUID, NOT its MAC address. " +
      "Client ids change when a client reconnects, so list first rather than reusing an old one.",
  );
