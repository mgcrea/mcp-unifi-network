import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { summarizeClient, wrapCollected } from "#/client/shape";
import { and, eq, ge, like } from "#/filter";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { clientIdArg, compact, confirmArg, filterArg, limitArg, siteArg, wrap } from "#/tools/util";
import { atLeast } from "#/version";

const typeArg = z
  .enum(["WIRED", "WIRELESS", "VPN", "TELEPORT"])
  .optional()
  .describe("Connection type to filter by. Omit for all types.");

export const registerClientTools = (server: McpServer, ctx: ToolContext): void => {
  const { client, sites, allowWrites, probe } = ctx;

  server.registerTool(
    "unifi_list_clients",
    {
      description:
        "List the clients currently connected to a site — the devices on your network right now, " +
        "not the historical list. Each entry carries the client `id` (a UUID the other client " +
        "tools take), its name, type, IP, MAC and when it connected. " +
        "Filtering happens on the console, so a filtered call is cheaper than reading pages and " +
        "discarding them here.",
      inputSchema: {
        site: siteArg,
        type: typeArg,
        name: z
          .string()
          .optional()
          .describe('Match the client name, with `*` as a wildcard — e.g. "*iphone*".'),
        connectedSince: z
          .string()
          .optional()
          .describe(
            "Only clients connected at or after this ISO 8601 timestamp, " +
              'e.g. "2026-08-30T00:00:00Z".',
          ),
        filter: filterArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, type, name, connectedSince, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const built =
          filter ??
          and(
            type ? eq("type", type) : undefined,
            name ? like("name", name) : undefined,
            connectedSince ? ge("connectedAt", connectedSince) : undefined,
          );
        const collected = await client.listAll(
          client.sitePath(siteId, "/clients"),
          compact({ filter: built }),
          compact({ limit }),
        );
        return wrapCollected(collected, summarizeClient);
      }),
  );

  if (atLeast(probe.tier, "clients-plus")) {
    server.registerTool(
      "unifi_get_client",
      {
        description:
          "Get the full detail of one connected client by its `id` from `unifi_list_clients`. " +
          "Returns everything the console knows about that session, including its uplink device " +
          "and guest-access state.",
        inputSchema: { site: siteArg, clientId: clientIdArg },
        annotations: { readOnlyHint: true },
      },
      async ({ site, clientId }) =>
        wrap(async () => {
          const siteId = await sites.resolve(site);
          return summarizeClient(
            await client.get(client.sitePath(siteId, `/clients/${encodeURIComponent(clientId)}`)),
          );
        }),
    );
  }

  if (!allowWrites) return;

  if (atLeast(probe.tier, "clients-plus")) {
    server.registerTool(
      "unifi_authorize_guest",
      {
        description:
          "Grant a client access through the guest portal without it entering a voucher or " +
          "accepting the terms. Use this to let someone straight onto the guest network. " +
          "Reversed with `unifi_unauthorize_guest`.",
        inputSchema: {
          site: siteArg,
          clientId: clientIdArg,
          timeLimitMinutes: z
            .number()
            .int()
            .min(1)
            .max(1_000_000)
            .optional()
            .describe(
              "How long the authorization lasts, in minutes. Omit to use the site's guest " +
                "policy default.",
            ),
          dataUsageLimitMBytes: z
            .number()
            .int()
            .min(1)
            .max(1_048_576)
            .optional()
            .describe("Total data allowance in MB before access is revoked. Omit for unlimited."),
          rxRateLimitKbps: z
            .number()
            .int()
            .min(2)
            .max(100_000)
            .optional()
            .describe("Download rate cap in Kbps. Omit for uncapped."),
          txRateLimitKbps: z
            .number()
            .int()
            .min(2)
            .max(100_000)
            .optional()
            .describe("Upload rate cap in Kbps. Omit for uncapped."),
        },
        // Grants access rather than removing it, and re-running it simply
        // re-grants — so not destructive, and idempotent.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ site, clientId, ...limits }) =>
        wrap(async () => {
          const siteId = await sites.resolve(site);
          return client.post(
            client.sitePath(siteId, `/clients/${encodeURIComponent(clientId)}/actions`),
            { action: "AUTHORIZE_GUEST_ACCESS", ...compact(limits) },
          );
        }),
    );

    server.registerTool(
      "unifi_unauthorize_guest",
      {
        description:
          "Revoke a client's guest authorization, cutting its access immediately. This " +
          "disconnects a real person mid-session — there is no grace period and no notification.",
        inputSchema: { site: siteArg, clientId: clientIdArg, confirm: confirmArg },
        // destructiveHint means "destroys something that existed", and a live
        // network session for a real person is exactly that.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ site, clientId }) =>
        wrap(async () => {
          const siteId = await sites.resolve(site);
          return client.post(
            client.sitePath(siteId, `/clients/${encodeURIComponent(clientId)}/actions`),
            { action: "UNAUTHORIZE_GUEST_ACCESS" },
          );
        }),
    );
  }
};

/** Exported for the legacy tools, which key on MAC rather than client id. */
export const toMac = normalizeMac;
