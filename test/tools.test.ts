import { describe, expect, it, vi } from "vitest";

import { ASSUMED_PROBE } from "../src/client/probe.js";
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

  it("registers the legacy read tools when the legacy tier is enabled", async () => {
    const names = await (await connect({ env: LEGACY_ENV })).toolNames();
    expect(names.filter((n) => n.startsWith("unifi_legacy_"))).toEqual([
      "unifi_legacy_get_health",
      "unifi_legacy_list_alarms",
      "unifi_legacy_list_events",
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
