import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { UnifiLegacyClient } from "#/client/legacy";
import { summarizeKnownClient, summarizeLegacyEvent } from "#/client/legacy-shape";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { assertSafePath } from "#/tools/request";
import { compact, confirmArg, macArg, siteArg, wrap } from "#/tools/util";

const withinArg = z
  .number()
  .int()
  .min(1)
  .max(8760)
  .default(24)
  .describe("How many hours back to look. Defaults to 24.");

const legacyLimitArg = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe(
    "Maximum rows to return (1-500). Defaults to 50. The controller stores thousands of events, " +
      "and they are verbose — raise this deliberately.",
  );

/**
 * The legacy controller API, wrapped only where the official one has no answer:
 * the roster of clients the console has ever seen (and which of them are
 * blocked), blocking and reconnecting clients, and events, alarms and health.
 * These go against an undocumented API, which is why they carry their own
 * `unifi_legacy_` namespace rather than blending in.
 */
export const registerLegacyTools = (
  server: McpServer,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;

  /** Legacy paths are keyed by the 8-character site name, never by the UUID. */
  const sitePath = async (site: string | undefined, suffix: string): Promise<string> => {
    const name = await ctx.sites.resolveLegacyName(site);
    return `/api/s/${encodeURIComponent(name)}${suffix}`;
  };

  server.registerTool(
    "unifi_legacy_get_health",
    {
      description:
        "Get the site's subsystem health — WAN, LAN, WLAN, VPN and WWW — with the number of " +
        "adopted, disconnected and pending devices in each, plus current throughput and latency. " +
        'This is the closest thing to a one-call answer to "is anything wrong?", and the ' +
        "official API has no equivalent.",
      inputSchema: { site: siteArg },
      annotations: { readOnlyHint: true },
    },
    async ({ site }) =>
      wrap(async () => legacy.request("GET", await sitePath(site, "/stat/health"))),
  );

  server.registerTool(
    "unifi_legacy_list_events",
    {
      description:
        "List recent controller events for a site — clients joining and leaving, devices " +
        "restarting or being adopted, configuration changes and WAN transitions. " +
        'Use this to answer "what happened" questions; the official API exposes no event log ' +
        "at all. Events are verbose, so keep `limit` low and narrow `within` first.",
      inputSchema: { site: siteArg, within: withinArg, limit: legacyLimitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ site, within, limit }) =>
      wrap(async () => {
        const data = await legacy.request<unknown[]>("GET", await sitePath(site, "/stat/event"), {
          query: { within, _limit: limit, _sort: "-time" },
        });
        const rows = Array.isArray(data) ? data : [];
        return { data: rows.map(summarizeLegacyEvent), count: rows.length };
      }),
  );

  server.registerTool(
    "unifi_legacy_list_alarms",
    {
      description:
        "List the site's alarms — the events the controller considers actionable, such as a " +
        "device going down or a rogue access point appearing. Unarchived alarms are the ones " +
        "still demanding attention.",
      inputSchema: {
        site: siteArg,
        archived: z
          .boolean()
          .default(false)
          .describe("True to include archived alarms. Defaults to false — the open ones only."),
        limit: legacyLimitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, archived, limit }) =>
      wrap(async () => {
        const data = await legacy.request<unknown[]>("GET", await sitePath(site, "/stat/alarm"), {
          query: compact({ archived: archived ? undefined : false, _limit: limit, _sort: "-time" }),
        });
        const rows = Array.isArray(data) ? data : [];
        return { data: rows.map(summarizeLegacyEvent), count: rows.length };
      }),
  );

  server.registerTool(
    "unifi_legacy_list_known_clients",
    {
      description:
        "List every client the controller has EVER seen on a site, connected or not, with " +
        "whether each is blocked. This is the only way to answer questions about devices that " +
        "are not currently connected: `unifi_list_clients` returns the live roster only, so a " +
        "blocked or long-absent device is invisible to it. Use this to find out why a device " +
        'will not connect, to audit what has been blocked, or to find "that thing I saw last ' +
        'summer". The reply always carries `blockedCount` for the whole site regardless of ' +
        "which filters you pass, so one call settles whether anything is blocked at all.",
      inputSchema: {
        site: siteArg,
        blocked: z
          .enum(["any", "only", "everBlocked"])
          .default("any")
          .describe(
            'Which clients to return. "only" is those blocked right now. "everBlocked" also ' +
              "includes clients that were blocked and later unblocked — the controller keeps " +
              'that mark, and it is what answers "did I block this by accident once?". ' +
              'Defaults to "any".',
          ),
        search: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Case-insensitive substring matched against the name, hostname, MAC, vendor (OUI) " +
              "and fingerprint. Vendor is usually the way in for an appliance that never had a " +
              'name — try the manufacturer rather than what you call the thing ("husqvarna", ' +
              'not "lawnmower").',
          ),
        notSeenForDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Only clients whose last association was at least this many days ago. Clients " +
              "connected right now are always excluded however old their association is — " +
              "`last_seen` stops moving while a client stays online, so an always-on device " +
              "looks long gone without meaning it.",
          ),
        seenWithinDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only clients seen within this many days. Connected clients always match."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe(
            "Maximum rows to return (1-500). Defaults to 100. A busy site accumulates hundreds " +
              "of known clients, most of them junk from MAC randomisation — filter rather than " +
              "raising this.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, blocked, search, notSeenForDays, seenWithinDays, limit }) =>
      wrap(async () => {
        // `rest/user` is deliberate over the newer v2 `clients/history`: it is
        // the complete roster (203 vs 162 on the console this was built
        // against), and v2 omits entries the controller has stopped tracking
        // actively — exactly the old ones these questions are about.
        // `stat/sta` is fetched alongside because `rest/user.last_seen` is the
        // last ASSOCIATION, not the last activity: it stops moving while a
        // client stays connected. Without this cross-reference a device online
        // continuously for four months reports as absent for four months —
        // measured at 23 of 46 connected clients on a live console.
        const [data, live] = await Promise.all([
          legacy.request<unknown[]>("GET", await sitePath(site, "/rest/user")),
          legacy
            .request<unknown[]>("GET", await sitePath(site, "/stat/sta"))
            .catch(() => [] as unknown[]),
        ]);
        const connected = new Set(
          (Array.isArray(live) ? live : [])
            .map((c) => (c as { mac?: unknown }).mac)
            .filter((m): m is string => typeof m === "string"),
        );
        const now = Date.now();
        const rows = (Array.isArray(data) ? data : []).map((row) =>
          summarizeKnownClient(
            row,
            now,
            connected.has(String((row as { mac?: unknown }).mac ?? "")),
          ),
        );

        // Counted across every known client, never across the filtered subset —
        // a `blockedCount` that moved with the filters would make an empty
        // filtered result read as "nothing is blocked".
        const blockedCount = rows.filter((row) => row.blocked === true).length;
        const everBlockedCount = rows.filter((row) => row.wasEverBlocked === true).length;

        const needle = search?.toLowerCase();
        const matched = rows.filter((row) => {
          if (blocked === "only" && row.blocked !== true) return false;
          if (blocked === "everBlocked" && row.wasEverBlocked !== true) return false;
          const age = typeof row.daysSinceSeen === "number" ? row.daysSinceSeen : undefined;
          if (notSeenForDays !== undefined && (age === undefined || age < notSeenForDays)) {
            return false;
          }
          if (seenWithinDays !== undefined && (age === undefined || age > seenWithinDays)) {
            return false;
          }
          if (!needle) return true;
          return ["name", "mac", "oui", "fingerprint"]
            .map((key) => String(row[key] ?? "").toLowerCase())
            .some((value) => value.includes(needle));
        });

        matched.sort(
          (a, b) =>
            (typeof a.daysSinceSeen === "number" ? a.daysSinceSeen : Number.MAX_SAFE_INTEGER) -
            (typeof b.daysSinceSeen === "number" ? b.daysSinceSeen : Number.MAX_SAFE_INTEGER),
        );

        const page = matched.slice(0, limit);
        return {
          data: page,
          totalKnown: rows.length,
          connectedNow: rows.filter((row) => row.connectedNow === true).length,
          matched: matched.length,
          blockedCount,
          everBlockedCount,
          ...(page.length < matched.length
            ? {
                truncated: true,
                note: `Returned ${page.length} of ${matched.length} matches. Narrow with \`search\` or \`notSeenForDays\`.`,
              }
            : {}),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "unifi_legacy_unblock_client",
    {
      description:
        "Remove a client's block, letting it back onto the network. Safe to call on a client " +
        "that was never blocked. Identified by MAC address, not by the UUID the official API " +
        "uses — a blocked client is not in `unifi_list_clients`, so its MAC is the only handle.",
      inputSchema: { site: siteArg, mac: macArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ site, mac }) =>
      wrap(async () =>
        legacy.request("POST", await sitePath(site, "/cmd/stamgr"), {
          body: { cmd: "unblock-sta", mac: normalizeMac(mac) },
        }),
      ),
  );

  server.registerTool(
    "unifi_legacy_block_client",
    {
      description:
        "Block a client from the network by MAC address. It is disconnected immediately and " +
        "cannot reconnect on any SSID until unblocked, and it disappears from " +
        "`unifi_list_clients` — so record the MAC before blocking. Reversed with " +
        "`unifi_legacy_unblock_client`.",
      inputSchema: { site: siteArg, mac: macArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ site, mac }) =>
      wrap(async () =>
        legacy.request("POST", await sitePath(site, "/cmd/stamgr"), {
          body: { cmd: "block-sta", mac: normalizeMac(mac) },
        }),
      ),
  );

  server.registerTool(
    "unifi_legacy_reconnect_client",
    {
      description:
        "Force a client to reconnect by kicking it off its access point. It normally rejoins " +
        "within seconds on its own — this is the usual fix for a device stuck on a distant AP or " +
        "a stale band. It does interrupt whatever that device was doing.",
      inputSchema: { site: siteArg, mac: macArg, confirm: confirmArg },
      // Not idempotent: each call is another disconnection, not a re-assertion
      // of the same state.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ site, mac }) =>
      wrap(async () =>
        legacy.request("POST", await sitePath(site, "/cmd/stamgr"), {
          body: { cmd: "kick-sta", mac: normalizeMac(mac) },
        }),
      ),
  );
};

/**
 * The legacy escape hatch, registered separately so its gating reads in one
 * place. Unlike `unifi_request`, non-GET calls here require `confirm`: the
 * legacy `cmd/*` endpoints are the irreversible ones — adoption, firmware
 * upgrades, forgetting a client — and they take no dry run.
 */
export const registerLegacyRequestTool = (
  server: McpServer,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;
  const methods = allowWrites ? (["GET", "POST", "PUT", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "unifi_legacy_request",
    {
      description:
        "Escape hatch for the undocumented controller API — the operations the official API has " +
        "no equivalent for: port forwarding (`/api/s/<site>/rest/portforward`), device adoption " +
        "and firmware upgrade (`/api/s/<site>/cmd/devmgr`), known and historical clients " +
        "(`rest/user`, `stat/alluser`), DPI statistics, and system info. " +
        "Paths are absolute controller paths and the site segment is the 8-character " +
        "`internalReference`, NOT the UUID — `unifi_list_sites` shows both. " +
        "This API answers errors with HTTP 200 and a `meta.rc` of `error`; that is unwrapped for " +
        "you. Responses can be very large, so pass `attrs` or `_limit` in the query. " +
        (allowWrites
          ? "Writes are ENABLED and every non-GET call requires `confirm: true`, because the " +
            "cmd/* endpoints here are the irreversible ones."
          : "Writes are DISABLED: only GET is permitted."),
      inputSchema: {
        method: z.enum(methods).default("GET").describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe(
            "Absolute controller path starting with `/`, e.g. `/api/s/default/stat/sysinfo` or " +
              "`/api/s/default/rest/portforward`.",
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Query parameters. `attrs` restricts the fields the controller builds and is the " +
              "best way to keep a response small; `_limit`, `_start` and `_sort` are honoured on " +
              "most list endpoints and silently ignored on the rest.",
          ),
        body: z.unknown().optional().describe("JSON request body, for POST and PUT."),
        confirm: z
          .literal(true)
          .optional()
          .describe(
            "Required for any method other than GET. Explicit acknowledgement that this changes " +
              "live network state through an undocumented endpoint with no dry run.",
          ),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body, confirm }) =>
      wrap(async () => {
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`unifi_legacy_request with method ${method}`);
        }
        if (method !== "GET" && confirm !== true) {
          throw new Error(
            `unifi_legacy_request with method ${method} requires \`confirm: true\`. The legacy ` +
              `cmd/* endpoints are irreversible and have no dry run.`,
          );
        }
        assertSafePath(path);
        return legacy.request(method, path, {
          ...(query ? { query: compact(query) } : {}),
          ...(body !== undefined ? { body } : {}),
        });
      }),
  );
};
