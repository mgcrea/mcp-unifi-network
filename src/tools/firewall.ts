import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { wrapCollected } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, filterArg, limitArg, siteArg, wrap } from "#/tools/util";

/**
 * Firewall tools are READ-ONLY, and not because of the write flag.
 *
 * A firewall policy is the highest-blast-radius object this API exposes: a wrong
 * one locks you out of the very console you are managing it through, there is no
 * undo, and there is no out-of-band recovery short of physical access. So the
 * write path is not offered at all, and the descriptions say so plainly — a
 * model that reads "this server does not modify firewall policies" stops looking
 * rather than reaching for `unifi_request` to do it anyway.
 */
export const registerFirewallTools = (server: McpServer, ctx: ToolContext): void => {
  const { client, sites } = ctx;

  server.registerTool(
    "unifi_list_firewall_zones",
    {
      title: "UniFi: List Firewall Zones",
      description:
        "List the firewall zones on a site — the named groups of networks that zone-based " +
        "policies are written between. Read these first: a policy references zones by id, so " +
        "the ids here are what make `unifi_list_firewall_policies` readable. " +
        "This server never creates or modifies firewall configuration; make those changes in " +
        "the UniFi UI, where a mistake can be undone before it locks you out.",
      inputSchema: { site: siteArg, filter: filterArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ site, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const collected = await client.listAll(
          client.sitePath(siteId, "/firewall/zones"),
          compact({ filter }),
          compact({ limit }),
        );
        return wrapCollected(collected);
      }),
  );

  server.registerTool(
    "unifi_list_firewall_policies",
    {
      title: "UniFi: List Firewall Policies",
      description:
        "List the zone-based firewall policies on a site, with their action, source and " +
        "destination zones, matching criteria and whether each is enabled. Policies are " +
        "evaluated in order, so pass `sourceZoneId` and `destinationZoneId` to see the ordering " +
        "that actually applies between one pair of zones. " +
        "Read-only, deliberately: a wrong policy can lock you out of the console with no undo.",
      inputSchema: {
        site: siteArg,
        sourceZoneId: z
          .string()
          .optional()
          .describe(
            "Zone `id` from `unifi_list_firewall_zones`. Pass with `destinationZoneId` to get " +
              "the evaluation order between that pair rather than the flat list.",
          ),
        destinationZoneId: z
          .string()
          .optional()
          .describe("Zone `id` from `unifi_list_firewall_zones`. Pass with `sourceZoneId`."),
        filter: filterArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, sourceZoneId, destinationZoneId, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        if (Boolean(sourceZoneId) !== Boolean(destinationZoneId)) {
          throw new Error(
            "`sourceZoneId` and `destinationZoneId` must be passed together — ordering is defined " +
              "per zone pair, so one without the other has no meaning.",
          );
        }
        if (sourceZoneId && destinationZoneId) {
          return client.get(client.sitePath(siteId, "/firewall/policies/ordering"), {
            sourceFirewallZoneId: sourceZoneId,
            destinationFirewallZoneId: destinationZoneId,
          });
        }
        const collected = await client.listAll(
          client.sitePath(siteId, "/firewall/policies"),
          compact({ filter }),
          compact({ limit }),
        );
        return wrapCollected(collected);
      }),
  );
};
