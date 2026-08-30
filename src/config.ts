import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

/** UniFi OS consoles proxy the Network app; classic controllers serve it directly. */
export const MODES = ["unifios", "cloud", "classic"] as const;
export type Mode = (typeof MODES)[number];

const CLOUD_BASE = "https://api.ui.com/v1/connector/consoles";

/**
 * What people actually type. "unifios" is the vendor's word for the platform,
 * but the distinction a user is making is local-versus-cloud, so `local` is the
 * obvious guess and rejecting it is a self-inflicted support question.
 */
const MODE_ALIASES: Record<string, Mode> = {
  local: "unifios",
  console: "unifios",
  "unifi-os": "unifios",
  unifi_os: "unifios",
  os: "unifios",
  remote: "cloud",
  "site-manager": "cloud",
  sitemanager: "cloud",
  controller: "classic",
  "self-hosted": "classic",
  selfhosted: "classic",
};

/** Resolve a user-supplied mode, accepting the common synonyms. */
export const normalizeMode = (value: string): Mode | undefined => {
  const key = value.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(key)) return key as Mode;
  return MODE_ALIASES[key];
};

/**
 * Both spellings exist in the wild — most builds mount the Integration API at
 * `/integration/v1`, a few at `/integrations/v1`. `probeConsole` negotiates
 * which one a given console serves; this is the order it tries.
 */
export const INTEGRATION_PATHS = ["/integration/v1", "/integrations/v1"] as const;

const DEFAULT_PORT: Record<Mode, number | undefined> = {
  unifios: undefined, // 443, so it never appears in the URL
  classic: 8443,
  cloud: undefined,
};

// ------------------------------------------------------------------ parsers --

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/** `"0"` must mean `false`, not "unset" — that is the whole point of returning undefined. */
const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Split whatever the user pasted. Everyone copies the address bar, so
 * `https://192.168.1.1:8443/network/default/dashboard` has to work as well as
 * `192.168.1.1` — refusing it would only generate a support question we can
 * answer here in six lines.
 */
export const parseHost = (raw: string | undefined): { host?: string; port?: number } => {
  const value = trimmed(raw);
  if (!value) return {};
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return {
      host: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
    };
  } catch {
    // Not a URL at all — treat the whole string as a hostname and let the
    // request fail with a real DNS error rather than a config parse error.
    return { host: value };
  }
};

// ------------------------------------------------------------------- schema --

const ConfigSchema = z
  .object({
    mode: z.enum(MODES).default("unifios"),
    /**
     * Derived, never user-set. `mode` has a default, so its value alone cannot
     * tell us whether the user chose it — and a contradiction rule must only
     * fire on an actual choice.
     */
    modeSource: z.enum(["explicit", "inferred", "default", "invalid"]).default("default"),
    /** The rejected UNIFI_MODE value, kept so it can be reported rather than thrown. */
    invalidMode: z.string().optional(),
    /**
     * Contradictions found and resolved at load time, in plain English.
     *
     * These used to be zod issues, which made `loadConfig` throw and the process
     * exit — surfacing in the client as a bare "Connection closed" with stderr
     * swallowed, so the one message explaining the problem never arrived. Every
     * one of them has an obvious safe resolution, so the resolution is applied
     * and recorded here, then reported by the banner and unifi_auth_status.
     */
    issues: z.array(z.string()).default([]),

    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    apiKey: z.string().min(1).optional(),
    consoleId: z.string().min(1).optional(),
    site: z.string().min(1).optional(),

    /**
     * Skips the startup probe entirely. Explicit, so a malformed value is a
     * contradiction rather than an absence — hence this one really is an error.
     */
    appVersion: z
      .string()
      .regex(
        /^\d+\.\d+/,
        "UNIFI_APP_VERSION must look like `10.6.0` — the `applicationVersion` from GET /v1/info.",
      )
      .optional(),

    allowWrites: z.boolean().default(false),
    insecureTls: z.boolean().default(false),

    enableLegacy: z.boolean().default(false),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),

    maxRetries: z.number().int().nonnegative().max(10).default(3),
    pageLimit: z.number().int().min(1).max(200).default(50),
    maxPages: z.number().int().min(1).max(200).default(20),
    probeTimeoutMs: z.number().int().min(250).max(30_000).default(3_000),
  })
  .strict()
  .transform(resolveConflicts);

type RawConfig = {
  mode: Mode;
  modeSource: "explicit" | "inferred" | "default" | "invalid";
  invalidMode?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  apiKey?: string | undefined;
  consoleId?: string | undefined;
  site?: string | undefined;
  appVersion?: string | undefined;
  allowWrites: boolean;
  insecureTls: boolean;
  enableLegacy: boolean;
  username?: string | undefined;
  password?: string | undefined;
  maxRetries: number;
  pageLimit: number;
  maxPages: number;
  probeTimeoutMs: number;
  issues: string[];
};

/**
 * Apply the safe resolution for each contradictory combination and record what
 * was done. Nothing here throws: an MCP server that exits at startup takes its
 * own explanation with it.
 */
function resolveConflicts(cfg: RawConfig): RawConfig {
  const issues: string[] = [...cfg.issues];
  const out = { ...cfg };

  if (out.insecureTls && out.mode === "cloud") {
    out.insecureTls = false;
    issues.push(
      "UNIFI_INSECURE_TLS was ignored: api.ui.com presents a valid certificate, so disabling " +
        "verification in cloud mode removes protection and gains nothing.",
    );
  }

  if (out.mode === "cloud" && out.modeSource === "explicit" && out.host) {
    out.host = undefined;
    issues.push(
      "UNIFI_HOST was ignored: cloud mode addresses the console through api.ui.com, so the " +
        "host has no meaning. Unset one of the two to make the intent explicit.",
    );
  }

  if (out.enableLegacy && out.mode === "cloud") {
    out.enableLegacy = false;
    issues.push(
      "UNIFI_ENABLE_LEGACY was ignored: the legacy controller API is not reachable through the " +
        "Site Manager connector proxy. Use UNIFI_MODE=unifios against the console directly.",
    );
  }

  if (out.mode === "classic" && out.apiKey) {
    out.apiKey = undefined;
    issues.push(
      "UNIFI_API_KEY was ignored: a self-hosted Network application serves no Integration API — " +
        "that is UniFi OS only. Set UNIFI_ENABLE_LEGACY=1 with UNIFI_USERNAME/UNIFI_PASSWORD.",
    );
  }

  // The remaining cases are INCOMPLETE rather than contradictory. Nothing is
  // overridden; the affected transport simply stays unready and says why.
  if (out.mode === "cloud" && out.apiKey && !out.consoleId) {
    issues.push(
      "UNIFI_CONSOLE_ID is not set, so cloud mode has no console to address. Find yours with: " +
        'curl -H "X-API-KEY: $UNIFI_API_KEY" https://api.ui.com/v1/hosts',
    );
  }
  if (
    out.enableLegacy &&
    !(out.username && out.password) &&
    !(out.mode === "unifios" && out.apiKey)
  ) {
    issues.push(
      "UNIFI_ENABLE_LEGACY=1 has nothing to authenticate with. On a UniFi OS console a local " +
        "UNIFI_API_KEY is enough — the console's proxy accepts it on the legacy paths too. " +
        "Otherwise set UNIFI_USERNAME and UNIFI_PASSWORD (a LOCAL console account; SSO accounts " +
        "need MFA, which cannot be scripted).",
    );
  }
  if (out.mode !== "cloud" && (out.apiKey ?? out.username) && !out.host) {
    issues.push(
      "UNIFI_HOST is not set, so there is no console to reach. Point it at one, " +
        "e.g. UNIFI_HOST=192.168.1.1.",
    );
  }

  out.issues = issues;
  return out;
}

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather than
 * the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `apiKEY` must be an error. Silently ignoring
 * an unknown key looks exactly like "that setting had no effect", which is the
 * worst possible way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    mode: z.enum(MODES).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    apiKey: z.string().min(1).optional(),
    consoleId: z.string().min(1).optional(),
    site: z.string().min(1).optional(),
    appVersion: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    insecureTls: z.boolean().optional(),
    enableLegacy: z.boolean().optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    maxRetries: z.number().int().optional(),
    pageLimit: z.number().int().optional(),
    maxPages: z.number().int().optional(),
    probeTimeoutMs: z.number().int().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

// --------------------------------------------------------------- file layer --

export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.UNIFI_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "unifi", "config.json");
};

export const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      // config.ts runs before any logger exists, so this goes straight to stderr.
      process.stderr.write(`[unifi] ${path} is readable by other users. Run: chmod 600 ${path}\n`);
    }
  } catch {
    /* A missing file is not worth failing startup over. */
  }
};

/**
 * A missing file contributes nothing; a malformed one is fatal. The distinction
 * matters: silently treating a broken file as absent would send you hunting for
 * credentials that were sitting right there.
 */
export const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  warnIfGroupReadable(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${path} is not a valid config file: ${issues}`);
  }
  return result.data;
};

// -------------------------------------------------------------------- modes --

/**
 * Which flavour of console this is. Reported in the startup banner so an
 * inference that guessed wrong is visible rather than mysterious.
 */
export const inferMode = (
  env: NodeJS.ProcessEnv,
  file: FileConfig,
): { mode: Mode; source: Config["modeSource"]; invalidMode?: string } => {
  const explicit = trimmed(env.UNIFI_MODE) ?? file.mode;
  if (explicit) {
    const resolved = normalizeMode(explicit);
    if (resolved) return { mode: resolved, source: "explicit" };
    // Deliberately NOT a throw. An unrecognised mode used to exit the process,
    // which surfaces in the client as a bare "Connection closed" with stderr
    // swallowed — the same failure rule 2 exists to prevent, arrived at from a
    // different direction. The server comes up on the inferred mode instead and
    // reports the bad value through the banner and unifi_auth_status.
    return { mode: inferFromShape(env, file), source: "invalid", invalidMode: explicit };
  }
  const inferred = inferFromShape(env, file);
  if (inferred !== "unifios") return { mode: inferred, source: "inferred" };
  if (trimmed(env.UNIFI_CONSOLE_ID) ?? file.consoleId) return { mode: "cloud", source: "inferred" };
  return { mode: "unifios", source: "default" };
};

/** Which mode the rest of the configuration implies, ignoring UNIFI_MODE itself. */
const inferFromShape = (env: NodeJS.ProcessEnv, file: FileConfig): Mode => {
  if (trimmed(env.UNIFI_CONSOLE_ID) ?? file.consoleId) return "cloud";
  // Port 8443 is the classic controller's tell; UniFi OS answers on 443.
  const port = parseIntOpt(env.UNIFI_PORT) ?? parseHost(env.UNIFI_HOST).port ?? file.port;
  if (port === 8443) return "classic";
  return "unifios";
};

// -------------------------------------------------------------- derived URLs --

const authority = (config: Config): string | undefined => {
  if (!config.host) return undefined;
  const port = config.port ?? DEFAULT_PORT[config.mode];
  return port ? `${config.host}:${port}` : config.host;
};

/**
 * Absolute Integration API base, or undefined when this configuration cannot
 * reach it at all — which is the case for every classic controller, since the
 * Integration API does not exist outside UniFi OS.
 */
export const integrationBaseUrl = (
  config: Config,
  path: string = INTEGRATION_PATHS[0],
): string | undefined => {
  if (config.mode === "cloud") {
    return config.consoleId ? `${CLOUD_BASE}/${config.consoleId}/proxy/network${path}` : undefined;
  }
  if (config.mode !== "unifios") return undefined;
  const host = authority(config);
  return host ? `https://${host}/proxy/network${path}` : undefined;
};

/** Absolute legacy controller base. The proxy prefix exists only on UniFi OS. */
export const legacyBaseUrl = (config: Config): string | undefined => {
  if (config.mode === "cloud") return undefined;
  const host = authority(config);
  if (!host) return undefined;
  return config.mode === "classic" ? `https://${host}` : `https://${host}/proxy/network`;
};

/**
 * The login endpoint sits OUTSIDE the `/proxy/network` prefix on UniFi OS — it
 * belongs to UniFi OS itself, not to the Network application — so it is built
 * from the authority rather than from `legacyBaseUrl`.
 */
export const legacyLoginUrl = (config: Config): string | undefined => {
  const host = authority(config);
  if (!host || config.mode === "cloud") return undefined;
  return config.mode === "classic" ? `https://${host}/api/login` : `https://${host}/api/auth/login`;
};

// ------------------------------------------------------------------ loading --

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while a
 * one-off `UNIFI_ALLOW_WRITES=0` still has to override a file that says `true`.
 * Merging field by field is the only rule that gives both.
 *
 * Never throws for "nothing is configured". An MCP server that exits at startup
 * shows up in the client as a bare `MCP error -32000: Connection closed`, with
 * stderr swallowed. The server stays up instead, registers `unifi_auth_status`,
 * and reports the gap as data.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const { mode, source, invalidMode } = inferMode(env, file);
  const envHost = parseHost(env.UNIFI_HOST);
  const fileHost = parseHost(file.host);

  return ConfigSchema.parse({
    mode,
    modeSource: source,
    invalidMode,
    host: envHost.host ?? fileHost.host,
    // An explicit port beats one embedded in a pasted URL, which beats the file.
    port: parseIntOpt(env.UNIFI_PORT) ?? envHost.port ?? file.port ?? fileHost.port,
    apiKey: trimmed(env.UNIFI_API_KEY) ?? file.apiKey,
    consoleId: trimmed(env.UNIFI_CONSOLE_ID) ?? file.consoleId,
    site: trimmed(env.UNIFI_SITE) ?? file.site,
    appVersion: trimmed(env.UNIFI_APP_VERSION) ?? file.appVersion,
    username: trimmed(env.UNIFI_USERNAME) ?? file.username,
    password: trimmed(env.UNIFI_PASSWORD) ?? file.password,
    allowWrites: parseBool(env.UNIFI_ALLOW_WRITES) ?? file.allowWrites,
    insecureTls: parseBool(env.UNIFI_INSECURE_TLS) ?? file.insecureTls,
    enableLegacy: parseBool(env.UNIFI_ENABLE_LEGACY) ?? file.enableLegacy,
    maxRetries: parseIntOpt(env.UNIFI_MAX_RETRIES) ?? file.maxRetries,
    pageLimit: parseIntOpt(env.UNIFI_PAGE_LIMIT) ?? file.pageLimit,
    maxPages: parseIntOpt(env.UNIFI_MAX_PAGES) ?? file.maxPages,
    probeTimeoutMs: parseIntOpt(env.UNIFI_PROBE_TIMEOUT_MS) ?? file.probeTimeoutMs,
  });
};

// ----------------------------------------------------------------- readiness --

/**
 * Two predicates, not one. The transports authenticate by completely different
 * means and are gated independently — a classic controller can serve the legacy
 * tools with no Integration API at all, and a UniFi OS console usually serves
 * the Integration tools with no legacy credentials.
 */
export const integrationReady = (config: Config): boolean =>
  config.mode !== "classic" && Boolean(config.apiKey) && Boolean(integrationBaseUrl(config));

/**
 * How the legacy transport authenticates, or `undefined` when it cannot.
 *
 * `apiKey` is the case the original design missed. A UniFi OS console proxies
 * `/proxy/network/api/...` through the same gateway that serves the Integration
 * API, and that gateway accepts `X-API-KEY` on BOTH — verified against Network
 * 10.6.101, where a local key returns `{"meta":{"rc":"ok"}}` from
 * `/api/s/default/rest/user`. That removes the console admin password from the
 * common path entirely, which matters: the cookie session is a full-admin
 * credential that had to sit in plaintext in `.mcp.json` to be usable.
 *
 * A username/password still wins when both are present — a self-hosted classic
 * controller has no key to offer, and an older UniFi OS build may not accept one
 * on the legacy paths.
 */
export const legacyAuthMode = (config: Config): "session" | "apiKey" | undefined => {
  if (!legacyBaseUrl(config)) return undefined;
  if (config.username && config.password) return "session";
  if (config.mode === "unifios" && config.apiKey) return "apiKey";
  return undefined;
};

export const legacyReady = (config: Config): boolean =>
  config.enableLegacy && legacyAuthMode(config) !== undefined;

export const isConfigured = (config: Config): boolean =>
  integrationReady(config) || legacyReady(config);

/**
 * What to do about it, as data. Printed to stderr at startup and returned by
 * `unifi_auth_status`, which is the only tool an unconfigured server registers.
 */
export const setupInstructions = (
  config: Config,
  configPath: string = resolveConfigPath(),
): string[] => {
  const steps: string[] = [...config.issues];
  if (config.invalidMode) {
    steps.push(
      `UNIFI_MODE="${config.invalidMode}" is not a recognised mode, so it was ignored and ` +
        `\`${config.mode}\` was inferred instead. Valid values are ${MODES.join(", ")} — and ` +
        `"local", "console" and "unifi-os" are accepted as synonyms for unifios, "remote" for ` +
        `cloud, and "self-hosted" for classic.`,
    );
  }
  if (isConfigured(config)) return steps;

  if (config.mode === "classic") {
    steps.push(
      "This is a self-hosted Network application (port 8443), which has no Integration API. " +
        "Set UNIFI_ENABLE_LEGACY=1 plus UNIFI_USERNAME and UNIFI_PASSWORD, using a LOCAL " +
        "console account — a Ubiquiti SSO account requires MFA and cannot be used unattended.",
    );
  } else if (!config.apiKey) {
    steps.push(
      "There are TWO kinds of UniFi API key and they are not interchangeable. " +
        "(a) A LOCAL Integration key, created on the console itself at " +
        "https://<console>/network/default/settings/control-plane/integrations — this is the " +
        "one UNIFI_MODE=unifios needs. On Network 10.6 `Control Plane` sits under a heading " +
        "named after the console at the BOTTOM of the settings sidebar, below `System`, which " +
        "is why it is often reported missing. " +
        "(b) A CLOUD Site Manager key, created at https://unifi.ui.com/settings/api-keys — this " +
        "one is REJECTED with a 401 by a console's local API, and is used with UNIFI_MODE=cloud " +
        "plus UNIFI_CONSOLE_ID. Cloud mode also works behind CGNAT and needs no TLS workaround. " +
        "Either kind is shown once and can afterwards only be renamed or deleted, any admin can " +
        "create one, and creation sometimes errors on the first attempt — retry. " +
        "Set it as UNIFI_API_KEY.",
    );
  }

  if (config.mode === "cloud" && !config.consoleId) {
    steps.push(
      "Set UNIFI_CONSOLE_ID — the console id from its unifi.ui.com URL. Cloud mode proxies " +
        "through api.ui.com, which works behind CGNAT and presents a valid TLS certificate.",
    );
  }

  if (config.mode !== "cloud" && !config.host) {
    steps.push(
      "Set UNIFI_HOST to the console, e.g. UNIFI_HOST=192.168.1.1. Local consoles ship a " +
        "SELF-SIGNED certificate issued to `unifi.local` with NO IP SAN, so a console addressed " +
        "by IP can never pass verification however its certificate is trusted. Pick one of: " +
        "(a) address it by a host name that resolves to it AND point NODE_EXTRA_CA_CERTS at its " +
        "certificate — both are needed, either alone fails; (b) switch to UNIFI_MODE=cloud with " +
        "UNIFI_CONSOLE_ID, where the certificate is real; or (c) UNIFI_INSECURE_TLS=1, which " +
        "disables verification for this server's requests only.",
    );
  }

  steps.push(
    "Optionally set UNIFI_SITE. On this API `siteId` is a UUID, not the legacy 8-character " +
      'site name — but the tools accept the UUID, the internalReference ("default") or the ' +
      "display name and translate for you. `unifi_list_sites` shows all three.",
    "Writes are off by default: the mutating tools are not registered at all until " +
      "UNIFI_ALLOW_WRITES=1 is set, so an agent cannot call them.",
    `These values can also live in ${configPath}. Restart the server after changing them.`,
  );
  return steps;
};

/** Where the token/config directory lives, for messages that name it. */
export const configDir = (env: NodeJS.ProcessEnv = process.env): string =>
  dirname(resolveConfigPath(env));
