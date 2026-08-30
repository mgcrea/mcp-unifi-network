export { createServer, SERVER_NAME, SERVER_VERSION, USER_AGENT } from "./server.js";
export type { CreateServerOptions, CreatedServer } from "./server.js";

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
} from "./config.js";
export type { Config, FileConfig, Mode } from "./config.js";

export { atLeast, describeTierGap, floorOf, parseVersion, TIERS, tierFor } from "./version.js";
export type { VersionTier } from "./version.js";

export { macCompact, normalizeMac, normalizeMacOpt } from "./mac.js";
export * as filter from "./filter.js";

export { UnifiClient } from "./client/unifi.js";
export type { Page, UnifiClientOptions } from "./client/unifi.js";
export { UnifiLegacyClient } from "./client/legacy.js";
export type { LegacyClientOptions } from "./client/legacy.js";
export { SiteResolver, isUuid, staticLegacyResolver } from "./client/sites.js";
export type { SiteRef } from "./client/sites.js";
export { ASSUMED_PROBE, probeConsole } from "./client/probe.js";
export type { Probe } from "./client/probe.js";
export { createHttpFetch } from "./client/tls.js";
export type { Logger } from "./client/auth.js";

export {
  ResponseTooLargeError,
  SiteResolutionError,
  UnifiApiError,
  UnifiLegacyError,
  WritesDisabledError,
} from "./client/errors.js";

export {
  annotateSite,
  summarizeClient,
  summarizeDevice,
  unwrapPage,
  wrapCollected,
} from "./client/shape.js";
export {
  LEGACY_CLIENT_ATTRS,
  LEGACY_DEVICE_ATTRS,
  summarizeLegacyClient,
  summarizeLegacyDevice,
  summarizeLegacyEvent,
} from "./client/legacy-shape.js";

export { registerTools } from "./tools/index.js";
export type { RegisterOptions, ToolContext } from "./tools/index.js";
export { assertSafePath } from "./tools/request.js";
