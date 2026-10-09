import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { UnifiLegacyClient } from "#/client/legacy";
import { summarizeKnownClient } from "#/client/legacy-shape";
import { eq } from "#/filter";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { compact, siteArg, wrap } from "#/tools/util";
import { atLeast } from "#/version";

type Rec = Record<string, unknown>;

/**
 * The verdicts this tool can reach, and what each one means. `absent` is the
 * important one and the reason the tool exists: a device the console has NEVER
 * recorded, while its owner insists it is trying, is not a shrug — it is a
 * specific diagnosis. Association is what creates a client record, so a device
 * rejected at the 802.11 authentication frame (before association, before the
 * password is ever exchanged) leaves no record anywhere in the API. That is
 * exactly what an orphaned AP-side block looks like from here.
 */
const VERDICTS = {
  connected:
    "Connected right now. If it still misbehaves the problem is above the WiFi layer — check the traffic rules and firewall for its network, not its association.",
  blocked:
    "BLOCKED. This is why it cannot connect. Clear it with unifi_legacy_unblock_client (requires UNIFI_ALLOW_WRITES), then have the device retry.",
  known_offline:
    "Known to the console but not connected. It has associated successfully before, so the credentials and radio are compatible — this is a powered-off, out-of-range or roaming-elsewhere device rather than a configuration problem.",
  absent:
    "NOT KNOWN TO THIS CONSOLE AT ALL — no client record has ever existed for it.\n" +
    "A client record is written on ASSOCIATION, which happens before the password is checked. So if this device is genuinely transmitting, it is being refused at the 802.11 authentication frame, and the API cannot see that: there is no event type for it and no record is created. Two causes are worth ruling out in this order:\n" +
    "  1. An ORPHANED BLOCK on the access points. A block writes the MAC to /etc/persistent/cfg/blocked_sta on every AP; deleting the client from the controller afterwards leaves that file behind, with nothing in the UI to undo it. It survives reboots AND re-provisioning, so force-provisioning does not help. unifi_legacy_unblock_client is safe to call on a MAC the controller has never heard of and clears exactly this — try it first, it costs nothing.\n" +
    "  2. The device never reached the AP: wrong SSID stored, wrong PSK, or out of range.\n" +
    "To tell those apart you need the AP's own syslog, which the gateway already collects. The API cannot answer this; run:\n" +
    "  ssh <gateway> 'grep -a \"<mac>\" /srv/unifi/logs/remote/*.log | tail -20'\n" +
    'A line reading "auth: disallowed by ACL" is cause 1. Silence means cause 2.',
} as const;

/** A MAC in canonical form, or undefined for anything that is not one. */
const macOrUndefined = (value: string): string | undefined => {
  try {
    return normalizeMac(value);
  } catch {
    return undefined;
  }
};

type Port = { idx?: unknown; state?: unknown; poe?: Rec };

const verdictFor = (r: Rec): keyof typeof VERDICTS =>
  r.blocked === true ? "blocked" : r.connectedNow === true ? "connected" : "known_offline";

export const registerDiagnoseTool = (
  server: McpServer,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_diagnose_client",
    {
      title: "UniFi: Diagnose Client",
      description:
        'Answer "why will this device not connect?" for one client, in a single call. Give it a ' +
        "MAC, a name, or a fragment of either — it searches the LIVE clients and the full " +
        "historical roster together, which no other tool does, and returns a verdict with the " +
        "next action rather than raw records. Reach for this whenever someone reports a device " +
        "that cannot get on the WiFi, before any other tool: the most common cause leaves no " +
        "trace in the ordinary client list, so starting with `unifi_list_clients` returns " +
        "nothing and reads misleadingly like an all-clear. For a wired device it also names " +
        "the switch port it was last plugged into and whether that port's PoE can reboot it — " +
        "the only way to find where to power-cycle a device that has gone offline.",
      inputSchema: z.object({
        site: siteArg,
        device: z
          .string()
          .min(2)
          .describe(
            "MAC address, client name, or a distinctive fragment (case-insensitive; matched " +
              "against name, hostname, MAC, vendor and fingerprint). A vendor name is often the " +
              'only handle on an appliance that never had a friendly name — try "husqvarna" ' +
              'rather than "lawnmower".',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, device }) =>
      wrap(async () => {
        const name = await ctx.sites.resolveLegacyName(site);
        const path = (suffix: string) => `/api/s/${encodeURIComponent(name)}${suffix}`;
        const [roster, live] = await Promise.all([
          legacy.request<unknown[]>("GET", path("/rest/user")),
          legacy.request<unknown[]>("GET", path("/stat/sta")).catch(() => [] as unknown[]),
        ]);

        const connected = new Set(
          (Array.isArray(live) ? live : [])
            .map((c) => (c as { mac?: unknown }).mac)
            .filter((m): m is string => typeof m === "string"),
        );
        const now = Date.now();
        const rows = (Array.isArray(roster) ? roster : []).map((r) =>
          summarizeKnownClient(r, now, connected.has(String((r as { mac?: unknown }).mac ?? ""))),
        );

        // A MAC typed in any of the four common spellings must match the
        // canonical one in the roster, or this tool answers "absent" for a
        // device sitting right there — the worst possible failure here.
        const needle = device.toLowerCase().trim();
        const asMac = macOrUndefined(device);
        const matches = rows.filter(
          (r) =>
            (asMac !== undefined && r.mac === asMac) ||
            ["name", "mac", "oui", "fingerprint"].some((k) =>
              String(r[k] ?? "")
                .toLowerCase()
                .includes(needle),
            ),
        );

        if (matches.length === 0) {
          return {
            device,
            verdict: "absent",
            found: false,
            explanation: VERDICTS.absent.replaceAll("<mac>", asMac ?? device),
            searched: { knownClients: rows.length, connectedNow: connected.size },
            blockedCountSiteWide: rows.filter((r) => r.blocked === true).length,
          };
        }

        // Several matches are often on the same switch; look each one up once.
        const switches = new Map<string, Promise<{ id: string; ports: Port[] } | undefined>>();
        const lookUpSwitch = (mac: string) => {
          let pending = switches.get(mac);
          if (!pending) {
            pending = findSwitch(mac).catch(() => undefined);
            switches.set(mac, pending);
          }
          return pending;
        };
        const findSwitch = async (mac: string) => {
          const siteId = await ctx.sites.resolve(site);
          const found = await ctx.client.get<{ data?: { id?: unknown }[] }>(
            ctx.client.sitePath(siteId, "/devices"),
            { filter: eq("macAddress", mac) },
          );
          const id = found.data?.[0]?.id;
          if (typeof id !== "string") return undefined;
          const detail = await ctx.client.get<{ interfaces?: { ports?: Port[] } }>(
            ctx.client.sitePath(siteId, `/devices/${encodeURIComponent(id)}`),
          );
          return { id, ports: detail.interfaces?.ports ?? [] };
        };

        /**
         * Where a wired client was last plugged in, and how to reboot it from
         * there. An offline PoE device has no restart of its own — the port is
         * the only way to it, and nothing else in the API says which one it was.
         */
        const lastPortOf = async (r: Rec): Promise<Rec | undefined> => {
          const switchMac = r.lastUplinkMac;
          const portIdx = r.lastUplinkPort;
          if (r.isWired !== true || typeof switchMac !== "string" || typeof portIdx !== "number") {
            return undefined;
          }
          const out: Rec = compact({ switchName: r.lastUplink, switchMac, portIdx });
          const sw = await lookUpSwitch(switchMac);
          if (!sw) {
            out.note =
              "This switch is not one the console manages (or could not be read), so the port " +
              "cannot be power-cycled from here.";
            return out;
          }
          out.switchId = sw.id;
          const port = sw.ports.find((p) => p.idx === portIdx);
          if (typeof port?.state === "string") out.linkState = port.state;
          const poe = port?.poe;
          out.poe = poe
            ? compact({ standard: poe.standard, enabled: poe.enabled, state: poe.state })
            : null;
          if (poe && poe.enabled !== false && !atLeast(ctx.probe.tier, "clients-plus")) {
            out.note =
              "PoE powers the device from this port, but this console predates the port " +
              "power-cycle API (Network 9.3); cycle it from the UniFi UI.";
            return out;
          }
          if (!poe || poe.enabled === false) {
            out.note = poe
              ? "PoE is disabled on this port, so it is not what powers the device."
              : "This port supplies no PoE, so cycling it cannot reboot the device — it has " +
                "its own power supply to unplug.";
            return out;
          }
          out.powerCycle =
            `unifi_power_cycle_port with deviceId "${sw.id}" and portIdx ${portIdx} reboots ` +
            "whatever is plugged in" +
            (ctx.allowWrites ? "." : " (the tool needs UNIFI_ALLOW_WRITES=1).");
          return out;
        };

        const results = await Promise.all(
          matches.slice(0, 10).map(async (r) => {
            const verdict = verdictFor(r);
            const lastPort = verdict === "blocked" ? undefined : await lastPortOf(r);
            return {
              ...r,
              verdict,
              explanation: VERDICTS[verdict],
              ...(lastPort ? { lastPort } : {}),
            };
          }),
        );

        return {
          device,
          found: true,
          matches: matches.length,
          results,
          blockedCountSiteWide: rows.filter((r) => r.blocked === true).length,
          ...(matches.length > 10 ? { truncated: true } : {}),
        };
      }),
  );
};
