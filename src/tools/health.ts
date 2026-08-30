import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { UnifiLegacyClient } from "#/client/legacy";
import type { ToolContext } from "#/tools/index";
import { siteArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * Findings are ranked by what they cost when wrong, not by which subsystem they
 * came from — a reader who has to re-sort the list will skim past the one that
 * mattered. `warn` means "look at this today"; `note` means "true, and probably
 * deliberate".
 */
type Finding = { severity: "warn" | "note"; area: string; detail: string };

export const registerHealthTool = (
  server: McpServer,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_health_check",
    {
      title: "UniFi: Health Check",
      description:
        'One-call answer to "is my network OK?" — subsystem health (WAN, LAN, WLAN, VPN, ' +
        "internet latency), device firmware and adoption state, WiFi security posture, blocked " +
        "clients, and any configuration contradictions this server resolved at startup. Returns " +
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
        const nothing = [] as unknown[];
        const [health, devices, wlans, roster] = await Promise.all([
          legacy.request<unknown[]>("GET", path("/stat/health")).catch(() => nothing),
          legacy.request<unknown[]>("GET", path("/stat/device")).catch(() => nothing),
          legacy.request<unknown[]>("GET", path("/rest/wlanconf")).catch(() => nothing),
          legacy.request<unknown[]>("GET", path("/rest/user")).catch(() => nothing),
        ]);

        const findings: Finding[] = [];
        const add = (severity: Finding["severity"], area: string, detail: string) =>
          findings.push({ severity, area, detail });

        const subsystems = (health as Rec[]).filter(isRec);
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

        const devs = (devices as Rec[]).filter(isRec);
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

        const nets = (wlans as Rec[]).filter(isRec).filter((w) => w.name);
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

        const clients = (roster as Rec[]).filter(isRec);
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

        return {
          ok: findings.every((f) => f.severity !== "warn"),
          summary: {
            subsystems: Object.fromEntries(
              subsystems.map((s) => [String(s.subsystem), String(s.status)]),
            ),
            devices: { total: devs.length, upgradable: upgradable.length },
            wifi: { ssids: nets.length, enabled: nets.filter((w) => w.enabled !== false).length },
            clients: { known: clients.length, blocked: blocked.length },
            consoleVersion: ctx.probe.appVersion ?? null,
          },
          findings,
        };
      }),
  );
};
