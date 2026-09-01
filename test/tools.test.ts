import { describe, expect, it, vi } from "vitest";

import { ASSUMED_PROBE } from "#/client/probe";

import { connect, jsonResponse, page, probeFor, READY_ENV, SITE_UUID, SITES } from "./harness.js";

const LEGACY_ENV = {
  ...READY_ENV,
  UNIFI_ENABLE_LEGACY: "1",
  UNIFI_USERNAME: "admin",
  UNIFI_PASSWORD: "hunter2",
};

const READ_TOOLS = [
  "unifi_auth_status",
  "unifi_get_client",
  "unifi_get_console_info",
  "unifi_get_device",
  "unifi_get_device_stats",
  "unifi_list_clients",
  "unifi_list_devices",
  "unifi_list_firewall_policies",
  "unifi_list_firewall_zones",
  "unifi_list_networks",
  "unifi_list_sites",
  "unifi_list_vouchers",
  "unifi_list_wlans",
  "unifi_request",
];

const WRITE_TOOLS = [
  "unifi_authorize_guest",
  "unifi_create_vouchers",
  "unifi_delete_vouchers",
  "unifi_power_cycle_port",
  "unifi_restart_device",
  "unifi_unauthorize_guest",
];

describe("registration matrix", () => {
  it("still connects with no credentials, serving only the setup tool", async () => {
    // The regression that produces "MCP error -32000: Connection closed": the
    // server used to exit at startup, taking the credential-free tools with it
    // and leaving no way to discover what to configure.
    const server = await connect({ env: {}, probe: ASSUMED_PROBE });
    expect(await server.toolNames()).toEqual(["unifi_auth_status"]);

    const status = await server.call("unifi_auth_status");
    expect(status.configured).toBe(false);
    const setup = JSON.stringify(status.setup);
    // Pin the direct URL, not a sidebar description: the sidebar location has
    // changed twice already, the route has not.
    // Both key types must be named: a cloud key used locally 401s, and that is
    // the failure people actually hit.
    expect(setup).toContain("/settings/control-plane/integrations");
    expect(setup).toContain("unifi.ui.com/settings/api-keys");
  });

  it("registers the read tools and no write tools by default", async () => {
    const server = await connect();
    expect(await server.toolNames()).toEqual(READ_TOOLS);
  });

  it("registers the write tools only when writes are enabled", async () => {
    const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
    expect(await server.toolNames()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  it("hides the 10.0 tools on a 9.0 console", async () => {
    const names = await (await connect({ probe: probeFor("9.0.114") })).toolNames();
    for (const absent of [
      "unifi_list_networks",
      "unifi_list_wlans",
      "unifi_list_firewall_zones",
      "unifi_list_firewall_policies",
      "unifi_list_vouchers",
      "unifi_get_client",
    ]) {
      expect(names).not.toContain(absent);
    }
    expect(names).toEqual(
      expect.arrayContaining(["unifi_list_devices", "unifi_list_clients", "unifi_list_sites"]),
    );
  });

  it("adds vouchers and client details at 9.3, but not the network config", async () => {
    const names = await (await connect({ probe: probeFor("9.5.12") })).toolNames();
    expect(names).toEqual(expect.arrayContaining(["unifi_list_vouchers", "unifi_get_client"]));
    expect(names).not.toContain("unifi_list_networks");
    expect(names).not.toContain("unifi_list_firewall_zones");
  });

  it("assumes the newest tier when the console could not be probed", async () => {
    // Pinned deliberately: assuming the OLDEST tier would hide tools with no
    // way for a caller to discover why. Assuming the newest yields a 404 whose
    // message names the version needed. Do not "fix" this to the minimum.
    const server = await connect({
      probe: { ...ASSUMED_PROBE, unreachable: "ECONNREFUSED" },
    });
    expect(await server.toolNames()).toEqual(READ_TOOLS);

    const status = await server.call("unifi_auth_status");
    expect((status.console as Record<string, unknown>).unreachable).toBe("ECONNREFUSED");
    expect((status.console as Record<string, unknown>).version_source).toBe("assumed");
  });

  it("registers no legacy tools by default", async () => {
    const names = await (await connect()).toolNames();
    expect(names.filter((n) => n.startsWith("unifi_legacy_"))).toEqual([]);
  });

  // Asserts the WHOLE set, not just the unifi_legacy_ prefixed subset. The
  // filtered assertion below let two new tools land with no visible diff, which
  // is the one thing a registration matrix exists to prevent.
  it("registers exactly this set when the legacy tier is enabled", async () => {
    const names = await (await connect({ env: LEGACY_ENV })).toolNames();
    expect(names).toEqual(
      [
        ...READ_TOOLS,
        "unifi_diagnose_client",
        "unifi_health_check",
        "unifi_legacy_get_health",
        "unifi_legacy_list_alarms",
        "unifi_legacy_list_events",
        "unifi_legacy_list_known_clients",
        "unifi_legacy_request",
      ].toSorted(),
    );
  });

  it("registers the legacy read tools when the legacy tier is enabled", async () => {
    const names = await (await connect({ env: LEGACY_ENV })).toolNames();
    expect(names.filter((n) => n.startsWith("unifi_legacy_"))).toEqual([
      "unifi_legacy_get_health",
      "unifi_legacy_list_alarms",
      "unifi_legacy_list_events",
      "unifi_legacy_list_known_clients",
      "unifi_legacy_request",
    ]);
  });

  it("registers the legacy write tools only with writes on", async () => {
    const names = await (
      await connect({ env: { ...LEGACY_ENV, UNIFI_ALLOW_WRITES: "1" } })
    ).toolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "unifi_legacy_block_client",
        "unifi_legacy_unblock_client",
        "unifi_legacy_reconnect_client",
      ]),
    );
  });

  it("gates the two transports independently", async () => {
    // A classic controller serves the legacy tools with no Integration API at
    // all — proving neither gate is standing in for the other.
    const names = await (
      await connect({
        env: {
          UNIFI_HOST: "10.0.0.1",
          UNIFI_PORT: "8443",
          UNIFI_ENABLE_LEGACY: "1",
          UNIFI_USERNAME: "admin",
          UNIFI_PASSWORD: "hunter2",
        },
      })
    ).toolNames();
    expect(names).toContain("unifi_legacy_get_health");
    expect(names).not.toContain("unifi_list_clients");
    expect(names).not.toContain("unifi_request");
  });
});

describe("annotations", () => {
  it("marks every read tool readOnly and every destructive tool destructive", async () => {
    const server = await connect({
      env: { ...LEGACY_ENV, UNIFI_ALLOW_WRITES: "1" },
      probe: probeFor("10.6.101"),
    });
    const tools = (await server.client.listTools()).tools;
    expect(tools.every((t) => t.annotations !== undefined)).toBe(true);

    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["unifi_list_clients", "unifi_get_device", "unifi_list_sites"]) {
      expect(byName.get(name)?.readOnlyHint).toBe(true);
    }
    for (const name of [
      "unifi_restart_device",
      "unifi_delete_vouchers",
      "unifi_unauthorize_guest",
      "unifi_legacy_block_client",
    ]) {
      expect(byName.get(name)?.destructiveHint).toBe(true);
      expect(byName.get(name)?.readOnlyHint).toBe(false);
    }
    // Restarting twice reboots twice, the second interrupting the first boot.
    expect(byName.get("unifi_restart_device")?.idempotentHint).toBe(false);
  });
});

describe("the confirm gate", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["unifi_restart_device", { deviceId: "d1" }],
    ["unifi_power_cycle_port", { deviceId: "d1", portIdx: 3 }],
    ["unifi_delete_vouchers", { voucherId: "v1" }],
    ["unifi_unauthorize_guest", { clientId: "c1" }],
  ];

  for (const [name, args] of cases) {
    it(`${name} refuses without confirm, without reaching the network`, async () => {
      const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
      const res = await server.call(name, args);
      expect(res.isToolError).toBe(true);
      // The half that proves the gate is the SCHEMA rather than a handler
      // branch that already fired the request.
      expect(server.fetchMock).not.toHaveBeenCalled();
    });
  }

  it("unifi_delete_vouchers refuses with neither voucherId nor filter", async () => {
    const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
    const res = await server.call("unifi_delete_vouchers", { confirm: true });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("exactly one");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("unifi_delete_vouchers refuses with both", async () => {
    const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
    const res = await server.call("unifi_delete_vouchers", {
      confirm: true,
      voucherId: "v1",
      filter: "expired.eq(true)",
    });
    expect(res.isToolError).toBe(true);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });
});

describe("request shape", () => {
  it('translates site "default" to the site UUID', async () => {
    // The headline trap: a model types the legacy 8-character name, and the API
    // wants a UUID. This is the regression test for accepting it anyway.
    const server = await connect();
    await server.call("unifi_list_clients", { site: "default" });
    const url = server.urls().at(-1) ?? "";
    expect(url).toContain(`/sites/${SITE_UUID}/clients`);
    expect(url).not.toContain("/sites/default");
  });

  it("accepts the display name and the raw UUID identically", async () => {
    for (const site of ["Default", "DEFAULT", SITE_UUID]) {
      const server = await connect();
      await server.call("unifi_list_clients", { site });
      expect(server.urls().at(-1)).toContain(`/sites/${SITE_UUID}/clients`);
    }
  });

  it("builds a server-side filter from the structured arguments", async () => {
    const server = await connect();
    await server.call("unifi_list_devices", { state: "OFFLINE", name: "*lab*" });
    const url = decodeURIComponent(server.urls().at(-1) ?? "");
    expect(url).toContain("and(state.eq('OFFLINE'),name.like('*lab*'))");
  });

  it("passes a raw filter through untouched", async () => {
    const server = await connect();
    await server.call("unifi_list_devices", { filter: "firmwareUpdatable.eq(true)" });
    expect(decodeURIComponent(server.urls().at(-1) ?? "")).toContain(
      "filter=firmwareUpdatable.eq(true)",
    );
  });

  it("rejects a limit above the API ceiling", async () => {
    const server = await connect();
    const res = await server.call("unifi_list_clients", { limit: 500 });
    expect(res.isToolError).toBe(true);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("sends the RESTART action body", async () => {
    const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
    await server.call("unifi_restart_device", { deviceId: "dev-1", confirm: true });
    const [, init] = server.fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "RESTART" });
  });

  it("sends the API key as X-API-KEY", async () => {
    const server = await connect();
    await server.call("unifi_list_devices");
    const [, init] = server.fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe("test-key");
  });
});

describe("unifi_request", () => {
  it("offers only GET while writes are disabled", async () => {
    const server = await connect();
    const tool = await server.tool("unifi_request");
    const properties = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.method?.enum).toEqual(["GET"]);

    const res = await server.call("unifi_request", { method: "POST", path: "/sites" });
    expect(res.isToolError).toBe(true);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("offers the mutating methods once writes are enabled", async () => {
    const server = await connect({ env: { ...READY_ENV, UNIFI_ALLOW_WRITES: "1" } });
    const tool = await server.tool("unifi_request");
    const properties = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.method?.enum).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  });

  it("refuses an absolute URL, which would send the API key elsewhere", async () => {
    const server = await connect();
    const res = await server.call("unifi_request", { path: "https://evil.example/steal" });
    expect(res.isToolError).toBe(true);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses traversal segments", async () => {
    const server = await connect();
    const res = await server.call("unifi_request", { path: "/sites/../../../etc" });
    expect(res.isToolError).toBe(true);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });
});

describe("responses", () => {
  it("replaces the pagination echo with a nextOffset only when there is more", async () => {
    const full = vi.fn(async () => jsonResponse(page([{ id: "a" }, { id: "b" }], 2)));
    const server = await connect({ fetchImpl: full });
    const res = await server.call("unifi_list_clients");
    expect(res.totalCount).toBe(2);
    expect(res).not.toHaveProperty("offset");
    expect(res).not.toHaveProperty("limit");
  });

  it("reports all three site identifiers", async () => {
    const server = await connect();
    const res = await server.call("unifi_list_sites");
    expect(res.data).toEqual([
      { id: SITES[0]?.id, internalReference: "default", name: "Default" },
      { id: SITES[1]?.id, internalReference: "f3k9d2la", name: "Warehouse" },
    ]);
  });

  it("names the version a missing capability needs", async () => {
    const server = await connect({ probe: probeFor("9.3.45") });
    const info = await server.call("unifi_get_console_info");
    expect(info.tier).toBe("clients-plus");
    expect(JSON.stringify(info.gated_off)).toContain("10.0");
  });
});

describe("unifi_legacy_list_known_clients", () => {
  const KNOWN = [
    { mac: "aa:aa:aa:aa:aa:01", name: "Mower", oui: "Husqvarna", last_seen: 1_700_000_000 },
    { mac: "aa:aa:aa:aa:aa:02", name: "Laptop", blocked: true, last_seen: 1_780_000_000 },
    { mac: "aa:aa:aa:aa:aa:03", name: "Purifier", blocked: false, last_seen: 1_780_000_000 },
  ];

  const call = async (args: Record<string, unknown> = {}) => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/rest/user")
        ? jsonResponse({ meta: { rc: "ok" }, data: KNOWN })
        : jsonResponse(page(SITES)),
    );
    // Key auth deliberately: no login round trip for the mock to satisfy, and
    // it exercises the path this console actually uses.
    const server = await connect({
      env: { ...READY_ENV, UNIFI_ENABLE_LEGACY: "1" },
      fetchImpl: fetchMock,
    });
    return server.call("unifi_legacy_list_known_clients", args);
  };

  // The point of the tool: one call settles "is anything blocked" regardless of
  // what was filtered. A blockedCount scoped to the filtered subset would make
  // an empty result read as an all-clear, which is the wrong answer.
  it("counts blocked clients across the whole site, not the filtered subset", async () => {
    const res = await call({ search: "mower" });
    expect(res.matched).toBe(1);
    expect(res.blockedCount).toBe(1);
    expect(res.everBlockedCount).toBe(2);
    expect(res.totalKnown).toBe(3);
  });

  it("matches on vendor, not just name", async () => {
    expect((await call({ search: "husqvarna" })).matched).toBe(1);
  });

  it("separates currently-blocked from ever-blocked", async () => {
    expect((await call({ blocked: "only" })).matched).toBe(1);
    expect((await call({ blocked: "everBlocked" })).matched).toBe(2);
  });
});

const LEGACY_KEY_ENV = { ...READY_ENV, UNIFI_ENABLE_LEGACY: "1" };
const rcOk = (data: unknown[]) => jsonResponse({ meta: { rc: "ok" }, data });

/** Serves the four legacy reads the composite tools fan out to. */
const legacyServer = async (routes: {
  user?: unknown[];
  sta?: unknown[];
  health?: unknown[];
  device?: unknown[];
  wlanconf?: unknown[];
}) => {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    for (const [key, rows] of Object.entries(routes)) {
      if (u.includes(`/${key.replace("wlanconf", "rest/wlanconf")}`)) return rcOk(rows ?? []);
    }
    if (u.includes("/rest/user")) return rcOk(routes.user ?? []);
    if (u.includes("/stat/sta")) return rcOk(routes.sta ?? []);
    if (u.includes("/stat/health")) return rcOk(routes.health ?? []);
    if (u.includes("/stat/device")) return rcOk(routes.device ?? []);
    if (u.includes("/rest/wlanconf")) return rcOk(routes.wlanconf ?? []);
    return jsonResponse(page(SITES));
  });
  return connect({ env: LEGACY_KEY_ENV, fetchImpl: fetchMock });
};

describe("unifi_diagnose_client", () => {
  const MOWER = "14:5d:34:1a:62:da";
  const USERS = [
    { mac: "aa:aa:aa:aa:aa:01", name: "Laptop", blocked: true, last_seen: 1_780_000_000 },
    { mac: "aa:aa:aa:aa:aa:02", name: "Fridge", last_seen: 1_780_000_000 },
  ];

  const diagnose = async (device: string, sta: string[] = []) =>
    (await legacyServer({ user: USERS, sta: sta.map((mac) => ({ mac })) })).call(
      "unifi_diagnose_client",
      { device },
    );

  // The case that matters. A device rejected at the 802.11 auth frame never
  // gets a client record, so "not found" is the EXPECTED appearance of the most
  // common hard failure, not a dead end. If this degrades to a bare "no match"
  // the tool has lost its whole reason to exist.
  it("treats a completely unknown device as a diagnosis, not a shrug", async () => {
    const res = await diagnose(MOWER);
    expect(res.found).toBe(false);
    expect(res.verdict).toBe("absent");
    expect(res.explanation).toMatch(/orphaned block/i);
    expect(res.explanation).toMatch(/blocked_sta/);
    expect(res.explanation).toMatch(/unifi_legacy_unblock_client/);
    // The remedy is only actionable with the MAC substituted in.
    expect(res.explanation).toContain(MOWER);
    expect(res.explanation).not.toContain("<mac>");
  });

  it("reports a blocked client as the cause", async () => {
    const res = await diagnose("Laptop");
    expect(res.found).toBe(true);
    expect((res.results as { verdict: string }[])[0]?.verdict).toBe("blocked");
  });

  it("distinguishes connected from known-but-offline", async () => {
    const live = await diagnose("Fridge", ["aa:aa:aa:aa:aa:02"]);
    expect((live.results as { verdict: string }[])[0]?.verdict).toBe("connected");
    const off = await diagnose("Fridge");
    expect((off.results as { verdict: string }[])[0]?.verdict).toBe("known_offline");
  });

  // A MAC typed in any common spelling must reach the canonical roster form, or
  // the tool answers "absent" for a device sitting right in front of it.
  it("matches a MAC however it is spelled", async () => {
    for (const spelling of ["AA:AA:AA:AA:AA:01", "aaaaaaaaaa01", "aa-aa-aa-aa-aa-01"]) {
      expect((await diagnose(spelling)).found).toBe(true);
    }
  });
});

describe("unifi_health_check", () => {
  it("reports ok on a clean network", async () => {
    const server = await legacyServer({ health: [{ subsystem: "wan", status: "ok" }] });
    const res = await server.call("unifi_health_check", {});
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it("warns on a degraded subsystem and an open SSID, ranking warnings first", async () => {
    const server = await legacyServer({
      health: [{ subsystem: "wlan", status: "error", num_disconnected: 2 }],
      wlanconf: [{ name: "Guest", enabled: true, security: "open" }],
      device: [{ name: "AP1", state: 1, upgradable: true }],
    });
    const res = await server.call("unifi_health_check", {});
    expect(res.ok).toBe(false);
    const findings = res.findings as { severity: string }[];
    expect(findings[0]?.severity).toBe("warn");
    expect(findings.at(-1)?.severity).toBe("note");
    expect(JSON.stringify(findings)).toMatch(/OPEN \(no encryption\)/);
  });

  // A paused SSID is invisible from the client side: anything provisioned onto
  // it simply stops finding a network.
  it("surfaces a disabled SSID", async () => {
    const server = await legacyServer({ wlanconf: [{ name: "JavaPublic", enabled: false }] });
    const res = await server.call("unifi_health_check", {});
    expect(JSON.stringify(res.findings)).toMatch(/disabled or paused/);
  });

  // The regression this tool was built to make impossible and then caused
  // itself. Every legacy read rejected, and it answered `ok: true` with an
  // empty summary — a console refusing every request, reported as a healthy
  // network. `ok` was `findings.every(...)` over an empty array.
  it("reports a wholly rejected transport as broken, not as healthy", async () => {
    // A bare 401 with no `meta.msg` is what a rejected API key actually looks
    // like on this API — `api.err.LoginRequired` is the cookie-session flavour.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/api/s/")
        ? jsonResponse({}, { status: 401 })
        : jsonResponse(page(SITES)),
    );
    const server = await connect({ env: LEGACY_KEY_ENV, fetchImpl: fetchMock });
    const res = await server.call("unifi_health_check", {});

    expect(res.ok).toBe(false);
    expect(res.unavailable).toEqual(["health", "devices", "wlans", "roster"]);
    const findings = res.findings as { severity: string; area: string; detail: string }[];
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.severity === "warn" && f.area === "transport")).toBe(true);
    // The remedy the legacy client already attaches to a 401 must survive the
    // trip: without it the reader is told "something failed" and nothing else.
    expect(JSON.stringify(findings)).toMatch(/401/);
    expect(JSON.stringify(findings)).toMatch(/UNIFI_API_KEY|session was rejected/);

    // A count of zero is a claim about the network; these must not make it.
    const summary = res.summary as Record<string, unknown>;
    expect(summary.subsystems).toBeNull();
    expect(summary.devices).toBeNull();
    expect(summary.wifi).toBeNull();
    expect(summary.clients).toBeNull();
  });

  // The other half of the same rule: one dead endpoint must not cost the other
  // three, or fixing the silence above would just trade it for a hard failure.
  it("still answers when one read fails, and names the one that did", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      // 403, not 500: a 5xx is retried with backoff and would spend the whole
      // test budget sleeping. What is under test is the degradation, not the
      // retry policy.
      if (u.includes("/stat/device"))
        return jsonResponse({ meta: { rc: "error" } }, { status: 403 });
      if (u.includes("/stat/health")) return rcOk([{ subsystem: "wan", status: "ok" }]);
      if (u.includes("/api/s/")) return rcOk([]);
      return jsonResponse(page(SITES));
    });
    const server = await connect({ env: LEGACY_KEY_ENV, fetchImpl: fetchMock });
    const res = await server.call("unifi_health_check", {});

    expect(res.unavailable).toEqual(["devices"]);
    expect(res.ok).toBe(false);
    // The three that answered still report; only the dead one goes null.
    expect(res.summary).toMatchObject({ subsystems: { wan: "ok" }, devices: null });
    expect((res.summary as { clients: unknown }).clients).not.toBeNull();
  });
});

describe("new-device detection and the troubleshooting resource", () => {
  it("firstSeenWithinDays finds recent arrivals, newest first", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const server = await legacyServer({
      user: [
        { mac: "aa:00:00:00:00:01", name: "Old", first_seen: now - 400 * day, last_seen: now },
        { mac: "aa:00:00:00:00:02", name: "New", first_seen: now - 2 * day, last_seen: now },
        { mac: "aa:00:00:00:00:03", name: "Newest", first_seen: now - day, last_seen: now },
      ],
    });
    const res = await server.call("unifi_legacy_list_known_clients", { firstSeenWithinDays: 7 });
    // A device online for a year is not "new" however recently it was seen —
    // the whole point of keying off first sighting rather than last.
    expect((res.data as { name: string }[]).map((r) => r.name)).toEqual(["Newest", "New"]);
  });

  it("serves the troubleshooting notes even with no credentials", async () => {
    // Unconditional on purpose: the notes explain failures that happen when
    // nothing is configured, so gating them hides them exactly when needed.
    const server = await connect({ env: {}, probe: ASSUMED_PROBE });
    const list = await server.client.listResources();
    expect(list.resources.map((r) => r.uri)).toContain("unifi://troubleshooting");

    const read = await server.client.readResource({ uri: "unifi://troubleshooting" });
    const text = String((read.contents[0] as { text: string }).text);
    for (const trap of ["blocked_sta", "NOT_A_REAL_VALUE", "last ASSOCIATION", "live roster"]) {
      expect(text).toContain(trap);
    }
  });
});

describe("prompts (the client's slash commands)", () => {
  it("offers the three prompts even with no credentials", async () => {
    const server = await connect({ env: {}, probe: ASSUMED_PROBE });
    const names = (await server.client.listPrompts()).prompts.map((p) => p.name).toSorted();
    expect(names).toEqual(["diagnose-client", "network-health", "new-devices"]);
  });

  it("diagnose-client steers away from the live client list", async () => {
    const server = await connect({ env: {}, probe: ASSUMED_PROBE });
    const res = await server.client.getPrompt({
      name: "diagnose-client",
      arguments: { device: "husqvarna" },
    });
    const first = res.messages[0];
    const text = first ? String((first.content as { text: string }).text) : "";
    expect(text).toContain("husqvarna");
    // The whole point: starting at unifi_list_clients returns nothing and reads
    // like an all-clear, which is how this went wrong the first time.
    expect(text).toMatch(/not unifi_list_clients/);
    expect(text).toMatch(/absent is a diagnosis/i);
  });

  // Prompt arguments are strings in the protocol, so a numeric one has to be
  // parsed, and a missing or junk value must fall back rather than error — a
  // slash command that fails on a blank argument is worse than one that assumes.
  it("new-devices parses its day count and defaults sanely", async () => {
    const server = await connect({ env: {}, probe: ASSUMED_PROBE });
    const textFor = async (args: Record<string, string>) => {
      const res = await server.client.getPrompt({ name: "new-devices", arguments: args });
      const first = res.messages[0];
      return first === undefined ? "" : String((first.content as { text: string }).text);
    };

    expect(await textFor({ days: "30" })).toContain("firstSeenWithinDays=30");
    const junkArgs: Record<string, string>[] = [
      {},
      { days: "" },
      { days: "banana" },
      { days: "-3" },
    ];
    for (const junk of junkArgs) {
      expect(await textFor(junk)).toContain("firstSeenWithinDays=7");
    }
  });
});

describe("a 401 that no retry can fix", () => {
  // Key auth is stateless: there is no session to invalidate, so re-sending a
  // request the console has already refused only multiplies the failure.
  it("is sent once in key mode, not maxRetries+1 times", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/api/s/")
        ? jsonResponse({}, { status: 401 })
        : jsonResponse(page(SITES)),
    );
    const server = await connect({
      env: { ...READY_ENV, UNIFI_ENABLE_LEGACY: "1" },
      fetchImpl: fetchMock,
    });
    const res = await server.call("unifi_legacy_get_health", {});

    expect(res.isToolError).toBe(true);
    expect(server.urls().filter((u) => u.includes("/stat/health"))).toHaveLength(1);
  });
});
