import { describe, expect, it, vi } from "vitest";

import { SiteResolver, isUuid } from "../src/client/sites.js";
import { UnifiClient } from "../src/client/unifi.js";
import { SITES, SITE_UUID, SITE_UUID_2, jsonResponse, page } from "./harness.js";

const makeClient = (sites = SITES) => {
  const fetchMock = vi.fn(async () => jsonResponse(page(sites)));
  const client = new UnifiClient({
    baseUrl: "https://10.0.0.1/proxy/network/integration/v1",
    apiKey: "k",
    userAgent: "test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
};

describe("SiteResolver", () => {
  it("trusts a well-formed UUID without any lookup", async () => {
    // Saves a round trip, and still works for a site the /sites listing
    // paginated past.
    const { client, fetchMock } = makeClient();
    const resolver = new SiteResolver(client);
    expect(await resolver.resolve(SITE_UUID)).toBe(SITE_UUID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the legacy internalReference, case-sensitively", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client);
    expect(await resolver.resolve("default")).toBe(SITE_UUID);
    expect(await resolver.resolve("f3k9d2la")).toBe(SITE_UUID_2);
  });

  it("resolves the display name, case-insensitively", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client);
    expect(await resolver.resolve("Default")).toBe(SITE_UUID);
    expect(await resolver.resolve("  warehouse ")).toBe(SITE_UUID_2);
  });

  it("resolves a truncated id, because models truncate UUIDs", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client);
    expect(await resolver.resolve(SITE_UUID.slice(0, 12))).toBe(SITE_UUID);
  });

  it("picks the only site silently when there is just one", async () => {
    const { client } = makeClient([SITES[0]!]);
    const resolver = new SiteResolver(client);
    expect(await resolver.resolve()).toBe(SITE_UUID);
  });

  it("refuses to guess between several sites, and lists them all", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client);
    await expect(resolver.resolve()).rejects.toThrow(/2 sites/);
  });

  it("uses the configured default site", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client, { defaultSite: "f3k9d2la" });
    expect(await resolver.resolve()).toBe(SITE_UUID_2);
  });

  it("names all three identifiers when nothing matches", async () => {
    const { client } = makeClient();
    const resolver = new SiteResolver(client);
    const error = await resolver.resolve("nope").catch((err: Error) => err.message);
    expect(error).toContain("is a UUID, not the legacy");
    expect(error).toContain(SITE_UUID);
    expect(error).toContain("internalReference");
    expect(error).toContain('"Default"');
    // The id leads each line, so a model copying the first token gets the
    // thing the API actually wants.
    for (const line of String(error)
      .split("\n")
      .filter((l) => l.startsWith("  "))) {
      expect(line.trim().split(" ")[0]).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("fetches the site list once and caches it", async () => {
    const { client, fetchMock } = makeClient();
    const resolver = new SiteResolver(client);
    await resolver.resolve("default");
    await resolver.resolve("Warehouse");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after invalidate, so a new site is found", async () => {
    const { client, fetchMock } = makeClient();
    const resolver = new SiteResolver(client);
    await resolver.resolve("default");
    resolver.invalidate();
    await resolver.resolve("default");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fetch at all when seeded by the startup probe", async () => {
    const { client, fetchMock } = makeClient();
    const resolver = new SiteResolver(client, { seed: SITES });
    expect(await resolver.resolve("default")).toBe(SITE_UUID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a UUID back to the legacy name the old API needs", async () => {
    // The inverse direction: /api/s/<site>/ is keyed by internalReference, and
    // passing a UUID there yields api.err.NoSiteContext, which reads like a
    // permissions problem.
    const { client } = makeClient();
    const resolver = new SiteResolver(client, { seed: SITES });
    expect(await resolver.resolveLegacyName(SITE_UUID)).toBe("default");
    expect(await resolver.resolveLegacyName("Warehouse")).toBe("f3k9d2la");
    expect(await resolver.resolveLegacyName("default")).toBe("default");
  });
});

describe("isUuid", () => {
  it("recognises the real thing and rejects the legacy name", () => {
    expect(isUuid(SITE_UUID)).toBe(true);
    expect(isUuid("default")).toBe(false);
    expect(isUuid("f3k9d2la")).toBe(false);
  });
});
