import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  integrationReady,
  isConfigured,
  legacyAuthMode,
  legacyReady,
  setupInstructions,
} from "../config.js";
import type { ToolContext } from "./index.js";
import { wrap } from "./util.js";

/**
 * The one tool that is always registered, before any credential check. An
 * unconfigured server is then still a useful one — it can say what to configure —
 * rather than a connection that closes with its own error message swallowed.
 */
export const registerStatusTool = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "unifi_auth_status",
    {
      description:
        "Report whether this server can reach a UniFi console, which transport and site it uses, " +
        "what Network version the console runs, and — when something is missing — exactly what " +
        "to set. Call this FIRST whenever a tool you expected is not in the list: on this API " +
        "the available endpoints depend on the console's version, so an absent tool usually " +
        "means an older console or missing configuration rather than a bug.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const { config, probe } = ctx;
        const configured = isConfigured(config);
        return {
          configured,
          mode: config.mode,
          ...(config.invalidMode
            ? { mode_warning: `UNIFI_MODE="${config.invalidMode}" was not recognised and ignored.` }
            : {}),
          host: config.host ?? null,
          integration: {
            enabled: integrationReady(config),
            base_url: ctx.integrationBaseUrl ?? null,
          },
          legacy: {
            enabled: legacyReady(config),
            auth: legacyAuthMode(config) ?? null,
            note: legacyReady(config)
              ? `The unifi_legacy_* tools reach the undocumented controller API using ${
                  legacyAuthMode(config) === "apiKey"
                    ? "UNIFI_API_KEY, which a UniFi OS console accepts on the legacy paths too"
                    : "a console admin cookie session"
                }. They cover what the official API does not — above all the roster of clients ` +
                "the console has ever seen, which is where blocked and long-absent devices live."
              : "Off. Set UNIFI_ENABLE_LEGACY=1 to add the known-client roster (the only place " +
                "blocked and long-absent devices appear), events, alarms and health. On UniFi OS " +
                "the existing UNIFI_API_KEY is enough; elsewhere set UNIFI_USERNAME/UNIFI_PASSWORD.",
          },
          console: {
            application_version: probe.appVersion ?? null,
            tier: probe.tier,
            // How the tier was decided, so "why did a tool disappear" is
            // answerable in one look rather than by re-deriving it.
            version_source: probe.versionSource,
            ...(probe.unreachable
              ? {
                  unreachable: probe.unreachable,
                  note:
                    "The console could not be read at startup, so tools were registered " +
                    "optimistically for the newest version. Endpoints this console lacks will " +
                    "fail with a message naming the version they need.",
                }
              : {}),
            sites: probe.sites.length,
          },
          ...(config.issues.length > 0 ? { config_issues: config.issues } : {}),
          site_default: config.site ?? null,
          writes: config.allowWrites ? "enabled" : "disabled",
          tls: config.insecureTls ? "INSECURE (verification disabled)" : "verified",
          available_without_credentials: ["unifi_auth_status"],
          setup: setupInstructions(config),
        };
      }),
  );
};
