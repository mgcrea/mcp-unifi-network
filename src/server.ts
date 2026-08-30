import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "#/build-info";
import type { Logger } from "#/client/auth";
import { UnifiLegacyClient } from "#/client/legacy";
import { ASSUMED_PROBE } from "#/client/probe";
import type { Probe } from "#/client/probe";
import { SiteResolver } from "#/client/sites";
import { createHttpFetch } from "#/client/tls";
import { UnifiClient } from "#/client/unifi";
import {
  integrationBaseUrl,
  integrationReady,
  legacyAuthMode,
  legacyBaseUrl,
  legacyLoginUrl,
  legacyReady,
} from "#/config";
import type { Config } from "#/config";
import { registerResources } from "#/resources";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-unifi-network-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  /**
   * What the startup probe learned. Defaults to `ASSUMED_PROBE`, which registers
   * the newest tier — see the comment on that constant for why assuming newest
   * is the right failure mode.
   */
  probe?: Probe;
  fetch?: typeof fetch;
  logger?: Logger;
};

export type CreatedServer = {
  server: McpServer;
  client: UnifiClient;
  legacy: UnifiLegacyClient | undefined;
  sites: SiteResolver;
};

/**
 * A pure, synchronous factory. Nothing here touches `process.env` and nothing
 * here reaches the network — the version probe happens in `cli.ts` and arrives
 * as `opts.probe`, so a test that forgets to mock `fetch` fails loudly instead
 * of hanging on a real socket.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const probe = opts.probe ?? ASSUMED_PROBE;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const fetchImpl =
    opts.fetch ??
    createHttpFetch({
      insecureTls: config.insecureTls,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const baseUrl = integrationBaseUrl(config, probe.pathPrefix);

  const client = new UnifiClient({
    // A client is always constructed so the factory stays total; when the
    // Integration API is unreachable for this configuration, no tool that would
    // use it is registered.
    baseUrl: baseUrl ?? "https://unconfigured.invalid",
    apiKey: config.apiKey ?? "",
    maxRetries: config.maxRetries,
    pageLimit: config.pageLimit,
    maxPages: config.maxPages,
    userAgent: USER_AGENT,
    fetch: fetchImpl,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const sites = new SiteResolver(client, {
    defaultSite: config.site,
    seed: probe.sites,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  // A 404 on a site path usually means the cached site list is stale.
  client.onSiteNotFound = () => sites.invalidate();

  const legacyBase = legacyBaseUrl(config);
  const loginUrl = legacyLoginUrl(config);
  const legacy =
    legacyReady(config) && legacyBase && loginUrl
      ? new UnifiLegacyClient({
          baseUrl: legacyBase,
          loginUrl,
          username: config.username ?? "",
          password: config.password ?? "",
          ...(legacyAuthMode(config) === "apiKey" ? { apiKey: config.apiKey } : {}),
          userAgent: USER_AGENT,
          maxRetries: config.maxRetries,
          fetch: fetchImpl,
          ...(opts.logger ? { logger: opts.logger } : {}),
        })
      : undefined;

  // Unconditional: the notes explain failures that occur when nothing is
  // configured, so gating them behind readiness would hide them exactly when
  // they are needed.
  registerResources(server);

  registerTools(
    server,
    {
      config,
      allowWrites: config.allowWrites,
      probe,
      client,
      sites,
      integrationBaseUrl: integrationReady(config) ? baseUrl : undefined,
    },
    { legacy },
  );

  return { server, client, legacy, sites };
};
