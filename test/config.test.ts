import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inferMode,
  integrationBaseUrl,
  integrationReady,
  isConfigured,
  legacyAuthMode,
  legacyBaseUrl,
  legacyLoginUrl,
  legacyReady,
  loadConfig,
  parseHost,
  setupInstructions,
} from "#/config";

const ABSENT = "/nonexistent/unifi-config.json";

const writeConfig = (contents: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "unifi-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  // 0600, so these fixtures do not trip the group-readable warning on every run.
  chmodSync(path, 0o600);
  return path;
};

describe("loadConfig", () => {
  it("never throws when nothing is configured", () => {
    // Rule 2, pinned. A throw here becomes a bare "Connection closed" in the
    // client, with the explanation swallowed along with stderr.
    const config = loadConfig({}, ABSENT);
    expect(isConfigured(config)).toBe(false);
    expect(config.allowWrites).toBe(false);
    expect(setupInstructions(config).length).toBeGreaterThan(0);
  });

  it("lets an env var beat the config file per field", () => {
    const path = writeConfig({ apiKey: "from-file", allowWrites: true, host: "192.168.1.1" });
    const config = loadConfig({ UNIFI_ALLOW_WRITES: "0" }, path);
    // The one-off override wins…
    expect(config.allowWrites).toBe(false);
    // …without discarding the rest of the file.
    expect(config.apiKey).toBe("from-file");
    expect(config.host).toBe("192.168.1.1");
  });

  it("treats an empty env var as unset rather than as an empty value", () => {
    const path = writeConfig({ apiKey: "from-file", host: "10.0.0.1" });
    expect(loadConfig({ UNIFI_API_KEY: "   " }, path).apiKey).toBe("from-file");
  });

  it("rejects an unknown key in the config file", () => {
    // .strict() on purpose: silently ignoring a typo looks exactly like "that
    // setting had no effect", which is the worst way to learn your credentials
    // came from somewhere else.
    const path = writeConfig({ apiKEY: "typo" });
    expect(() => loadConfig({}, path)).toThrow(/apiKEY|Unrecognized/i);
  });

  it("treats a malformed config file as fatal, not as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "unifi-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig({}, path)).toThrow(/not valid JSON/);
  });
});

describe("parseHost", () => {
  it("splits whatever was pasted from the address bar", () => {
    expect(parseHost("192.168.1.1")).toEqual({ host: "192.168.1.1" });
    expect(parseHost("https://10.0.0.1:8443/")).toEqual({ host: "10.0.0.1", port: 8443 });
    expect(parseHost("https://unifi.local/network/default/dashboard")).toEqual({
      host: "unifi.local",
    });
    expect(parseHost(undefined)).toEqual({});
  });
});

describe("mode inference", () => {
  it("infers cloud from a console id", () => {
    expect(inferMode({ UNIFI_CONSOLE_ID: "abc" }, {})).toEqual({
      mode: "cloud",
      source: "inferred",
    });
  });

  it("infers classic from port 8443, which is its tell", () => {
    expect(inferMode({ UNIFI_HOST: "https://10.0.0.1:8443" }, {})).toEqual({
      mode: "classic",
      source: "inferred",
    });
  });

  it("defaults to unifios", () => {
    expect(inferMode({ UNIFI_HOST: "10.0.0.1" }, {})).toEqual({
      mode: "unifios",
      source: "default",
    });
  });

  it("falls back instead of rejecting an unknown mode", () => {
    // Superseded on purpose: this used to throw. See the UNIFI_MODE block below.
    expect(inferMode({ UNIFI_MODE: "wat" }, {})).toMatchObject({
      mode: "unifios",
      source: "invalid",
      invalidMode: "wat",
    });
  });
});

describe("contradictions are resolved, never fatal", () => {
  // Each of these used to throw from loadConfig, which exits the process and
  // shows in the client as a bare "Connection closed" with stderr swallowed.
  // Every one has an obvious safe resolution, so it is applied and reported.

  it("ignores insecure TLS in cloud mode", () => {
    const c = loadConfig(
      { UNIFI_MODE: "cloud", UNIFI_CONSOLE_ID: "c1", UNIFI_API_KEY: "k", UNIFI_INSECURE_TLS: "1" },
      ABSENT,
    );
    expect(c.insecureTls).toBe(false);
    expect(c.issues.join(" ")).toContain("valid certificate");
    expect(integrationReady(c)).toBe(true);
  });

  it("ignores a host in cloud mode", () => {
    const c = loadConfig(
      { UNIFI_MODE: "cloud", UNIFI_CONSOLE_ID: "c1", UNIFI_API_KEY: "k", UNIFI_HOST: "10.0.0.1" },
      ABSENT,
    );
    expect(c.host).toBeUndefined();
    expect(c.issues.join(" ")).toContain("UNIFI_HOST was ignored");
  });

  it("ignores the legacy tier in cloud mode", () => {
    const c = loadConfig(
      {
        UNIFI_MODE: "cloud",
        UNIFI_CONSOLE_ID: "c1",
        UNIFI_API_KEY: "k",
        UNIFI_ENABLE_LEGACY: "1",
        UNIFI_USERNAME: "a",
        UNIFI_PASSWORD: "b",
      },
      ABSENT,
    );
    expect(c.enableLegacy).toBe(false);
    expect(legacyReady(c)).toBe(false);
  });

  it("ignores an API key on a classic controller", () => {
    const c = loadConfig(
      { UNIFI_MODE: "classic", UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" },
      ABSENT,
    );
    expect(c.apiKey).toBeUndefined();
    expect(c.issues.join(" ")).toContain("UniFi OS only");
  });

  it("reports an incomplete config without exiting", () => {
    // The case hit in practice: a key with no host to send it to.
    const c = loadConfig({ UNIFI_API_KEY: "k" }, ABSENT);
    expect(c.issues.join(" ")).toContain("UNIFI_HOST is not set");
    expect(isConfigured(c)).toBe(false);
    expect(setupInstructions(c).join(" ")).toContain("UNIFI_HOST");
  });

  it("says nothing when nothing contradicts anything", () => {
    const c = loadConfig({ UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" }, ABSENT);
    expect(c.issues).toEqual([]);
  });
});

describe("derived URLs and readiness", () => {
  it("builds the UniFi OS proxy path", () => {
    const config = loadConfig({ UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" }, ABSENT);
    expect(integrationBaseUrl(config)).toBe("https://10.0.0.1/proxy/network/integration/v1");
    expect(legacyBaseUrl(config)).toBe("https://10.0.0.1/proxy/network");
    // The login endpoint belongs to UniFi OS, not to the Network app, so it
    // sits outside the /proxy/network prefix.
    expect(legacyLoginUrl(config)).toBe("https://10.0.0.1/api/auth/login");
    expect(integrationReady(config)).toBe(true);
    expect(legacyReady(config)).toBe(false);
  });

  it("builds the cloud connector path", () => {
    const config = loadConfig(
      { UNIFI_MODE: "cloud", UNIFI_CONSOLE_ID: "c1", UNIFI_API_KEY: "k" },
      ABSENT,
    );
    expect(integrationBaseUrl(config)).toBe(
      "https://api.ui.com/v1/connector/consoles/c1/proxy/network/integration/v1",
    );
    expect(legacyBaseUrl(config)).toBeUndefined();
  });

  it("has no Integration API on a classic controller", () => {
    const config = loadConfig(
      {
        UNIFI_MODE: "classic",
        UNIFI_HOST: "10.0.0.1",
        UNIFI_ENABLE_LEGACY: "1",
        UNIFI_USERNAME: "a",
        UNIFI_PASSWORD: "b",
      },
      ABSENT,
    );
    expect(integrationBaseUrl(config)).toBeUndefined();
    expect(integrationReady(config)).toBe(false);
    expect(legacyBaseUrl(config)).toBe("https://10.0.0.1:8443");
    expect(legacyLoginUrl(config)).toBe("https://10.0.0.1:8443/api/login");
    // The two gates are genuinely independent.
    expect(legacyReady(config)).toBe(true);
    expect(isConfigured(config)).toBe(true);
  });
});

describe("UNIFI_MODE", () => {
  it("accepts the synonyms people actually type", () => {
    for (const [input, expected] of [
      ["local", "unifios"],
      ["console", "unifios"],
      ["unifi-os", "unifios"],
      ["UniFiOS", "unifios"],
      ["remote", "cloud"],
      ["self-hosted", "classic"],
    ] as const) {
      expect(inferMode({ UNIFI_MODE: input }, {})).toMatchObject({ mode: expected });
    }
  });

  it("does not exit on an unrecognised mode", () => {
    // It used to throw, which surfaces in the client as a bare "Connection
    // closed" with stderr swallowed — the exact failure rule 2 exists to
    // prevent, reached from a different direction.
    const config = loadConfig(
      { UNIFI_MODE: "wat", UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" },
      ABSENT,
    );
    expect(config.mode).toBe("unifios");
    expect(config.modeSource).toBe("invalid");
    expect(config.invalidMode).toBe("wat");
    expect(integrationReady(config)).toBe(true);
    // And it says so rather than staying silent about it.
    expect(setupInstructions(config).join(" ")).toContain('UNIFI_MODE="wat"');
  });

  it("still infers cloud from a console id when the mode is nonsense", () => {
    const config = loadConfig(
      { UNIFI_MODE: "nope", UNIFI_CONSOLE_ID: "c1", UNIFI_API_KEY: "k" },
      ABSENT,
    );
    expect(config.mode).toBe("cloud");
  });
});

describe("legacy authentication mode", () => {
  // The original design required a console admin password for the legacy tier.
  // It does not: a UniFi OS console honours the Integration key on the legacy
  // paths, verified against Network 10.6.101.
  it("uses the API key on UniFi OS when no credentials are set", () => {
    const config = loadConfig(
      { UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k", UNIFI_ENABLE_LEGACY: "1" },
      ABSENT,
    );
    expect(legacyAuthMode(config)).toBe("apiKey");
    expect(legacyReady(config)).toBe(true);
    expect(config.issues).toEqual([]);
  });

  it("prefers an explicit console session when both are available", () => {
    const config = loadConfig(
      {
        UNIFI_HOST: "10.0.0.1",
        UNIFI_API_KEY: "k",
        UNIFI_ENABLE_LEGACY: "1",
        UNIFI_USERNAME: "admin",
        UNIFI_PASSWORD: "pw",
      },
      ABSENT,
    );
    expect(legacyAuthMode(config)).toBe("session");
  });

  // A self-hosted controller serves no Integration API, so it has no key to
  // fall back on and still needs the password.
  it("still requires credentials on a classic controller", () => {
    const config = loadConfig(
      { UNIFI_MODE: "classic", UNIFI_HOST: "10.0.0.1", UNIFI_ENABLE_LEGACY: "1" },
      ABSENT,
    );
    expect(legacyAuthMode(config)).toBeUndefined();
    expect(legacyReady(config)).toBe(false);
    expect(config.issues.join(" ")).toMatch(/UNIFI_USERNAME/);
  });
});
