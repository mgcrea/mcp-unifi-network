import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { annotateSite } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";
import { floorOf, TIERS, atLeast } from "#/version";

export const registerSiteTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "unifi_list_sites",
    {
      title: "UniFi: List Sites",
      description:
        "List the sites on this console with ALL THREE of their identifiers: the `id` (a UUID, " +
        "which is what this API's paths take), the `internalReference` (the legacy 8-character " +
        'name such as "default", which the unifi_legacy_* tools take) and the display `name`. ' +
        "Every other tool accepts any of the three for its `site` argument, so this is mostly " +
        "useful when a site cannot be resolved or when you need the legacy name.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const sites = await ctx.sites.list();
        return { data: sites.map(annotateSite), totalCount: sites.length };
      }),
  );

  server.registerTool(
    "unifi_get_console_info",
    {
      title: "UniFi: Get Console Info",
      description:
        "Report the console's UniFi Network version and which tools it supports. This API gained " +
        "most of its endpoints in Network 10.0, so on an older console a large part of the tool " +
        "set simply does not exist. Call this when a tool is missing or returns a 404 — it names " +
        "the version each capability needs and lists what is gated off here.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const { probe } = ctx;
        const gatedOff = TIERS.filter((tier) => !atLeast(probe.tier, tier)).map((tier) => ({
          tier,
          needs_version: floorOf(tier),
          unlocks: CAPABILITY_BY_TIER[tier],
        }));
        return {
          application_version: probe.appVersion ?? null,
          tier: probe.tier,
          version_source: probe.versionSource,
          ...(probe.unreachable ? { unreachable: probe.unreachable } : {}),
          integration_path: probe.pathPrefix,
          sites: probe.sites.length,
          ...(gatedOff.length > 0
            ? { gated_off: gatedOff }
            : { gated_off: [], note: "Every capability this server wraps is available here." }),
        };
      }),
  );
};

/** What each tier unlocks, in the words a caller would use. */
const CAPABILITY_BY_TIER: Record<string, string> = {
  core: "sites, devices, clients, device restart and statistics",
  "clients-plus": "client details, guest authorization, port power-cycling, hotspot vouchers",
  "network-config": "networks, WiFi broadcasts, firewall zones and policies",
  routing: "routing additions",
  full: "switch stacks, LAG, VPN, RADIUS, WAN interfaces and device tags",
};
