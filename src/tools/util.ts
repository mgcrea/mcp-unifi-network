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

/** Run a tool body, JSON-formatting the result and turning throws into tool errors. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

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
