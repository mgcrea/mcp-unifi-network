export { createServer, SERVER_NAME, SERVER_VERSION, USER_AGENT } from "#/server";
export type { CreateServerOptions, CreatedServer } from "#/server";

export {
  configDir,
  expandTilde,
  INTEGRATION_PATHS,
  integrationBaseUrl,
  integrationReady,
  inferMode,
  isConfigured,
  legacyBaseUrl,
  legacyLoginUrl,
  legacyReady,
  loadConfig,
  MODES,
  parseHost,
  readConfigFile,
  resolveConfigPath,
  setupInstructions,
  warnIfGroupReadable,
} from "#/config";
export type { Config, FileConfig, Mode } from "#/config";

export { atLeast, describeTierGap, floorOf, parseVersion, TIERS, tierFor } from "#/version";
export type { VersionTier } from "#/version";

export { macCompact, normalizeMac, normalizeMacOpt } from "#/mac";
export * as filter from "#/filter";

export { UnifiClient } from "#/client/unifi";
export type { Page, UnifiClientOptions } from "#/client/unifi";
export { UnifiLegacyClient } from "#/client/legacy";
export type { LegacyClientOptions } from "#/client/legacy";
export { SiteResolver, isUuid, staticLegacyResolver } from "#/client/sites";
export type { SiteRef } from "#/client/sites";
export { ASSUMED_PROBE, probeConsole } from "#/client/probe";
export type { Probe } from "#/client/probe";
export { createHttpFetch } from "#/client/tls";
export type { Logger } from "#/client/auth";

export {
  ResponseTooLargeError,
  SiteResolutionError,
  UnifiApiError,
  UnifiLegacyError,
  WritesDisabledError,
} from "#/client/errors";

export {
  annotateSite,
  summarizeClient,
  summarizeDevice,
  unwrapPage,
  wrapCollected,
} from "#/client/shape";
export {
  LEGACY_CLIENT_ATTRS,
  LEGACY_DEVICE_ATTRS,
  summarizeLegacyClient,
  summarizeLegacyDevice,
  summarizeLegacyEvent,
} from "#/client/legacy-shape";

export { registerTools } from "#/tools/index";
export type { RegisterOptions, ToolContext } from "#/tools/index";
export { assertSafePath } from "#/tools/request";
