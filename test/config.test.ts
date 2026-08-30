import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inferMode,
  integrationBaseUrl,
  integrationReady,
  isConfigured,
  legacyBaseUrl,
  legacyLoginUrl,
  legacyReady,
  loadConfig,
  parseHost,
  setupInstructions,
} from "../src/config.js";

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

  it("rejects an unknown mode", () => {
    expect(() => inferMode({ UNIFI_MODE: "wat" }, {})).toThrow(/UNIFI_MODE/);
  });
});

describe("contradiction rules", () => {
  it("refuses insecure TLS against the cloud proxy", () => {
    expect(() =>
      loadConfig({ UNIFI_MODE: "cloud", UNIFI_CONSOLE_ID: "c1", UNIFI_INSECURE_TLS: "1" }, ABSENT),
    ).toThrow(/valid certificate/);
  });

  it("refuses cloud mode with a key but no console id", () => {
    expect(() => loadConfig({ UNIFI_MODE: "cloud", UNIFI_API_KEY: "k" }, ABSENT)).toThrow(
      /UNIFI_CONSOLE_ID/,
    );
  });

  it("refuses the legacy tier without credentials for it", () => {
    expect(() => loadConfig({ UNIFI_HOST: "10.0.0.1", UNIFI_ENABLE_LEGACY: "1" }, ABSENT)).toThrow(
      /UNIFI_USERNAME/,
    );
  });

  it("refuses the legacy tier through the cloud proxy", () => {
    expect(() =>
      loadConfig(
        {
          UNIFI_MODE: "cloud",
          UNIFI_CONSOLE_ID: "c1",
          UNIFI_ENABLE_LEGACY: "1",
          UNIFI_USERNAME: "a",
          UNIFI_PASSWORD: "b",
        },
        ABSENT,
      ),
    ).toThrow(/not reachable through/);
  });

  it("refuses an API key against a classic controller, which serves no such API", () => {
    expect(() =>
      loadConfig({ UNIFI_MODE: "classic", UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" }, ABSENT),
    ).toThrow(/UniFi OS only/);
  });

  it("refuses credentials with no host to send them to", () => {
    expect(() => loadConfig({ UNIFI_API_KEY: "k" }, ABSENT)).toThrow(/UNIFI_HOST/);
  });

  it("stays silent when nothing contradicts anything", () => {
    expect(() => loadConfig({ UNIFI_HOST: "10.0.0.1", UNIFI_API_KEY: "k" }, ABSENT)).not.toThrow();
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
