import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { UnifiLegacyClient } from "#/client/legacy";
import type { Probe } from "#/client/probe";
import type { SiteResolver } from "#/client/sites";
import type { UnifiClient } from "#/client/unifi";
import { integrationReady, legacyReady } from "#/config";
import type { Config } from "#/config";
import { registerClientTools } from "#/tools/clients";
import { registerDeviceTools } from "#/tools/devices";
import { registerFirewallTools } from "#/tools/firewall";
import { registerLegacyRequestTool, registerLegacyTools } from "#/tools/legacy";
import { registerNetworkTools } from "#/tools/network";
import { registerRequestTool } from "#/tools/request";
import { registerSiteTools } from "#/tools/sites";
import { registerStatusTool } from "#/tools/status";
import { registerVoucherTools } from "#/tools/vouchers";
import { atLeast } from "#/version";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see UNIFI_ALLOW_WRITES. */
  allowWrites: boolean;
  /** What the startup probe learned, or `ASSUMED_PROBE` when it never ran. */
  probe: Probe;
  client: UnifiClient;
  sites: SiteResolver;
  integrationBaseUrl: string | undefined;
};

export type RegisterOptions = {
  legacy?: UnifiLegacyClient | undefined;
};

/**
 * All capability decisions live here, so "why can I not call X" is answered by
 * reading one file.
 *
 * Three independent gates, and none of them is a refusal:
 *
 *  1. **Credentials.** `unifi_auth_status` is registered first and
 *     unconditionally, so an unconfigured server is still a useful one rather
 *     than a connection that closes with its own error message swallowed.
 *  2. **Console version.** This API gained most of its endpoints in Network
 *     10.0; registering them against a 9.3 console would offer 30-odd tools that
 *     can only ever 404.
 *  3. **Writes.** Mutating tools are registered inside their domain modules
 *     after an `if (!allowWrites) return;`, so with the flag off they are not
 *     merely refused — they are absent from `tools/list` and cannot be called.
 *
 * The two transports gate independently: a classic controller serves the legacy
 * tools with no Integration API at all, and a UniFi OS console usually serves
 * the Integration tools with no legacy credentials.
 */
export const registerTools = (
  server: McpServer,
  ctx: ToolContext,
  opts: RegisterOptions = {},
): void => {
  registerStatusTool(server, ctx);

  if (integrationReady(ctx.config)) {
    registerSiteTools(server, ctx);
    registerClientTools(server, ctx);
    registerDeviceTools(server, ctx);
    if (atLeast(ctx.probe.tier, "clients-plus")) registerVoucherTools(server, ctx);
    if (atLeast(ctx.probe.tier, "network-config")) {
      registerNetworkTools(server, ctx);
      registerFirewallTools(server, ctx);
    }
    registerRequestTool(server, ctx);
  }

  if (legacyReady(ctx.config) && opts.legacy) {
    registerLegacyTools(server, opts.legacy, ctx);
    registerLegacyRequestTool(server, opts.legacy, ctx);
  }
};
