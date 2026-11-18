import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/client";
import { vi } from "vitest";
import type { Mock } from "vitest";

import { ASSUMED_PROBE } from "#/client/probe";
import type { Probe } from "#/client/probe";
import type { SiteResolver } from "#/client/sites";
import { loadConfig } from "#/config";
import type { Config } from "#/config";
import { createServer } from "#/server";
import { tierFor } from "#/version";

/**
 * Passing an absent path stops a developer's real ~/.config/unifi/config.json
 * leaking into the run — without it the suite passes here and fails in CI, or
 * worse, the reverse.
 */
export const ABSENT = "/nonexistent/unifi-config.json";

export const SITE_UUID = "661f0e6a-6a3c-4d3f-9b1a-1f2e3d4c5b6a";
export const SITE_UUID_2 = "7a2b91c4-0f1e-4a8b-9c2d-3e4f5a6b7c8d";

export const SITES = [
  { id: SITE_UUID, internalReference: "default", name: "Default" },
  { id: SITE_UUID_2, internalReference: "f3k9d2la", name: "Warehouse" },
];

/**
 * A default site is set because the seeded console has two: without one,
 * resolution correctly refuses to guess, which is its own test in sites.test.ts
 * rather than a precondition every tool test has to work around.
 */
export const READY_ENV = {
  UNIFI_HOST: "10.0.0.1",
  UNIFI_API_KEY: "test-key",
  UNIFI_SITE: "default",
};

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

export const page = (data: unknown[], totalCount = data.length, offset = 0): unknown => ({
  offset,
  limit: 50,
  count: data.length,
  totalCount,
  data,
});

export const probeFor = (version: string | undefined, over: Partial<Probe> = {}): Probe => ({
  ...ASSUMED_PROBE,
  appVersion: version,
  tier: tierFor(version),
  versionSource: version ? "probe" : "assumed",
  sites: SITES,
  ...over,
});

export type ConnectOptions = {
  env?: Record<string, string>;
  fetchImpl?: Mock;
  probe?: Probe;
};

export type Connected = {
  client: Client;
  config: Config;
  sites: SiteResolver;
  fetchMock: Mock;
  toolNames: () => Promise<string[]>;
  tool: (name: string) => Promise<Tool | undefined>;
  call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  urls: () => string[];
};

export const connect = async (opts: ConnectOptions = {}): Promise<Connected> => {
  const config: Config = loadConfig(opts.env ?? READY_ENV, ABSENT);
  const fetchMock = opts.fetchImpl ?? vi.fn(async () => jsonResponse(page([])));
  const { server, sites } = createServer({
    config,
    probe: opts.probe ?? probeFor("10.6.101"),
    fetch: fetchMock as unknown as typeof fetch,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    sites,
    fetchMock,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { rejected: true, isToolError: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
    urls: (): string[] => fetchMock.mock.calls.map((c) => String(c[0])),
  };
};

// ------------------------------------------------------------ stats engine --

/** The `/api/self/sites` `_id` of the "default" site: the stats engine's site key. */
export const STATS_SITE_ID = "6606f482-fa87-4302-b6c6-7ea5b78781a8";

/** A subset of the live 11.0.99 schema list, shaped exactly like it. */
export const STATS_SCHEMAS = [
  {
    name: "wanBySite",
    keys: ["siteId"],
    values: [
      "rxBytes",
      "txBytes",
      "avgAvailabilityPct",
      "avgLatencyMs",
      "maxLatencyMs",
      "failoverS",
    ],
    nested: [{ name: "byNetworkGroup", keys: ["networkGroup"], values: ["rxBytes"], nested: null }],
  },
  {
    name: "wirelessBySiteByDevice",
    keys: ["siteId", "deviceMac"],
    values: ["distinctClientCount", "rxBytes"],
    nested: [
      {
        name: "byRadioBand",
        keys: ["radioBand"],
        values: ["distinctClientCount", "rxBytes", "txBytes", "avgTotalCuPct"],
        nested: null,
      },
    ],
  },
  {
    name: "activityBySiteByClient",
    keys: ["siteId", "clientId"],
    values: ["rxBytes", "txBytes", "durationMs", "avgSignalDbm", "avgSatisfactionScore"],
    nested: [
      { name: "byDevice", keys: ["deviceMac"], values: ["durationMs", "rxBytes"], nested: null },
    ],
  },
  { name: "roamBySiteByClient", keys: ["siteId", "clientId"], values: ["roamCount"], nested: null },
];

/** Consecutive engine points ending just before `end`, each built by `make(i)`. */
export const statPoints = (
  n: number,
  make: (i: number) => Record<string, unknown>,
  opts: { end?: number; bucketMs?: number } = {},
): { timestamp: number; duration: number }[] => {
  const bucketMs = opts.bucketMs ?? 300_000;
  const end = opts.end ?? STATS_NOW;
  const first = Math.floor(end / bucketMs) * bucketMs - n * bucketMs;
  return Array.from({ length: n }, (_, i) => ({
    timestamp: first + i * bucketMs,
    duration: bucketMs,
    ...make(i),
  }));
};

/** The fixed "now" stats fixtures are built around. */
export const STATS_NOW = 1_795_028_672_455;
