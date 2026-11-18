import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { UnifiLegacyClient } from "#/client/legacy";
import type { SeriesRow, StatsEngine } from "#/client/stats";
import { findHungRadios, formatMinutes, summarizeWan } from "#/client/stats-detect";
import type { WanSummary } from "#/client/stats-detect";
import { BUCKET_MS } from "#/client/stats-rollup";
import type { ToolContext } from "#/tools/index";
import { siteArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** One legacy read: the records it yielded, and whether the console answered at all. */
type Read = { rows: Rec[]; ok: boolean };

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Findings are ranked by what they cost when wrong, not by which subsystem they
 * came from — a reader who has to re-sort the list will skim past the one that
 * mattered. `warn` means "look at this today"; `note` means "true, and probably
 * deliberate".
 */
type Finding = { severity: "warn" | "note"; area: string; detail: string };

type History = { wireless: SeriesRow[]; wan: SeriesRow[] } | { error: string };

/** Local wall-clock HH:MM, the way the person reading the finding tells time. */
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/**
 * The last 24 h from the statistics engine. Never rejects: history is an
 * extra, and a View Only key or a timeout must not cost the live checks.
 */
const readHistory = async (stats: StatsEngine, legacyName: string): Promise<History> => {
  try {
    const siteId = await stats.siteId(legacyName);
    const [wireless, wan] = await Promise.all([
      stats.series({
        schema: "wirelessBySiteByDevice",
        siteId,
        period: "DAY",
        values: ["distinctClientCount"],
        nested: "byRadioBand",
        // Everything the detector reads, and nothing else: unnarrowed, a day of
        // five APs is 2.3 MB, and the legacy transport refuses 5 MB.
        nestedValues: ["distinctClientCount", "rxBytes", "txBytes", "avgTotalCuPct"],
      }),
      stats.series({
        schema: "wanBySite",
        siteId,
        period: "DAY",
        values: [
          "rxBytes",
          "txBytes",
          "avgAvailabilityPct",
          "avgLatencyMs",
          "maxLatencyMs",
          "failoverS",
        ],
      }),
    ]);
    return { wireless, wan };
  } catch (err) {
    return { error: describe(err) };
  }
};

export const registerHealthTool = (
  server: McpServer,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
  stats?: StatsEngine,
): void => {
  server.registerTool(
    "unifi_health_check",
    {
      title: "UniFi: Health Check",
      description:
        'One-call answer to "is my network OK?" — subsystem health (WAN, LAN, WLAN, VPN, ' +
        "internet latency), device firmware and adoption state, WiFi security posture, blocked " +
        "clients, and any configuration contradictions this server resolved at startup. On " +
        "Network 11 it also reads the last 24 h of history, which catches what no live reading " +
        "shows: a 5 GHz radio that broadcasts but has carried nothing for half an hour or more " +
        "(a firmware hang that sends every client to 2.4 GHz), and WAN availability, failover " +
        "and latency over the day. Returns " +
        "a ranked findings list rather than five raw payloads, so a clean network is a short " +
        "answer. Use it for open-ended health, audit or 'anything wrong?' questions; use " +
        "unifi_diagnose_client instead when a specific device is the complaint.",
      inputSchema: z.object({ site: siteArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ site }) =>
      wrap(async () => {
        const name = await ctx.sites.resolveLegacyName(site);
        const path = (suffix: string) => `/api/s/${encodeURIComponent(name)}${suffix}`;

        const findings: Finding[] = [];
        const add = (severity: Finding["severity"], area: string, detail: string) =>
          findings.push({ severity, area, detail });

        /**
         * One read, degrading to an empty list but never to silence.
         *
         * These four used to be `.catch(() => [])`, which made this the only
         * tool here incapable of reporting a broken transport: with every call
         * rejected, nothing reached `findings`, and `ok` — an `every()` over an
         * empty array — came back `true`. A console answering 401 to everything
         * reported as a healthy network, which is the exact opposite of what
         * this tool is called to find out. Degrading is still right, because one
         * dead endpoint must not cost the other three; degrading QUIETLY was the
         * bug. The rejection already carries its own remedy from
         * `UnifiLegacyError` — pass it through rather than restating it.
         */
        const read = async (label: string, suffix: string): Promise<Read> => {
          try {
            const data = await legacy.request<unknown[]>("GET", path(suffix));
            return { rows: (Array.isArray(data) ? data : []).filter(isRec), ok: true };
          } catch (err) {
            add(
              "warn",
              "transport",
              `Could not read ${label} from ${path(suffix)} — ${describe(err)}`,
            );
            return { rows: [], ok: false };
          }
        };

        const history = stats ? readHistory(stats, name) : undefined;
        const [health, devices, wlans, roster] = await Promise.all([
          read("subsystem health", "/stat/health"),
          read("the device list", "/stat/device"),
          read("the WLAN configuration", "/rest/wlanconf"),
          read("the known-client roster", "/rest/user"),
        ]);

        const subsystems = health.rows;
        for (const s of subsystems) {
          const sub = String(s.subsystem ?? "?");
          if (s.status !== "ok") add("warn", sub, `Subsystem status is "${String(s.status)}".`);
          if (num(s.num_disconnected) > 0) {
            add("warn", sub, `${num(s.num_disconnected)} adopted device(s) disconnected.`);
          }
          if (num(s.num_pending) > 0) {
            add("note", sub, `${num(s.num_pending)} device(s) pending adoption.`);
          }
          if (sub === "www" && num(s.latency) > 100) {
            add("warn", "www", `Internet latency ${num(s.latency)} ms.`);
          }
        }

        const devs = devices.rows;
        const upgradable = devs.filter((d) => d.upgradable === true);
        if (upgradable.length > 0) {
          add(
            "note",
            "firmware",
            `${upgradable.length} device(s) have a firmware update: ${upgradable
              .map((d) => String(d.name ?? d.mac))
              .join(", ")}.`,
          );
        }
        for (const offline of devs.filter((dev) => dev.state !== 1)) {
          add(
            "warn",
            "devices",
            `"${String(offline.name ?? offline.mac)}" is not online (state ${String(offline.state)}).`,
          );
        }

        const nets = wlans.rows.filter((w) => w.name);
        for (const w of nets) {
          const ssid = String(w.name);
          if (w.enabled === false) {
            // Worth surfacing precisely because it is invisible from the client
            // side: anything provisioned onto this SSID simply stops finding it.
            add(
              "note",
              "wifi",
              `SSID "${ssid}" is disabled or paused — devices stored on it cannot connect.`,
            );
          } else if (w.security === "open") {
            add("warn", "wifi", `SSID "${ssid}" is OPEN (no encryption).`);
          } else if (w.wpa_mode === "wpa1" || w.wpa_enc === "tkip") {
            add(
              "warn",
              "wifi",
              `SSID "${ssid}" uses deprecated ${String(w.wpa_mode)}/${String(w.wpa_enc)}.`,
            );
          }
          if (w.mac_filter_enabled === true) {
            add(
              "note",
              "wifi",
              `SSID "${ssid}" has a MAC filter (policy ${String(w.mac_filter_policy)}) — a device missing from it cannot join.`,
            );
          }
        }

        const clients = roster.rows;
        const blocked = clients.filter((c) => c.blocked === true);
        if (blocked.length > 0) {
          add(
            "note",
            "clients",
            `${blocked.length} client(s) blocked: ${blocked
              .map((c) => String(c.name ?? c.hostname ?? c.mac))
              .join(
                ", ",
              )}. A blocked client is refused before association and appears in no live list.`,
          );
        }

        let wan24h: WanSummary | null | undefined;
        if (history) {
          const past = await history;
          if ("error" in past) {
            add("note", "history", `24 h history unavailable — ${past.error}`);
            wan24h = null;
          } else {
            const names = new Map(
              devs
                .filter((d) => typeof d.mac === "string")
                .map((d) => [String(d.mac).toLowerCase(), String(d.name ?? d.mac)]),
            );
            const bucketMs = BUCKET_MS.DAY;
            for (const run of findHungRadios(past.wireless, { bucketMs })) {
              const label = names.get(run.mac) ?? run.mac;
              if (run.ongoing) {
                add(
                  "warn",
                  "wifi",
                  `"${label}" 5 GHz has carried nothing for ${formatMinutes(run.minutes)} (since ` +
                    `${clock(run.fromMs)}) while 2.4 GHz served up to ${run.ngClientsMax} ` +
                    `client(s) — this matches a hung radio. Restart the AP (unifi_restart_device).`,
                );
              } else {
                add(
                  "note",
                  "wifi",
                  `"${label}" 5 GHz was silent ${clock(run.fromMs)}–` +
                    `${clock(run.toMs + bucketMs)} (${formatMinutes(run.minutes)}) with clients on ` +
                    `2.4 GHz, then recovered.`,
                );
              }
            }
            wan24h = summarizeWan(past.wan);
            const availability = wan24h?.availabilityPct ?? null;
            const latency = wan24h?.avgLatencyMs ?? null;
            if (availability !== null && availability < 99.5) {
              add("warn", "wan", `24 h WAN availability ${availability}% (below 99.5%).`);
            }
            if (wan24h && wan24h.failoverS > 0) {
              add("note", "wan", `WAN failed over for ${wan24h.failoverS} s in the last 24 h.`);
            }
            if (latency !== null && latency > 100) {
              add("warn", "wan", `24 h average WAN latency ${latency} ms.`);
            }
          }
        }

        for (const issue of ctx.config.issues) add("warn", "config", issue);
        if (ctx.probe.unreachable) {
          add(
            "warn",
            "config",
            `Console probe failed (${ctx.probe.unreachable}); tool set assumed.`,
          );
        }

        const order = { warn: 0, note: 1 } as const;
        findings.sort((a, b) => order[a.severity] - order[b.severity]);

        const unavailable = Object.entries({ health, devices, wlans, roster })
          .filter(([, r]) => !r.ok)
          .map(([key]) => key);

        return {
          // `every` over an empty array is `true`, so a run in which nothing
          // could be read must never reach this as a clean sweep. Each failed
          // read files its own `warn` above, and `unavailable` names them.
          ok: unavailable.length === 0 && findings.every((f) => f.severity !== "warn"),
          ...(unavailable.length > 0 ? { unavailable } : {}),
          summary: {
            // `null`, not `{}` or `0`. "Could not read the device list" and
            // "this console has no devices" are different answers, and
            // collapsing them is precisely how the broken case came to look
            // identical to the healthy one.
            subsystems: health.ok
              ? Object.fromEntries(subsystems.map((s) => [String(s.subsystem), String(s.status)]))
              : null,
            devices: devices.ok ? { total: devs.length, upgradable: upgradable.length } : null,
            wifi: wlans.ok
              ? { ssids: nets.length, enabled: nets.filter((w) => w.enabled !== false).length }
              : null,
            clients: roster.ok ? { known: clients.length, blocked: blocked.length } : null,
            consoleVersion: ctx.probe.appVersion ?? null,
            // Absent below Network 11; `null` when the engine could not answer
            // or held no WAN points — not the same as a 0-byte day.
            ...(wan24h === undefined ? {} : { wan24h }),
          },
          findings,
        };
      }),
  );
};
