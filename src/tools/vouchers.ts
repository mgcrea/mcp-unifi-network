import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { wrapCollected } from "#/client/shape";
import { and, eq, like } from "#/filter";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, filterArg, limitArg, siteArg, wrap } from "#/tools/util";

export const registerVoucherTools = (server: McpServer, ctx: ToolContext): void => {
  const { client, sites, allowWrites } = ctx;

  server.registerTool(
    "unifi_list_vouchers",
    {
      description:
        "List the hotspot guest vouchers on a site, with their code, name, time and data limits, " +
        "how many guests have used each, and when it activates and expires. " +
        "An expired voucher is not deleted automatically — filter with `expired: false` for the " +
        "ones still usable.",
      inputSchema: {
        site: siteArg,
        name: z.string().optional().describe("Match the voucher name, with `*` as a wildcard."),
        expired: z
          .boolean()
          .optional()
          .describe("True for expired vouchers only, false for still-valid ones."),
        filter: filterArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, name, expired, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const built =
          filter ??
          and(
            name ? like("name", name) : undefined,
            expired !== undefined ? eq("expired", expired) : undefined,
          );
        const collected = await client.listAll(
          client.sitePath(siteId, "/hotspot/vouchers"),
          compact({ filter: built }),
          compact({ limit }),
        );
        return wrapCollected(collected);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "unifi_create_vouchers",
    {
      description:
        "Generate hotspot guest vouchers. Each is a code a guest enters on the captive portal to " +
        "get online, bounded by the time, data and rate limits set here. " +
        "The response contains the codes — they are not retrievable in bulk afterwards without " +
        "listing and matching on `name`, so give every batch a distinctive name.",
      inputSchema: {
        site: siteArg,
        name: z
          .string()
          .min(1)
          .describe(
            'Label for the batch, e.g. "Lobby guests 2026-09". Required, and the only practical ' +
              "way to find these vouchers again later — make it distinctive.",
          ),
        timeLimitMinutes: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .describe(
            "How long each voucher grants access once activated, in minutes. Required. " +
              "1440 is one day, 10080 one week.",
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(1)
          // The API allows 1000. Capped lower on purpose: an agent asked for
          // "some vouchers" should not be able to mint a thousand credentials
          // in one call, and 200 is already far beyond any conversational need.
          .describe(
            "How many vouchers to generate (1-200). Defaults to 1. Each is a separate working " +
              "credential, so generate what you will actually hand out.",
          ),
        authorizedGuestLimit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many devices may use each voucher. Omit for unlimited."),
        dataUsageLimitMBytes: z
          .number()
          .int()
          .min(1)
          .max(1_048_576)
          .optional()
          .describe("Total data allowance per voucher in MB. Omit for unlimited."),
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ site, ...body }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        return client.post(client.sitePath(siteId, "/hotspot/vouchers"), compact(body));
      }),
  );

  server.registerTool(
    "unifi_delete_vouchers",
    {
      description:
        "Delete one voucher by id, or every voucher matching a filter. Deleted vouchers stop " +
        "working immediately, including ones a guest is currently connected on, and the codes " +
        "cannot be recovered. " +
        "Exactly one of `voucherId` or `filter` is required — a bulk delete with neither would " +
        "remove every voucher on the site, so it is refused.",
      inputSchema: {
        site: siteArg,
        voucherId: z
          .string()
          .min(1)
          .optional()
          .describe("The voucher's `id` from `unifi_list_vouchers`. Omit when using `filter`."),
        filter: filterArg.describe(
          "Filter selecting the vouchers to delete, e.g. `expired.eq(true)` or " +
            "`name.eq('Lobby guests 2026-09')`. Run `unifi_list_vouchers` with the SAME filter " +
            "first and check the result — this deletes everything it matches.",
        ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ site, voucherId, filter }) =>
      wrap(async () => {
        // Checked before anything is resolved or sent: an unfiltered bulk
        // DELETE here removes every voucher on the site.
        if (Boolean(voucherId) === Boolean(filter)) {
          throw new Error(
            "Pass exactly one of `voucherId` or `filter`. With neither, this would delete every " +
              "voucher on the site; with both, it is ambiguous which one wins.",
          );
        }
        const siteId = await sites.resolve(site);
        return voucherId
          ? client.del(
              client.sitePath(siteId, `/hotspot/vouchers/${encodeURIComponent(voucherId)}`),
            )
          : client.del(client.sitePath(siteId, "/hotspot/vouchers"), { filter: filter as string });
      }),
  );
};
