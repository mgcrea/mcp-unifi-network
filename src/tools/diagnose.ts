import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { UnifiLegacyClient } from "#/client/legacy";
import { summarizeKnownClient } from "#/client/legacy-shape";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { siteArg, wrap } from "#/tools/util";

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
        "nothing and reads misleadingly like an all-clear.",
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
        const asMac = /[0-9a-f]{2}[:.-]?/i.test(device) ? normalizeMac(device) : undefined;
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

        return {
          device,
          found: true,
          matches: matches.length,
          results: matches.slice(0, 10).map((r) => ({
            ...r,
            verdict: verdictFor(r),
            explanation: VERDICTS[verdictFor(r)],
          })),
          blockedCountSiteWide: rows.filter((r) => r.blocked === true).length,
          ...(matches.length > 10 ? { truncated: true } : {}),
        };
      }),
  );
};
