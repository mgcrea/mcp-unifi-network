import { describe, expect, it, vi } from "vitest";

import { ASSUMED_PROBE } from "#/client/probe";
import type { Probe } from "#/client/probe";

import {
  connect,
  jsonResponse,
  page,
  probeFor,
  READY_ENV,
  SITE_UUID,
  SITES,
  STATS_NOW,
  STATS_SCHEMAS,
  STATS_SITE_ID,
  statPoints,
} from "./harness.js";

type Rec = Record<string, unknown>;

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

  it("adds the statistics tools on a Network 11 console with the legacy transport", async () => {
    const names = await (
      await connect({ env: LEGACY_KEY_ENV, probe: probeFor("11.0.99") })
    ).toolNames();
    expect(names).toEqual(
      expect.arrayContaining(["unifi_get_stat_series", "unifi_list_stat_schemas"]),
    );
  });

  it("offers no statistics tools without the legacy transport, even on Network 11", async () => {
    const names = await (await connect({ probe: probeFor("11.0.99") })).toolNames();
    expect(names.filter((n) => n.includes("stat_"))).toEqual([]);
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

// UniFi Network 11 carries `blocked` on every roster record, so its presence
// says nothing about the past. Reporting it anyway claimed all 292 known
// clients on a live console had been blocked at some point.
describe("unifi_legacy_list_known_clients on a roster that always carries `blocked`", () => {
  const KNOWN = [
    { mac: "aa:aa:aa:aa:aa:01", name: "Mower", blocked: false, last_seen: 1_780_000_000 },
    { mac: "aa:aa:aa:aa:aa:02", name: "Laptop", blocked: true, last_seen: 1_780_000_000 },
  ];
  const call = async (args: Record<string, unknown> = {}) =>
    (await legacyServer({ user: KNOWN })).call("unifi_legacy_list_known_clients", args);

  it("reports no ever-blocked count rather than a wrong one", async () => {
    const res = await call();
    expect(res.blockedCount).toBe(1);
    expect(res.everBlockedCount).toBeNull();
    expect(JSON.stringify(res.data)).not.toContain("wasEverBlocked");
  });

  it("says why it cannot filter on everBlocked", async () => {
    const res = await call({ blocked: "everBlocked" });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("reports `blocked` on every known client");
  });

  it("keeps diagnose_client from claiming a past block", async () => {
    const res = await (
      await legacyServer({ user: KNOWN })
    ).call("unifi_diagnose_client", {
      device: "mower",
    });
    expect(JSON.stringify(res)).not.toContain("wasEverBlocked");
  });
});

describe("unifi_legacy_list_alarms", () => {
  const CRITICAL = {
    id: "c1",
    event: "DEVICE_DISCONNECTED",
    title_raw: "Device Offline",
    severity: "HIGH",
    message_raw: "{DEVICE} is offline.",
    parameters: { DEVICE: { name: "AP Attic" } },
    timestamp: 1_791_527_721_561,
  };

  const serve = async (opts: { systemLog: boolean }) => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/system-log/")) {
        return opts.systemLog
          ? jsonResponse([CRITICAL])
          : new Response("Not Found", { status: 404 });
      }
      if (u.includes("/stat/alarm")) {
        return jsonResponse({ meta: { rc: "ok" }, data: [{ _id: "a1", key: "EVT_AP_Lost" }] });
      }
      return jsonResponse(page(SITES));
    });
    return { server: await connect({ env: LEGACY_KEY_ENV, fetchImpl: fetchMock }), fetchMock };
  };

  // Network 9+ answers 404 on stat/alarm, which made this tool fail outright
  // on current consoles. Alarms live in the system log's critical category.
  it("reads the system log's critical entries on a current console", async () => {
    const { server, fetchMock } = await serve({ systemLog: true });
    const res = await server.call("unifi_legacy_list_alarms", {});
    expect(res.isToolError).toBe(false);
    expect(res.source).toBe("system-log/critical");
    expect(res.data).toEqual([expect.objectContaining({ message: "AP Attic is offline." })]);
    const [url, init] =
      fetchMock.mock.calls.find(([u]) => String(u).includes("/system-log/")) ?? [];
    expect(String(url)).toContain("/v2/api/site/default/system-log/critical");
    expect(init?.method).toBe("POST");
  });

  it("falls back to stat/alarm on a console without the system log", async () => {
    const { server } = await serve({ systemLog: false });
    const res = await server.call("unifi_legacy_list_alarms", {});
    expect(res.isToolError).toBe(false);
    expect(res.source).toBe("stat/alarm");
    expect(res.data).toEqual([expect.objectContaining({ _id: "a1" })]);
  });
});

describe("secrets and size in the escape hatches", () => {
  const WLAN = { name: "Home", x_passphrase: "hunter22", wlan_bands: ["2g", "5g"] };
  const DEVICE = {
    name: "AP Salon",
    mac: "aa:aa:aa:aa:aa:01",
    vap_table: [{ big: 1 }],
    x_authkey: "k",
  };

  const serve = async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/rest/wlanconf")) return jsonResponse({ meta: { rc: "ok" }, data: [WLAN] });
      if (u.includes("/stat/device")) return jsonResponse({ meta: { rc: "ok" }, data: [DEVICE] });
      if (u.includes("/wifi/broadcasts/")) {
        return jsonResponse({ name: "Home", securityConfiguration: { passphrase: "hunter22" } });
      }
      return jsonResponse(page(SITES));
    });
    const server = await connect({
      env: { ...LEGACY_KEY_ENV, UNIFI_ALLOW_WRITES: "1" },
      fetchImpl: fetchMock,
    });
    return { server, fetchMock };
  };

  it("masks passphrases from either API unless asked to reveal them", async () => {
    const { server } = await serve();
    const legacy = await server.call("unifi_legacy_request", {
      path: "/api/s/default/rest/wlanconf",
    });
    expect(JSON.stringify(legacy)).not.toContain("hunter22");
    expect(JSON.stringify(legacy)).toContain("[redacted]");

    const official = await server.call("unifi_request", {
      path: `/sites/${SITE_UUID}/wifi/broadcasts/x`,
    });
    expect(JSON.stringify(official)).not.toContain("hunter22");

    const revealed = await server.call("unifi_legacy_request", {
      path: "/api/s/default/rest/wlanconf",
      revealSecrets: true,
    });
    expect(JSON.stringify(revealed)).toContain("hunter22");
  });

  it("refuses to write a masked secret back, without reaching the network", async () => {
    const { server, fetchMock } = await serve();
    const before = fetchMock.mock.calls.length;
    const res = await server.call("unifi_legacy_request", {
      method: "PUT",
      path: "/api/s/default/rest/wlanconf/1",
      body: { ...WLAN, x_passphrase: "[redacted]" },
      confirm: true,
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("masked when it was read");
    expect(fetchMock.mock.calls.slice(before).some(([u]) => String(u).includes("wlanconf"))).toBe(
      false,
    );
  });

  // `attrs` is advisory: Network 11 ignores it on stat/sta and stat/device and
  // sends 125-245 KB. `fields` is applied here, so it always holds.
  it("projects each record to the requested fields", async () => {
    const { server } = await serve();
    const res = await server.call("unifi_legacy_request", {
      path: "/api/s/default/stat/device",
      fields: ["name", "mac", "missing"],
    });
    expect(res["0"]).toEqual({ name: "AP Salon", mac: "aa:aa:aa:aa:aa:01" });
  });
});

const LEGACY_KEY_ENV = { ...READY_ENV, UNIFI_ENABLE_LEGACY: "1" };

describe("unifi_legacy_list_events", () => {
  const ENTRY = {
    id: "e1",
    event: "CLIENT_ROAMED",
    title_raw: "WiFi Client Roamed",
    severity: "LOW",
    message_raw: "{CLIENT} roamed to {DEVICE_TO}.",
    parameters: {
      CLIENT: { id: "b8:82:f2:c5:8b:38", name: "Heat pump" },
      DEVICE_TO: { name: "AP Attic" },
    },
    timestamp: 1_791_527_721_561,
  };

  /** A console that either has the v2 system log or only the old `stat/event`. */
  const serve = async (opts: { systemLog: boolean }) => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/system-log/")) {
        return opts.systemLog ? jsonResponse([ENTRY]) : new Response("Not Found", { status: 404 });
      }
      if (u.includes("/stat/event")) {
        return jsonResponse({
          meta: { rc: "ok" },
          data: [
            { _id: "o1", key: "EVT_WU_Connected", msg: "User[b8:82:f2:c5:8b:38] connected" },
            { _id: "o2", key: "EVT_WU_Connected", msg: "User[aa:aa:aa:aa:aa:aa] connected" },
          ],
        });
      }
      return jsonResponse(page(SITES));
    });
    const server = await connect({ env: LEGACY_KEY_ENV, fetchImpl: fetchMock });
    const systemLogBody = () => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/system-log/"));
      return call ? JSON.parse(String(call[1]?.body)) : undefined;
    };
    return { server, fetchMock, systemLogBody };
  };

  // UniFi Network 9 removed `stat/event`: it answers 404 there, which made this
  // tool fail outright on current consoles.
  it("reads the v2 system log and renders each entry", async () => {
    const { server } = await serve({ systemLog: true });
    const res = await server.call("unifi_legacy_list_events", {});
    expect(res.isToolError).toBe(false);
    expect(res.source).toBe("system-log");
    expect(res.data).toEqual([
      expect.objectContaining({ message: "Heat pump (b8:82:f2:c5:8b:38) roamed to AP Attic." }),
    ]);
  });

  it("asks for the window and page size the caller gave", async () => {
    vi.useFakeTimers({ now: 1_791_530_000_000, toFake: ["Date"] });
    try {
      const { server, systemLogBody } = await serve({ systemLog: true });
      await server.call("unifi_legacy_list_events", { within: 48, limit: 20 });
      expect(systemLogBody()).toEqual({
        timestampFrom: 1_791_530_000_000 - 48 * 3_600_000,
        timestampTo: 1_791_530_000_000,
        pageNumber: 0,
        pageSize: 20,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // The console ignores `macs` and `clientMacs` and returns everything;
  // `searchText` is the only filter it honours.
  it("filters by client through searchText", async () => {
    const { server, systemLogBody } = await serve({ systemLog: true });
    await server.call("unifi_legacy_list_events", { client: "B8-82-F2-C5-8B-38" });
    expect(systemLogBody().searchText).toBe("b8:82:f2:c5:8b:38");
  });

  it("passes a name fragment through as typed", async () => {
    const { server, systemLogBody } = await serve({ systemLog: true });
    await server.call("unifi_legacy_list_events", { client: "MSZ-AY" });
    expect(systemLogBody().searchText).toBe("MSZ-AY");
  });

  it("falls back to stat/event on a console without the system log", async () => {
    const { server } = await serve({ systemLog: false });
    const res = await server.call("unifi_legacy_list_events", { client: "b8:82:f2:c5:8b:38" });
    expect(res.isToolError).toBe(false);
    expect(res.source).toBe("stat/event");
    expect(res.data).toEqual([expect.objectContaining({ _id: "o1" })]);
  });
});
const rcOk = (data: unknown[]) => jsonResponse({ meta: { rc: "ok" }, data });

export type StatsFixture = {
  source?: string;
  /** Answer every /v2/api/stats path with this status (e.g. 403 for a View Only key). */
  status?: number;
  /** Series rows by schema name; a schema left out answers `[]`. */
  series?: Record<string, unknown[]>;
};

/**
 * Serves the four legacy reads the composite tools fan out to, plus the Network
 * 11 statistics engine when `stats` is given. The engine is matched FIRST:
 * "/v2/api/stats" contains "/sta", which the row routes below would claim.
 */
const legacyServer = async (
  routes: {
    user?: unknown[];
    sta?: unknown[];
    health?: unknown[];
    device?: unknown[];
    wlanconf?: unknown[];
  },
  opts: { stats?: StatsFixture; probe?: Probe } = {},
) => {
  const { stats } = opts;
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/v2/api/stats/")) {
      if (!stats) return jsonResponse({}, { status: 404 });
      if (stats.status) return jsonResponse({ errorCode: stats.status }, { status: stats.status });
      if (u.includes("/stats/source")) return jsonResponse(stats.source ?? "MODERN");
      if (u.includes("/stats/schemas")) return jsonResponse(STATS_SCHEMAS);
      const schema = new URL(u).searchParams.get("schema") ?? "";
      return jsonResponse(stats.series?.[schema] ?? []);
    }
    if (u.includes("/api/self/sites")) return rcOk([{ _id: STATS_SITE_ID, name: "default" }]);
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
  return connect({
    env: LEGACY_KEY_ENV,
    fetchImpl: fetchMock,
    ...(opts.probe ? { probe: opts.probe } : {}),
  });
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

  // "Bedroom" has two hex letters in a row, which used to be enough to be
  // taken for a MAC — and normalizing it threw, so the search never ran.
  it("searches a name that merely contains hex letters", async () => {
    const res = await diagnose("Bedroom");
    expect(res.isToolError).toBe(false);
    expect(res.verdict).toBe("absent");
  });
});

describe("unifi_diagnose_client on a wired device", () => {
  const SWITCH_MAC = "78:8a:20:7f:ac:e4";
  const SWITCH_ID = "5a05fc6d-c3cc-30c7-b13b-b049def8b54d";
  const CHIME = {
    mac: "f4:e2:c6:0c:fa:e3",
    name: "Chime",
    is_wired: true,
    last_seen: 1_780_000_000,
    last_uplink_mac: SWITCH_MAC,
    last_uplink_name: "Switch Cellar",
    last_uplink_remote_port: 8,
  };
  const PORTS = [
    { idx: 1, state: "UP", connector: "RJ45" },
    {
      idx: 8,
      state: "DOWN",
      connector: "RJ45",
      poe: { standard: "802.3af", type: 1, enabled: true, state: "DOWN" },
    },
  ];

  /** Legacy roster plus the Integration device endpoints the port lookup needs. */
  const serve = async (opts: {
    user: unknown[];
    switchFound?: boolean;
    env?: Record<string, string>;
  }) => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      if (u.includes("/rest/user")) return rcOk(opts.user);
      if (u.includes("/stat/sta")) return rcOk([]);
      if (u.includes(`/devices/${SWITCH_ID}`)) {
        return jsonResponse({ id: SWITCH_ID, name: "Switch Cellar", interfaces: { ports: PORTS } });
      }
      if (u.includes("/devices")) {
        return jsonResponse(
          page(opts.switchFound === false ? [] : [{ id: SWITCH_ID, macAddress: SWITCH_MAC }]),
        );
      }
      return jsonResponse(page(SITES));
    });
    const server = await connect({ env: opts.env ?? LEGACY_KEY_ENV, fetchImpl: fetchMock });
    const res = await server.call("unifi_diagnose_client", { device: "Chime" });
    return { res, urls: server.urls().map((u) => decodeURIComponent(u)) };
  };
  const first = (res: Record<string, unknown>) => (res.results as Record<string, unknown>[])[0];
  const lastPort = (res: Record<string, unknown>) => (first(res)?.lastPort ?? {}) as Rec;

  // The point: an offline PoE device can only be rebooted through the port it
  // is plugged into, and nothing else answers which port that was.
  it("names the switch port it was last on and how to power-cycle it", async () => {
    const { res, urls } = await serve({ user: [CHIME] });
    expect(first(res)?.verdict).toBe("known_offline");
    expect(first(res)?.lastPort).toEqual({
      switchName: "Switch Cellar",
      switchMac: SWITCH_MAC,
      switchId: SWITCH_ID,
      portIdx: 8,
      linkState: "DOWN",
      poe: { standard: "802.3af", enabled: true, state: "DOWN" },
      powerCycle: expect.stringContaining(`unifi_power_cycle_port`),
    });
    expect(String(lastPort(res).powerCycle)).toContain(SWITCH_ID);
    // Looked up by MAC on the console, not by listing every device.
    expect(urls.some((u) => u.includes(`macAddress.eq('${SWITCH_MAC}')`))).toBe(true);
  });

  it("says when writes must be enabled first", async () => {
    const { res } = await serve({ user: [CHIME] });
    expect(String(lastPort(res).powerCycle)).toMatch(/UNIFI_ALLOW_WRITES/);
    const writable = await serve({
      user: [CHIME],
      env: { ...LEGACY_KEY_ENV, UNIFI_ALLOW_WRITES: "1" },
    });
    expect(String(lastPort(writable.res).powerCycle)).not.toMatch(/UNIFI_ALLOW_WRITES/);
  });

  it("does not name a tool the console is too old to have", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url));
      if (u.includes("/rest/user")) return rcOk([CHIME]);
      if (u.includes("/stat/sta")) return rcOk([]);
      if (u.includes(`/devices/${SWITCH_ID}`))
        return jsonResponse({ interfaces: { ports: PORTS } });
      if (u.includes("/devices")) return jsonResponse(page([{ id: SWITCH_ID }]));
      return jsonResponse(page(SITES));
    });
    const server = await connect({
      env: LEGACY_KEY_ENV,
      fetchImpl: fetchMock,
      probe: probeFor("9.0.114"),
    });
    const res = await server.call("unifi_diagnose_client", { device: "Chime" });
    const port = lastPort(res);
    expect(port).not.toHaveProperty("powerCycle");
    expect(String(port.note)).toMatch(/9\.3/);
  });

  it("does not offer a power cycle on a port without PoE", async () => {
    const { res } = await serve({ user: [{ ...CHIME, last_uplink_remote_port: 1 }] });
    const port = lastPort(res);
    expect(port.portIdx).toBe(1);
    expect(port.poe).toBeNull();
    expect(port).not.toHaveProperty("powerCycle");
    expect(String(port.note)).toMatch(/no PoE/i);
  });

  // An unmanaged switch, or one adopted by another console: the roster still
  // knows the port, which is worth reporting even without a way to cycle it.
  it("still reports the port when the switch is not one this console manages", async () => {
    const { res } = await serve({ user: [CHIME], switchFound: false });
    const port = lastPort(res);
    expect(port).toMatchObject({ switchName: "Switch Cellar", switchMac: SWITCH_MAC, portIdx: 8 });
    expect(port).not.toHaveProperty("powerCycle");
  });

  it("leaves a wireless client alone", async () => {
    const { res, urls } = await serve({
      user: [{ mac: "b8:82:f2:c5:8b:38", name: "Chime", last_uplink_name: "AP Attic" }],
    });
    expect(first(res)).not.toHaveProperty("lastPort");
    expect(urls.some((u) => u.includes("/devices"))).toBe(false);
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

/** The `filter` the stats engine was sent, from the series request's URL. */
const filterOf = (urls: string[]) =>
  new URL(urls.find((u) => u.includes("/recent/series")) ?? "https://x/").searchParams.get(
    "filter",
  );

/** One client's activity series with a single bucket of `rx` bytes. */
const clientSeries = (mac: string, rx: number) => ({
  siteId: STATS_SITE_ID,
  clientId: mac,
  series: statPoints(1, () => ({ rxBytes: rx })),
});

describe("unifi_get_stat_series", () => {
  const ON_11 = { probe: probeFor("11.0.99") };
  const HOUR_ALIGNED = Math.floor(STATS_NOW / 3_600_000) * 3_600_000;

  const serve = (series: Record<string, unknown[]>, device: unknown[] = []) =>
    legacyServer({ device }, { ...ON_11, stats: { series } });

  it("returns raw 5-minute points for an hour, with totals", async () => {
    const wan = [{ siteId: STATS_SITE_ID, series: statPoints(12, () => ({ rxBytes: 10 })) }];
    const res = await (
      await serve({ wanBySite: wan })
    ).call("unifi_get_stat_series", {
      schema: "wanBySite",
      period: "HOUR",
      values: ["rxBytes"],
    });
    expect(res.isToolError).toBe(false);
    const [first] = res.series as { points: unknown[]; totals: Rec }[];
    expect(first?.points).toHaveLength(12);
    expect(first?.totals.rxBytes).toBe(120);
  });

  it("folds a day into hourly points", async () => {
    const wan = [
      {
        siteId: STATS_SITE_ID,
        series: statPoints(288, () => ({ rxBytes: 1 }), { end: HOUR_ALIGNED }),
      },
    ];
    const res = await (
      await serve({ wanBySite: wan })
    ).call("unifi_get_stat_series", {
      schema: "wanBySite",
    });
    expect(res.resolution).toBe("hour");
    expect((res.series as { points: unknown[] }[])[0]?.points).toHaveLength(24);
  });

  it("filters by client MAC however it is spelled", async () => {
    const server = await serve({});
    await server.call("unifi_get_stat_series", {
      schema: "activityBySiteByClient",
      client: "92B7C11E5251",
    });
    expect(filterOf(server.urls())).toBe(
      `and(siteId.eq('${STATS_SITE_ID}'),clientId.eq('92:b7:c1:1e:52:51'))`,
    );
  });

  it("refuses a client filter on a schema with no client key", async () => {
    const res = await (
      await serve({})
    ).call("unifi_get_stat_series", {
      schema: "wanBySite",
      client: "92:b7:c1:1e:52:51",
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toMatch(/clientId/);
  });

  const DEVICES = [
    { name: "UAP-AC-Pro Salon", mac: "80:2a:a8:49:ce:f2" },
    { name: "UAP-AC-Pro Grenier", mac: "80:2a:a8:c0:27:f4" },
  ];

  it("resolves a device by name and labels its series", async () => {
    const radio = [
      { siteId: STATS_SITE_ID, deviceMac: "80:2a:a8:49:ce:f2", series: statPoints(2, () => ({})) },
    ];
    const server = await serve({ wirelessBySiteByDevice: radio }, DEVICES);
    const res = await server.call("unifi_get_stat_series", {
      schema: "wirelessBySiteByDevice",
      device: "salon",
    });
    expect(filterOf(server.urls())).toContain("deviceMac.eq('80:2a:a8:49:ce:f2')");
    expect((res.series as Rec[])[0]?.deviceName).toBe("UAP-AC-Pro Salon");
  });

  it("lists the candidates when a device name is ambiguous", async () => {
    const res = await (
      await serve({}, DEVICES)
    ).call("unifi_get_stat_series", {
      schema: "wirelessBySiteByDevice",
      device: "UAP",
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("UAP-AC-Pro Salon (80:2a:a8:49:ce:f2)");
    expect(String(res.error)).toContain("UAP-AC-Pro Grenier");
  });

  it("names the known devices when none matches", async () => {
    const res = await (
      await serve({}, DEVICES)
    ).call("unifi_get_stat_series", {
      schema: "wirelessBySiteByDevice",
      device: "kitchen",
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("UAP-AC-Pro Salon");
  });

  it("keeps the busiest series first and says how many it dropped", async () => {
    const res = await (
      await serve({
        activityBySiteByClient: [
          clientSeries("aa:aa:aa:aa:aa:01", 5),
          clientSeries("aa:aa:aa:aa:aa:02", 50),
          clientSeries("aa:aa:aa:aa:aa:03", 20),
        ],
      })
    ).call("unifi_get_stat_series", {
      schema: "activityBySiteByClient",
      values: ["rxBytes"],
      limit: 2,
    });
    expect((res.series as Rec[]).map((s) => s.clientId)).toEqual([
      "aa:aa:aa:aa:aa:02",
      "aa:aa:aa:aa:aa:03",
    ]);
    expect(res.seriesTotal).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it("says why a window came back empty", async () => {
    const res = await (await serve({})).call("unifi_get_stat_series", { schema: "wanBySite" });
    expect(res.isToolError).toBe(false);
    expect(res.seriesTotal).toBe(0);
    expect(String(res.note)).toMatch(/no data/);
  });

  it("explains a refused account", async () => {
    const server = await legacyServer({}, { ...ON_11, stats: { status: 403 } });
    const res = await server.call("unifi_get_stat_series", { schema: "wanBySite" });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toMatch(/Full Admin/);
  });

  it("lists the schemas compactly", async () => {
    const res = await (await serve({})).call("unifi_list_stat_schemas", {});
    const schemas = res.schemas as { name: string }[];
    expect(schemas.map((s) => s.name)).toEqual(STATS_SCHEMAS.map((s) => s.name));
  });
});

/** One wirelessBySiteByDevice bucket: 2.4 GHz with clients, 5 GHz as given. */
const bands = (na: { rx: number; cu: number }, ngClients: number) => ({
  distinctClientCount: ngClients,
  byRadioBand: [
    { radioBand: "ng", distinctClientCount: ngClients, rxBytes: 9000, avgTotalCuPct: 55 },
    { radioBand: "na", rxBytes: na.rx, txBytes: na.rx, avgTotalCuPct: na.cu },
  ],
});
/** A wanBySite row of twelve buckets at the given availability. */
const wan = (availability: number) => [
  {
    siteId: STATS_SITE_ID,
    series: statPoints(12, () => ({
      rxBytes: 100,
      txBytes: 50,
      avgAvailabilityPct: availability,
      avgLatencyMs: 12,
    })),
  },
];

describe("unifi_health_check history on Network 11", () => {
  const SALON = { name: "UAP-AC-Pro Salon", mac: "80:2a:a8:49:ce:f2", state: 1 };
  const radio = (deadFrom: number, total = 24) => [
    {
      siteId: STATS_SITE_ID,
      deviceMac: SALON.mac,
      series: statPoints(total, (i) =>
        i >= deadFrom ? bands({ rx: 0, cu: 0 }, 9) : bands({ rx: 4000, cu: 3 }, 4),
      ),
    },
  ];
  const check = (series: Record<string, unknown[]>, status?: number) =>
    legacyServer(
      { device: [SALON] },
      { probe: probeFor("11.0.99"), stats: { series, ...(status ? { status } : {}) } },
    ).then((server) => server.call("unifi_health_check", {}));

  it("warns about a 5 GHz radio that is silent right now", async () => {
    const res = await check({ wirelessBySiteByDevice: radio(14), wanBySite: wan(100) });
    expect(res.ok).toBe(false);
    const wifi = (res.findings as { severity: string; area: string; detail: string }[]).find(
      (f) => f.area === "wifi",
    );
    expect(wifi?.severity).toBe("warn");
    expect(wifi?.detail).toMatch(/Salon.*5 GHz has carried nothing for 50 min/);
    expect(wifi?.detail).toMatch(/up to 9 client/);
  });

  it("reports WAN availability below 99.5%", async () => {
    const res = await check({ wanBySite: wan(98.9) });
    expect(JSON.stringify(res.findings)).toMatch(/98\.9%/);
    expect((res.summary as Rec).wan24h).toMatchObject({ availabilityPct: 98.9, rxBytes: 1200 });
  });

  it("degrades to a note when the engine refuses the account", async () => {
    const res = await check({}, 403);
    expect(res.ok).toBe(true);
    const note = (res.findings as { area: string; detail: string }[]).find(
      (f) => f.area === "history",
    );
    expect(note?.detail).toMatch(/Full Admin/);
    expect((res.summary as Rec).wan24h).toBeNull();
  });

  it("finds nothing in an empty window", async () => {
    const res = await check({});
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
    expect((res.summary as Rec).wan24h).toBeNull();
  });

  it("does not touch the engine below Network 11", async () => {
    const server = await legacyServer({ device: [SALON] }, { stats: { series: {} } });
    const res = await server.call("unifi_health_check", {});
    expect(res.ok).toBe(true);
    expect(server.urls().filter((u) => u.includes("/v2/api/stats"))).toEqual([]);
    expect((res.summary as Rec).wan24h).toBeUndefined();
  });
});

/** The first per-device result of a diagnose call. */
const firstResult = (res: Rec) => (res.results as Rec[])[0] as Rec;

describe("unifi_diagnose_client history on Network 11", () => {
  const USERS = [
    { mac: "aa:aa:aa:aa:aa:01", name: "Laptop", blocked: true, last_seen: 1_780_000_000 },
    { mac: "aa:aa:aa:aa:aa:02", name: "Fridge", last_seen: 1_780_000_000 },
  ];
  const ACTIVITY = [
    {
      siteId: STATS_SITE_ID,
      clientId: "aa:aa:aa:aa:aa:02",
      series: statPoints(12, () => ({ rxBytes: 50, txBytes: 5, avgSignalDbm: -61 })),
    },
  ];

  const diagnose = async (device: string, stats: StatsFixture, probe = probeFor("11.0.99")) => {
    const server = await legacyServer({ user: USERS }, { probe, stats });
    return { server, res: await server.call("unifi_diagnose_client", { device }) };
  };

  it("adds the last 24 h for a known device", async () => {
    const { res, server } = await diagnose("Fridge", {
      series: { activityBySiteByClient: ACTIVITY },
    });
    expect(firstResult(res).history24h).toMatchObject({ rxBytes: 600, avgSignalDbm: -61 });
    const series = server.urls().find((u) => u.includes("activityBySiteByClient")) ?? "";
    expect(decodeURIComponent(series)).toContain("clientId.eq('aa:aa:aa:aa:aa:02')");
  });

  it("says why history is missing instead of failing the diagnosis", async () => {
    const { res } = await diagnose("Fridge", { status: 403 });
    expect(res.isToolError).toBe(false);
    expect(String((firstResult(res).history24h as Rec).unavailable)).toMatch(/Full Admin/);
  });

  it("gives a blocked device no history", async () => {
    const { res } = await diagnose("Laptop", { series: { activityBySiteByClient: ACTIVITY } });
    expect(firstResult(res).verdict).toBe("blocked");
    expect(firstResult(res).history24h).toBeUndefined();
  });

  it("marks an empty day as empty", async () => {
    const { res } = await diagnose("Fridge", { series: {} });
    expect(firstResult(res).history24h).toEqual({ empty: true });
  });

  it("does not touch the engine below Network 11", async () => {
    const { res, server } = await diagnose("Fridge", { series: {} }, probeFor("10.6.101"));
    expect(firstResult(res).history24h).toBeUndefined();
    expect(server.urls().filter((u) => u.includes("/v2/api/stats"))).toEqual([]);
  });
});
