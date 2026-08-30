import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { wrapCollected } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, filterArg, limitArg, siteArg, wrap } from "#/tools/util";

/**
 * Networks and WiFi broadcasts are READ-ONLY here.
 *
 * Both are reachable for writing through `unifi_request`, deliberately: changing
 * a VLAN or an SSID takes a large nested body that a model gets wrong on the
 * first attempt, and a wrong one drops every client on that network. Reading
 * them is what a conversation actually needs.
 */
export const registerNetworkTools = (server: McpServer, ctx: ToolContext): void => {
  const { client, sites } = ctx;

  server.registerTool(
    "unifi_list_networks",
    {
      title: "UniFi: List Networks",
      description:
        "List the networks (VLANs) configured on a site — their name, VLAN id, subnet, DHCP " +
        "settings and purpose. Read-only: this server does not create or modify networks, " +
        "because a wrong subnet or VLAN id disconnects every client on it with no undo. Make " +
        "those changes in the UniFi UI.",
      inputSchema: z.object({ site: siteArg, filter: filterArg, limit: limitArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const collected = await client.listAll(
          client.sitePath(siteId, "/networks"),
          compact({ filter }),
          compact({ limit }),
        );
        return wrapCollected(collected);
      }),
  );

  server.registerTool(
    "unifi_list_wlans",
    {
      title: "UniFi: List WLANs",
      description:
        "List the WiFi broadcasts (SSIDs) on a site, with the network each is bridged to, its " +
        "security mode, band and whether it is enabled. Read-only for the same reason as " +
        "networks: a bad SSID change takes every wireless client offline at once.",
      inputSchema: z.object({ site: siteArg, filter: filterArg, limit: limitArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ site, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const collected = await client.listAll(
          client.sitePath(siteId, "/wifi/broadcasts"),
          compact({ filter }),
          compact({ limit }),
        );
        return wrapCollected(collected);
      }),
  );
};
