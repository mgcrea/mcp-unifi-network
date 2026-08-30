import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { ToolContext } from "#/tools/index";
import { compact, wrap } from "#/tools/util";

/**
 * Reject anything that could leave this API, or climb out of it. An absolute
 * URL here would send the API key to whatever host the caller named.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z]+:\/\//i.test(path)) {
    throw new Error(
      "`path` must be a path relative to the Integration API root, not a full URL — " +
        "e.g. `/sites` or `/sites/<uuid>/devices`.",
    );
  }
  if (!path.startsWith("/")) {
    throw new Error("`path` must start with `/`, e.g. `/sites`.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` must not contain `..` segments.");
  }
};

export const registerRequestTool = (server: McpServer, ctx: ToolContext): void => {
  const { client, allowWrites } = ctx;
  const methods = allowWrites
    ? (["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    : (["GET"] as const);

  server.registerTool(
    "unifi_request",
    {
      description:
        "Escape hatch: call any Integration API endpoint directly, for the parts of the API this " +
        "server does not wrap — switch stacks, LAG, VPN servers, RADIUS profiles, WAN " +
        "interfaces, device tags, ACL rules, DNS policies and the DPI reference tables. " +
        "Paths are relative to the API root, so `/sites` and `/sites/<uuid>/wans`, and the site " +
        "must be a real UUID here — this tool does NOT resolve site names, so get one from " +
        "`unifi_list_sites` first. " +
        (allowWrites
          ? "Writes are ENABLED, so POST, PUT, PATCH and DELETE are permitted. There is no " +
            "confirmation step on this tool because it has no fixed subject — check the path and " +
            "body before you call it, and prefer a purpose-built tool wherever one exists."
          : "Writes are DISABLED: only GET is permitted. Set UNIFI_ALLOW_WRITES=1 to allow " +
            "mutations, which also registers the purpose-built write tools."),
      inputSchema: {
        method: z
          .enum(methods)
          .default("GET")
          .describe(
            allowWrites
              ? "HTTP method. Anything other than GET changes live network configuration."
              : "HTTP method. Only GET is available while writes are disabled.",
          ),
        path: z
          .string()
          .min(1)
          .describe(
            "Path relative to the Integration API root, starting with `/` — e.g. `/info`, " +
              "`/sites`, `/sites/<site-uuid>/wans`. Not a full URL.",
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. `{"limit": 50, "filter": "state.eq(\'OFFLINE\')"}`.'),
        body: z
          .unknown()
          .optional()
          .describe("JSON request body, for POST, PUT and PATCH. Sent verbatim."),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, body }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`unifi_request with method ${method}`);
        }
        assertSafePath(path);
        return client.request(method, path, {
          ...(query ? { query: compact(query) } : {}),
          ...(body !== undefined ? { body } : {}),
        });
      }),
  );
};
