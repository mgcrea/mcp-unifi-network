import { describe, expect, it, vi } from "vitest";

import { UnifiApiError, UnifiLegacyError } from "../src/client/errors.js";
import { UnifiLegacyClient } from "../src/client/legacy.js";
import { probeConsole } from "../src/client/probe.js";
import { UnifiClient } from "../src/client/unifi.js";
import { jsonResponse, page, SITES } from "./harness.js";

const BASE = "https://10.0.0.1/proxy/network/integration/v1";

const makeClient = (fetchMock: ReturnType<typeof vi.fn>, maxRetries = 0) =>
  new UnifiClient({
    baseUrl: BASE,
    apiKey: "k",
    userAgent: "test",
    maxRetries,
    fetch: fetchMock as unknown as typeof fetch,
  });

describe("UnifiClient errors", () => {
  it("names the API key and where to create one on a 401", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Missing credentials" }, { status: 401 }),
    );
    await expect(makeClient(fetchMock).get("/sites")).rejects.toThrow(
      /UNIFI_API_KEY.*unifi\.ui\.com/s,
    );
  });

  it("reads the nested envelope UniFi OS returns on an unauthenticated request", async () => {
    // Verified against a live console: UniFi OS rejects at the proxy with a
    // nested {error:{code,message}}, not the Network app's documented flat shape.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 401, message: "Unauthorized" } }, { status: 401 }),
    );
    const err = await makeClient(fetchMock)
      .get("/info")
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("Unauthorized");
    expect((err as UnifiApiError).code).toBe("401");
    expect((err as Error).message).toContain("UNIFI_API_KEY");
  });

  it("explains that a 403 is about the key's role, not the key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "Forbidden" }, { status: 403 }));
    await expect(makeClient(fetchMock).get("/sites")).rejects.toThrow(/role lacks permission/);
  });

  it("points a 404 on a site path at the UUID trap", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "Not found" }, { status: 404 }));
    await expect(makeClient(fetchMock).get("/sites/default/clients")).rejects.toThrow(
      /UUID, not the legacy/,
    );
  });

  it("points a bare 404 at the version tier", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "Not found" }, { status: 404 }));
    await expect(makeClient(fetchMock).get("/wans")).rejects.toThrow(/Network 10.0/);
  });

  it("drops the stale site cache on a site 404", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 404 }));
    const client = makeClient(fetchMock);
    const invalidate = vi.fn();
    client.onSiteNotFound = invalidate;
    await client.get("/sites/x/clients").catch(() => {});
    expect(invalidate).toHaveBeenCalled();
  });

  it("keeps the requestId, the only handle once the request has left", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { message: "Boom", code: "api.internal", requestId: "3fa85f64" },
        { status: 500 },
      ),
    );
    const err = await makeClient(fetchMock)
      .get("/sites")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnifiApiError);
    expect((err as UnifiApiError).requestId).toBe("3fa85f64");
    expect((err as UnifiApiError).code).toBe("api.internal");
  });
});

describe("UnifiClient pagination", () => {
  it("follows offset pages until the collection is exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page([{ id: 1 }, { id: 2 }], 3, 0)))
      .mockResolvedValueOnce(jsonResponse(page([{ id: 3 }], 3, 2)));
    const result = await makeClient(fetchMock).listAll("/sites/x/clients");
    expect(result.data).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("treats limit as a cap on items returned, not as a page size", async () => {
    // Regression: `limit` used to set the page size with the item cap derived as
    // limit * maxPages, so asking for 4 devices on a 12-device site returned 12.
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        page(
          Array.from({ length: 4 }, (_, i) => ({ id: i })),
          12,
          0,
        ),
      ),
    );
    const result = await makeClient(fetchMock).listAll("/sites/x/devices", {}, { limit: 4 });
    expect(result.data).toHaveLength(4);
    expect(result.totalCount).toBe(12);
    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at maxItems and says so, rather than filling the context window", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page([{ id: 1 }], 500, 0)));
    const client = new UnifiClient({
      baseUrl: BASE,
      apiKey: "k",
      userAgent: "test",
      maxPages: 3,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.listAll("/sites/x/clients", {}, { maxItems: 2 });
    expect(result.data.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });
});

describe("probeConsole", () => {
  it("skips the network entirely when a version is pinned", async () => {
    const fetchMock = vi.fn();
    const { probe } = await probeConsole(makeClient(fetchMock), {
      override: "10.6.101",
      timeoutMs: 100,
    });
    expect(probe.versionSource).toBe("override");
    expect(probe.tier).toBe("full");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the version and pre-seeds the site list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ applicationVersion: "10.6.101" }))
      .mockResolvedValueOnce(jsonResponse(page(SITES)));
    const { probe } = await probeConsole(makeClient(fetchMock), { timeoutMs: 500 });
    expect(probe.appVersion).toBe("10.6.101");
    expect(probe.versionSource).toBe("probe");
    expect(probe.sites).toHaveLength(2);
  });

  it("falls back to the plural mount point on a 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "nope" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ applicationVersion: "10.0.162" }))
      .mockResolvedValueOnce(jsonResponse(page([])));
    const { probe } = await probeConsole(makeClient(fetchMock), { timeoutMs: 500 });
    expect(probe.pathPrefix).toBe("/integrations/v1");
    expect(probe.tier).toBe("network-config");
  });

  it("never throws when the console is unreachable", async () => {
    // Rule 2 applies to the network exactly as it applies to credentials: the
    // server must still come up and say what is wrong.
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const { probe } = await probeConsole(makeClient(fetchMock), { timeoutMs: 200 });
    expect(probe.unreachable).toContain("ECONNREFUSED");
    expect(probe.versionSource).toBe("assumed");
    expect(probe.tier).toBe("full");
  });

  it("says a 401 means the key, not the network", async () => {
    // Reporting a rejected key as "unreachable" sends the reader to look at the
    // network instead of at the key. Observed against a live console.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 401, message: "Unauthorized" } }, { status: 401 }),
    );
    const { probe } = await probeConsole(makeClient(fetchMock), { timeoutMs: 500 });
    expect(probe.unreachable).toContain("the API key was rejected");
    expect(probe.tier).toBe("full");
  });

  it("keeps the version even when the site pre-fetch fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ applicationVersion: "9.3.45" }))
      .mockRejectedValueOnce(new Error("boom"));
    const { probe } = await probeConsole(makeClient(fetchMock), { timeoutMs: 500 });
    expect(probe.tier).toBe("clients-plus");
    expect(probe.sites).toEqual([]);
  });
});

const loginResponse = (): Response =>
  new Response(JSON.stringify({ meta: { rc: "ok" }, data: [] }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "TOKEN=jwt-value; Path=/; HttpOnly",
      "x-csrf-token": "csrf-1",
    },
  });

const makeLegacy = (fetchMock: ReturnType<typeof vi.fn>, maxRetries = 1) =>
  new UnifiLegacyClient({
    baseUrl: "https://10.0.0.1/proxy/network",
    loginUrl: "https://10.0.0.1/api/auth/login",
    username: "admin",
    password: "pw",
    userAgent: "test",
    maxRetries,
    fetch: fetchMock as unknown as typeof fetch,
  });

describe("UnifiLegacyClient", () => {
  it("unwraps meta.rc=ok and returns data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ meta: { rc: "ok" }, data: [{ mac: "a" }] }));
    expect(await makeLegacy(fetchMock).request("GET", "/api/s/default/stat/health")).toEqual([
      { mac: "a" },
    ]);
  });

  it("treats meta.rc=error as a failure even at HTTP 200", async () => {
    // The legacy controller signals failure in the BODY, not the status line.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ meta: { rc: "error", msg: "api.err.NoSiteContext" } }));
    const err = await makeLegacy(fetchMock)
      .request("GET", "/api/s/bogus/stat/health")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnifiLegacyError);
    expect((err as UnifiLegacyError).status).toBe(200);
    expect((err as Error).message).toContain("internalReference");
  });

  it("sends the CSRF token on a write, whose absence is a bare 403", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ meta: { rc: "ok" }, data: [] }));
    await makeLegacy(fetchMock).request("POST", "/api/s/default/cmd/stamgr", {
      body: { cmd: "block-sta" },
    });
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(headers.Cookie).toBe("TOKEN=jwt-value");
  });

  it("logs in once and reuses the session", async () => {
    // Login is rate-limited, so one per process start is the whole point.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginResponse())
      // A fresh Response per call: a body can only be read once.
      .mockImplementation(async () => jsonResponse({ meta: { rc: "ok" }, data: [] }));
    const legacy = makeLegacy(fetchMock);
    await legacy.request("GET", "/api/s/default/stat/health");
    await legacy.request("GET", "/api/s/default/stat/event");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/login"))).toHaveLength(1);
  });

  it("re-authenticates once on a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ meta: { rc: "error" } }, { status: 401 }))
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(jsonResponse({ meta: { rc: "ok" }, data: [1] }));
    expect(await makeLegacy(fetchMock).request("GET", "/api/s/default/stat/health")).toEqual([1]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/login"))).toHaveLength(2);
  });

  it("does not retry a rate-limited login, which would deepen the lockout", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ meta: { rc: "error" } }, { status: 429 }));
    await expect(
      makeLegacy(fetchMock, 3).request("GET", "/api/s/default/stat/health"),
    ).rejects.toThrow(/rate-limiting logins/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains that a 2FA account cannot be scripted", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ meta: { rc: "error", msg: "api.err.Ubic2faTokenRequired" } }, { status: 499 }),
    );
    await expect(
      makeLegacy(fetchMock).request("GET", "/api/s/default/stat/health"),
    ).rejects.toThrow(/two-factor/);
  });
});

const keyedLegacy = (fetchMock: ReturnType<typeof vi.fn>) =>
  new UnifiLegacyClient({
    baseUrl: "https://10.0.0.1/proxy/network",
    loginUrl: "https://10.0.0.1/api/auth/login",
    username: "",
    password: "",
    apiKey: "test-key",
    userAgent: "test",
    maxRetries: 1,
    fetch: fetchMock as unknown as typeof fetch,
  });

describe("UnifiLegacyClient with API-key auth", () => {
  // A UniFi OS console accepts the Integration key on the legacy paths too,
  // which takes the full-admin console password out of the common path. The
  // assertion that matters is the absence of the login round trip: if this
  // regresses to a session the server needs credentials it does not have.
  it("sends X-API-KEY and never logs in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ meta: { rc: "ok" }, data: [{ mac: "a" }] }));

    expect(await keyedLegacy(fetchMock).request("GET", "/api/s/default/rest/user")).toEqual([
      { mac: "a" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/s/default/rest/user");

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> } | undefined;
    const headers = init?.headers ?? {};
    expect(headers["X-API-KEY"]).toBe("test-key");
    expect(headers.Cookie).toBeUndefined();
  });

  // A key rejected on the legacy path is the Site-Manager-key mistake, and the
  // message has to name it — the two key types are indistinguishable by sight.
  it("explains a 401 in terms of the key, not a password", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ meta: { rc: "error" } }, { status: 401 }));
    const err = await keyedLegacy(fetchMock)
      .request("GET", "/api/s/default/rest/user")
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/Site Manager key/);
    expect(String(err)).not.toMatch(/UNIFI_PASSWORD\b.*Check/);
  });
});
