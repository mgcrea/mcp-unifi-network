import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { UnifiLegacyError, WritesDisabledError } from "#/client/errors";
import type { UnifiLegacyClient } from "#/client/legacy";
import {
  rosterRecordsPastBlocks,
  summarizeKnownClient,
  summarizeLegacyEvent,
  summarizeSystemLogEvent,
} from "#/client/legacy-shape";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { assertSafePath } from "#/tools/request";
import {
  assertNoRedactedSecrets,
  compact,
  confirmArg,
  macArg,
  revealSecretsArg,
  siteArg,
  wrap,
} from "#/tools/util";

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

/** A MAC in canonical form if it is one, otherwise the text as typed. */
const asMacOrText = (value: string): string => {
  try {
    return normalizeMac(value);
  } catch {
    return value.trim();
  }
};

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
      title: "UniFi: Legacy Get Health",
      description:
        "Get the site's subsystem health — WAN, LAN, WLAN, VPN and WWW — with the number of " +
        "adopted, disconnected and pending devices in each, plus current throughput and latency. " +
        'This is the closest thing to a one-call answer to "is anything wrong?", and the ' +
        "official API has no equivalent.",
      inputSchema: z.object({ site: siteArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ site }) =>
      wrap(async () => legacy.request("GET", await sitePath(site, "/stat/health"))),
  );

  server.registerTool(
    "unifi_legacy_list_events",
    {
      title: "UniFi: Legacy List Events",
      description:
        "List recent controller events for a site, newest first — clients joining, leaving " +
        "and roaming between access points (with signal strength and how long they had been " +
        "connected), devices restarting or being adopted, configuration changes and WAN " +
        'transitions. Use this to answer "what happened" questions; the official API exposes ' +
        "no event log at all. Pass `client` to follow one device: it is the way to answer " +
        '"when did this drop off, and has it happened before?". Events are verbose, so keep ' +
        "`limit` low and narrow `within` first.",
      inputSchema: z.object({
        site: siteArg,
        within: withinArg,
        limit: legacyLimitArg,
        client: z
          .string()
          .min(2)
          .optional()
          .describe(
            "Only events mentioning this client: a MAC address in any common format, or a " +
              "fragment of its name. Matched by the console itself, so a filtered call reaches " +
              "further back than a page of everything would.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, within, limit, client }) =>
      wrap(async () => {
        const search = client === undefined ? undefined : asMacOrText(client);

        // UniFi Network 9 replaced `stat/event` with the v2 system log, and the
        // old path answers 404 there. Ask for the new one first and fall back
        // only when the console has never heard of it.
        try {
          const now = Date.now();
          const data = await legacy.request<unknown[]>(
            "POST",
            `/v2/api/site/${encodeURIComponent(await ctx.sites.resolveLegacyName(site))}/system-log/all`,
            {
              // Only `searchText` filters: `macs` and `clientMacs` are accepted
              // and silently ignored, returning every client's events.
              body: compact({
                timestampFrom: now - within * 3_600_000,
                timestampTo: now,
                pageNumber: 0,
                pageSize: limit,
                searchText: search,
              }),
            },
          );
          const rows = Array.isArray(data) ? data : [];
          return {
            data: rows.map(summarizeSystemLogEvent),
            count: rows.length,
            source: "system-log",
          };
        } catch (err) {
          if (!(err instanceof UnifiLegacyError && err.status === 404)) throw err;
        }

        const data = await legacy.request<unknown[]>("GET", await sitePath(site, "/stat/event"), {
          query: { within, _limit: limit, _sort: "-time" },
        });
        // The old endpoint has no search, so the filter applies to the page it returned.
        const rows = (Array.isArray(data) ? data : []).filter(
          (row) =>
            search === undefined ||
            JSON.stringify(row).toLowerCase().includes(search.toLowerCase()),
        );
        return { data: rows.map(summarizeLegacyEvent), count: rows.length, source: "stat/event" };
      }),
  );

  server.registerTool(
    "unifi_legacy_list_alarms",
    {
      title: "UniFi: Legacy List Alarms",
      description:
        "List the site's alarms — the events the controller considers actionable, such as a " +
        "device going down or a rogue access point appearing. On UniFi Network 9 and later " +
        "these are the system log's Critical entries; older consoles keep a separate alarm " +
        "list, where unarchived alarms are the ones still demanding attention. An empty " +
        "result is not a health check: a radio can stop serving clients without raising one.",
      inputSchema: z.object({
        site: siteArg,
        within: z
          .number()
          .int()
          .min(1)
          .max(8760)
          .default(720)
          .describe(
            "How many hours back to look on a system-log console. Defaults to 720 (30 days). " +
              "Older consoles return their alarm list regardless.",
          ),
        archived: z
          .boolean()
          .default(false)
          .describe(
            "True to include archived alarms. Defaults to false — the open ones only. Only " +
              "older consoles archive alarms; the system log has no such state.",
          ),
        limit: legacyLimitArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, within, archived, limit }) =>
      wrap(async () => {
        // Network 9+ answers 404 on `stat/alarm`: alarms moved into the v2
        // system log as its `critical` category. Same pattern as the events
        // tool — ask for the new one, fall back only on a console without it.
        try {
          const now = Date.now();
          const data = await legacy.request<unknown[]>(
            "POST",
            `/v2/api/site/${encodeURIComponent(await ctx.sites.resolveLegacyName(site))}/system-log/critical`,
            {
              body: {
                timestampFrom: now - within * 3_600_000,
                timestampTo: now,
                pageNumber: 0,
                pageSize: limit,
              },
            },
          );
          const rows = Array.isArray(data) ? data : [];
          return {
            data: rows.map(summarizeSystemLogEvent),
            count: rows.length,
            source: "system-log/critical",
          };
        } catch (err) {
          if (!(err instanceof UnifiLegacyError && err.status === 404)) throw err;
        }

        const data = await legacy.request<unknown[]>("GET", await sitePath(site, "/stat/alarm"), {
          query: compact({ archived: archived ? undefined : false, _limit: limit, _sort: "-time" }),
        });
        const rows = Array.isArray(data) ? data : [];
        return { data: rows.map(summarizeLegacyEvent), count: rows.length, source: "stat/alarm" };
      }),
  );

  server.registerTool(
    "unifi_legacy_list_known_clients",
    {
      title: "UniFi: Legacy List Known Clients",
      description:
        "List every client the controller has EVER seen on a site, connected or not, with " +
        "whether each is blocked. This is the only way to answer questions about devices that " +
        "are not currently connected: `unifi_list_clients` returns the live roster only, so a " +
        "blocked or long-absent device is invisible to it. Use this to find out why a device " +
        'will not connect, to audit what has been blocked, or to find "that thing I saw last ' +
        'summer". `firstSeenWithinDays` answers "did anything NEW join recently?". The reply ' +
        "always carries `blockedCount` for the whole site regardless of which filters you pass, " +
        "so one call settles whether anything is blocked at all.",
      inputSchema: z.object({
        site: siteArg,
        blocked: z
          .enum(["any", "only", "everBlocked"])
          .default("any")
          .describe(
            'Which clients to return. "only" is those blocked right now. "everBlocked" also ' +
              "includes clients that were blocked and later unblocked — older controllers keep " +
              'that mark, and it is what answers "did I block this by accident once?". UniFi ' +
              "Network 11 does not, and refuses it with an explanation. " +
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
        firstSeenWithinDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Only clients the console had never seen before this many days ago — i.e. NEW " +
              'devices. This is the one to reach for on "did anything new join my network?": ' +
              "unlike the other filters it keys off first sighting, so a device that joined " +
              "last night and has been online since still matches. Expect noise from phones " +
              "using MAC randomisation, which mint a fresh address per network; those show as " +
              "unnamed with an empty vendor.",
          ),
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
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, blocked, search, notSeenForDays, seenWithinDays, firstSeenWithinDays, limit }) =>
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
        const roster = Array.isArray(data) ? data : [];
        const recordsPastBlocks = rosterRecordsPastBlocks(roster);
        if (blocked === "everBlocked" && !recordsPastBlocks) {
          throw new Error(
            'This console cannot answer "everBlocked": it reports `blocked` on every known ' +
              "client (UniFi Network 11 does), so a past block leaves no trace in the roster. " +
              'Use `blocked: "only"` for what is blocked now, or unifi_legacy_list_events with ' +
              "the client to look for a block in the event history.",
          );
        }
        const rows = roster.map((row) =>
          summarizeKnownClient(
            row,
            now,
            connected.has(String((row as { mac?: unknown }).mac ?? "")),
            recordsPastBlocks,
          ),
        );

        // Counted across every known client, never across the filtered subset —
        // a `blockedCount` that moved with the filters would make an empty
        // filtered result read as "nothing is blocked".
        const blockedCount = rows.filter((row) => row.blocked === true).length;
        // null, not a count, where the roster cannot tell — a number here would
        // read as "every device you own was blocked once".
        const everBlockedCount = recordsPastBlocks
          ? rows.filter((row) => row.wasEverBlocked === true).length
          : null;

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
          if (firstSeenWithinDays !== undefined) {
            const first =
              typeof row.firstSeen === "string" ? Date.parse(row.firstSeen) : Number.NaN;
            if (Number.isNaN(first)) return false;
            if ((now - first) / 86_400_000 > firstSeenWithinDays) return false;
          }
          if (!needle) return true;
          return ["name", "mac", "oui", "fingerprint"]
            .map((key) => String(row[key] ?? "").toLowerCase())
            .some((value) => value.includes(needle));
        });

        // Newest-first when the question is "what is new", most-recently-seen
        // first otherwise. Sorting by the wrong key buries the answer below the
        // limit, which reads as "nothing found".
        if (firstSeenWithinDays !== undefined) {
          matched.sort(
            (a, b) => Date.parse(String(b.firstSeen ?? 0)) - Date.parse(String(a.firstSeen ?? 0)),
          );
        } else
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
      title: "UniFi: Legacy Unblock Client",
      description:
        "Remove a client's block, letting it back onto the network. Safe to call on a client " +
        "that was never blocked. Identified by MAC address, not by the UUID the official API " +
        "uses — a blocked client is not in `unifi_list_clients`, so its MAC is the only handle.",
      inputSchema: z.object({ site: siteArg, mac: macArg }),
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
      title: "UniFi: Legacy Block Client",
      description:
        "Block a client from the network by MAC address. It is disconnected immediately and " +
        "cannot reconnect on any SSID until unblocked, and it disappears from " +
        "`unifi_list_clients` — so record the MAC before blocking. Reversed with " +
        "`unifi_legacy_unblock_client`.",
      inputSchema: z.object({ site: siteArg, mac: macArg, confirm: confirmArg }),
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
      title: "UniFi: Legacy Reconnect Client",
      description:
        "Force a client to reconnect by kicking it off its access point. It normally rejoins " +
        "within seconds on its own — this is the usual fix for a device stuck on a distant AP or " +
        "a stale band. It does interrupt whatever that device was doing.",
      inputSchema: z.object({ site: siteArg, mac: macArg, confirm: confirmArg }),
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
      title: "UniFi: Legacy Request",
      description:
        "Escape hatch for the undocumented controller API — the operations the official API has " +
        "no equivalent for: port forwarding (`/api/s/<site>/rest/portforward`), device adoption " +
        "and firmware upgrade (`/api/s/<site>/cmd/devmgr`), known and historical clients " +
        "(`rest/user`, `stat/alluser`), DPI statistics, and system info. " +
        "Paths are absolute controller paths and the site segment is the 8-character " +
        "`internalReference`, NOT the UUID — `unifi_list_sites` shows both. " +
        "This API answers errors with HTTP 200 and a `meta.rc` of `error`; that is unwrapped for " +
        "you. Responses can be very large: pass `fields` to keep only the keys you need — " +
        "`attrs` in the query is advisory, and current consoles ignore it on `stat/sta` and " +
        "`stat/device`. Passphrases and keys come back masked unless `revealSecrets` is set. " +
        (allowWrites
          ? "Writes are ENABLED and every non-GET call requires `confirm: true`, because the " +
            "cmd/* endpoints here are the irreversible ones."
          : "Writes are DISABLED: only GET is permitted."),
      inputSchema: z.object({
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
            "Query parameters. `attrs` asks the controller to build fewer fields, but it is " +
              "advisory — current consoles ignore it on `stat/sta` and `stat/device` — so use " +
              "`fields` for a guaranteed cut. `_limit`, `_start` and `_sort` are honoured on " +
              "most list endpoints and silently ignored on the rest.",
          ),
        fields: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Top-level keys to keep on each returned record, applied here after the response " +
              'arrives, so it always works. E.g. `["name","mac","radio_table_stats"]` on ' +
              "`stat/device` turns ~240 KB into a few. Keys a record lacks are skipped.",
          ),
        body: z.unknown().optional().describe("JSON request body, for POST and PUT."),
        confirm: z
          .literal(true)
          .optional()
          .describe(
            "Required for any method other than GET. Explicit acknowledgement that this changes " +
              "live network state through an undocumented endpoint with no dry run.",
          ),
        revealSecrets: revealSecretsArg,
      }),
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body, confirm, fields, revealSecrets }) =>
      wrap(
        async () => {
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
          if (body !== undefined) assertNoRedactedSecrets(body);
          const data = await legacy.request(method, path, {
            ...(query ? { query: compact(query) } : {}),
            ...(body !== undefined ? { body } : {}),
          });
          return fields ? projectFields(data, fields) : data;
        },
        { revealSecrets },
      ),
  );
};

/** Keep only `fields` on each record of a list, or on a lone record. */
const projectFields = (data: unknown, fields: readonly string[]): unknown => {
  const project = (row: unknown): unknown => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const source = row as Record<string, unknown>;
    return Object.fromEntries(fields.filter((key) => key in source).map((k) => [k, source[k]]));
  };
  return Array.isArray(data) ? data.map(project) : project(data);
};
