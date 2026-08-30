#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { probeConsole, ASSUMED_PROBE } from "#/client/probe";
import type { Probe } from "#/client/probe";
import { createHttpFetch } from "#/client/tls";
import { UnifiClient } from "#/client/unifi";
import {
  integrationBaseUrl,
  integrationReady,
  isConfigured,
  legacyReady,
  loadConfig,
  setupInstructions,
} from "#/config";
import type { Config } from "#/config";
import { createServer, USER_AGENT } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the JSON-RPC stream — usually surfacing far from
// its cause.
const stderrLogger = {
  debug: (...args: unknown[]): void => {
    if (process.env.UNIFI_DEBUG) console.error("[unifi-mcp]", ...args);
  },
  warn: (...args: unknown[]): void => console.error("[unifi-mcp]", ...args),
  error: (...args: unknown[]): void => console.error("[unifi-mcp]", ...args),
};

/** Show the field messages, not forty frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const runProbe = async (
  config: Config,
  fetchImpl: typeof fetch,
): Promise<{ probe: Probe; client?: UnifiClient }> => {
  if (!integrationReady(config)) return { probe: ASSUMED_PROBE };
  const baseUrl = integrationBaseUrl(config);
  if (!baseUrl) return { probe: ASSUMED_PROBE };

  const probeClient = new UnifiClient({
    baseUrl,
    apiKey: config.apiKey ?? "",
    // One attempt: this is a startup latency budget, not a resilience path, and
    // the whole thing is allowed to fail.
    maxRetries: 0,
    userAgent: USER_AGENT,
    fetch: fetchImpl,
    logger: stderrLogger,
  });
  return probeConsole(probeClient, {
    override: config.appVersion,
    timeoutMs: config.probeTimeoutMs,
    logger: stderrLogger,
  });
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ` +
      `${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  const config = loadConfig();
  const fetchImpl = createHttpFetch({ insecureTls: config.insecureTls, logger: stderrLogger });
  const { probe } = await runProbe(config, fetchImpl);

  const { server } = createServer({ config, probe, fetch: fetchImpl, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The banner is not decoration. It prints the resolved capability state, and
  // `writes=ENABLED` or `tls=INSECURE` scrolling past is the last chance anyone
  // has to notice before an agent changes something real.
  stderrLogger.warn(
    `unifi-mcp connected (mode=${config.mode}, host=${config.host ?? "-"}, ` +
      `version=${probe.appVersion ?? "unknown"}, tier=${probe.tier} (${probe.versionSource}), ` +
      `sites=${probe.sites.length}, ` +
      `integration=${integrationReady(config) ? "on" : "off"}, ` +
      `legacy=${legacyReady(config) ? "on" : "off"}, ` +
      `tls=${config.insecureTls ? "INSECURE" : "verified"}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"})`,
  );

  for (const issue of config.issues) stderrLogger.warn(`  config: ${issue}`);

  if (config.invalidMode) {
    stderrLogger.warn(
      `  UNIFI_MODE="${config.invalidMode}" is not recognised — ignored, using mode=${config.mode}. ` +
        `Accepted: unifios (aka local, console, unifi-os), cloud (aka remote), classic (aka self-hosted).`,
    );
  }

  if (probe.unreachable) {
    stderrLogger.warn(
      `  console unreachable at startup (${probe.unreachable}) — tools were registered for the ` +
        `newest version; anything this console lacks will fail with a message naming the ` +
        `version it needs`,
    );
  }

  if (!isConfigured(config)) {
    stderrLogger.warn("  not configured — only unifi_auth_status is available:");
    for (const line of setupInstructions(config)) stderrLogger.warn(`  - ${line}`);
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[unifi-mcp] fatal:\n${describeFatal(err)}`);
  process.exit(1);
});
