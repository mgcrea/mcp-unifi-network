import { describe, expect, it, vi } from "vitest";

import { SiteResolutionError, StatsUnavailableError } from "#/client/errors";
import { UnifiLegacyClient } from "#/client/legacy";
import { buildFilter, StatsEngine } from "#/client/stats";
import { BUCKET_MS, rollup, ruleFor } from "#/client/stats-rollup";
import type { StatPoint } from "#/client/stats-rollup";

const FIVE_MIN = 300_000;
const HOUR_START = Date.UTC(2026, 10, 18, 18, 0, 0);

/** Consecutive 5-minute points from HOUR_START, each built by `make(i)`. */
const points = (n: number, make: (i: number) => Record<string, unknown>): StatPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: HOUR_START + i * FIVE_MIN,
    duration: FIVE_MIN,
    ...make(i),
  }));

describe("rollup", () => {
  it("picks the folding rule from the metric's name", () => {
    expect(ruleFor("rxBytes")).toBe("sum");
    expect(ruleFor("roamCount")).toBe("sum");
    expect(ruleFor("rxErrorPackets")).toBe("sum");
    expect(ruleFor("failoverS")).toBe("sum");
    expect(ruleFor("durationMs")).toBe("sum");
    // Distinct counts are not additive: the same phone in twelve buckets is one phone.
    expect(ruleFor("distinctClientCount")).toBe("max");
    expect(ruleFor("avgSignalDbm")).toBe("mean");
    expect(ruleFor("avgTotalCuPct")).toBe("mean");
    expect(ruleFor("maxLatencyMs")).toBe("max");
    expect(ruleFor("minLatencyMs")).toBe("min");
    expect(ruleFor("mostCommonRadioProtocol")).toBe("mode");
  });

  it("exposes the engine's bucket sizes", () => {
    expect(BUCKET_MS).toEqual({
      HOUR: 300_000,
      DAY: 300_000,
      WEEK: 3_600_000,
      MONTH: 28_800_000,
    });
  });

  it("folds twelve 5-minute buckets into one hour", () => {
    const out = rollup(
      points(12, (i) => ({ rxBytes: 100, avgSignalDbm: i % 2 === 0 ? -60 : -70 })),
      "hour",
      FIVE_MIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      t: new Date(HOUR_START).toISOString(),
      spanMs: 3_600_000,
      rxBytes: 1200,
      avgSignalDbm: -65,
    });
    expect(out[0]?.partial).toBeUndefined();
  });

  it("weights a mean by bucket duration and flags the partial newest bucket", () => {
    const out = rollup(
      [
        { timestamp: HOUR_START, duration: FIVE_MIN, avgSignalDbm: -60 },
        { timestamp: HOUR_START + FIVE_MIN, duration: 100_000, avgSignalDbm: -90 },
      ],
      "total",
      FIVE_MIN,
    );
    expect(out[0]?.avgSignalDbm).toBe(-67.5);
    expect(out[0]?.partial).toBe(true);
  });

  it("leaves an absent value out of the mean instead of counting it as zero", () => {
    const out = rollup(
      points(3, (i) => (i === 1 ? { rxBytes: 5 } : { rxBytes: 5, avgSignalDbm: -50 })),
      "total",
      FIVE_MIN,
    );
    expect(out[0]?.avgSignalDbm).toBe(-50);
    expect(out[0]?.rxBytes).toBe(15);
  });

  it("folds nested groups per key", () => {
    const out = rollup(
      points(2, () => ({
        byRadioBand: [
          { radioBand: "ng", rxBytes: 10, distinctClientCount: 3 },
          { radioBand: "na", rxBytes: 0, distinctClientCount: 0 },
        ],
      })),
      "total",
      FIVE_MIN,
    );
    expect(out[0]?.byRadioBand).toEqual([
      { radioBand: "ng", rxBytes: 20, distinctClientCount: 3 },
      { radioBand: "na", rxBytes: 0, distinctClientCount: 0 },
    ]);
  });

  it("takes the most frequent value of a mostCommon metric", () => {
    const out = rollup(
      points(3, (i) => ({ mostCommonRadioProtocol: i === 0 ? "AC" : "N" })),
      "total",
      FIVE_MIN,
    );
    expect(out[0]?.mostCommonRadioProtocol).toBe("N");
  });

  it("only rounds under raw: whole bytes, one decimal otherwise", () => {
    const out = rollup(
      points(1, () => ({ rxBytes: 1.6, avgSignalDbm: -64.27 })),
      "raw",
      FIVE_MIN,
    );
    expect(out[0]).toMatchObject({ rxBytes: 2, avgSignalDbm: -64.3, spanMs: FIVE_MIN });
  });

  it("groups by UTC day", () => {
    const day = 86_400_000;
    const out = rollup(
      [
        { timestamp: HOUR_START, duration: 3_600_000, rxBytes: 1 },
        { timestamp: HOUR_START + day, duration: 3_600_000, rxBytes: 2 },
      ],
      "day",
      3_600_000,
    );
    expect(out.map((p) => p.rxBytes)).toEqual([1, 2]);
  });
});

const SITE_ID = "6606f482-fa87-4302-b6c6-7ea5b78781a8";

const SCHEMAS = [
  {
    name: "wanBySite",
    keys: ["siteId"],
    values: ["rxBytes", "txBytes", "avgAvailabilityPct", "avgLatencyMs", "failoverS"],
    nested: [{ name: "byNetworkGroup", keys: ["networkGroup"], values: ["rxBytes"], nested: null }],
  },
  {
    name: "wirelessBySiteByDevice",
    keys: ["siteId", "deviceMac"],
    values: ["distinctClientCount", "rxBytes"],
    nested: [
      { name: "byRadioBand", keys: ["radioBand"], values: ["rxBytes", "txBytes"], nested: null },
    ],
  },
  {
    name: "activityBySiteByClient",
    keys: ["siteId", "clientId"],
    values: ["rxBytes", "txBytes", "durationMs", "avgSignalDbm"],
    nested: null,
  },
];

type Route = { status?: number; body: unknown };

/** A StatsEngine over a legacy client whose fetch answers by path. */
const engineWith = (routes: Record<string, Route>, now = 1_795_028_672_455) => {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname.replace("/proxy/network", "");
    const route = routes[path];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  const legacy = new UnifiLegacyClient({
    baseUrl: "https://10.0.0.1/proxy/network",
    loginUrl: "https://10.0.0.1/api/auth/login",
    username: "",
    password: "",
    apiKey: "test-key",
    userAgent: "test",
    maxRetries: 0,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { engine: new StatsEngine(legacy, { now: () => now }), fetchMock };
};

const MODERN: Record<string, Route> = {
  "/v2/api/stats/source": { body: "MODERN" },
  "/v2/api/stats/schemas": { body: SCHEMAS },
  "/v2/api/stats/recent/series": { body: [] },
  "/api/self/sites": { body: { meta: { rc: "ok" }, data: [{ _id: SITE_ID, name: "default" }] } },
};

describe("StatsEngine", () => {
  it("composes a site filter with key matches, lowercasing MACs", () => {
    expect(buildFilter(SITE_ID)).toBe(`siteId.eq('${SITE_ID}')`);
    expect(buildFilter(SITE_ID, { clientId: "92:B7:C1:1E:52:51" })).toBe(
      `and(siteId.eq('${SITE_ID}'),clientId.eq('92:b7:c1:1e:52:51'))`,
    );
  });

  it("refuses a filter value that could escape the grammar", () => {
    expect(() => buildFilter(SITE_ID, { clientId: "x') or (1" })).toThrow(/clientId/);
  });

  it("asks for period and end, never start", async () => {
    const { engine, fetchMock } = engineWith(MODERN);
    await engine.series({
      schema: "wirelessBySiteByDevice",
      siteId: SITE_ID,
      period: "DAY",
      values: ["distinctClientCount"],
      nested: "byRadioBand",
    });
    const url = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(url.pathname).toBe("/proxy/network/v2/api/stats/recent/series");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      schema: "wirelessBySiteByDevice",
      period: "DAY",
      end: "1795028672455",
      filter: `siteId.eq('${SITE_ID}')`,
      projection: "values(distinctClientCount),nested(byRadioBand)",
    });
  });

  it("rejects a value the schema does not have, naming the ones it does", async () => {
    const { engine } = engineWith(MODERN);
    await expect(
      engine.series({ schema: "wanBySite", siteId: SITE_ID, period: "DAY", values: ["bogus"] }),
    ).rejects.toThrow(/avgLatencyMs/);
  });

  it("rejects an unknown schema, listing the valid ones", async () => {
    const { engine } = engineWith(MODERN);
    await expect(engine.schema("wan")).rejects.toThrow(/wanBySite/);
  });

  it("resolves the site _id once and caches it", async () => {
    const { engine, fetchMock } = engineWith(MODERN);
    expect(await engine.siteId("default")).toBe(SITE_ID);
    expect(await engine.siteId("default")).toBe(SITE_ID);
    const selfSites = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/self/sites"));
    expect(selfSites).toHaveLength(1);
  });

  it("names the sites it knows when one has no _id", async () => {
    const { engine } = engineWith(MODERN);
    const err = await engine.siteId("warehouse").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteResolutionError);
    expect(String(err)).toContain(SITE_ID);
  });

  it("explains a 403 as the account's role", async () => {
    const { engine } = engineWith({
      ...MODERN,
      "/v2/api/stats/source": { status: 403, body: { errorCode: 403, message: "No permission" } },
    });
    const err = await engine.source().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatsUnavailableError);
    expect((err as StatsUnavailableError).reason).toBe("forbidden");
    expect(String(err)).toMatch(/Full Admin/);
  });

  it("explains a 404 as a console that predates the engine", async () => {
    const { engine } = engineWith({ ...MODERN, "/v2/api/stats/source": { status: 404, body: {} } });
    const err = await engine.source().catch((e: unknown) => e);
    expect((err as StatsUnavailableError).reason).toBe("absent");
  });

  it("refuses series on a LEGACY engine", async () => {
    const { engine } = engineWith({ ...MODERN, "/v2/api/stats/source": { body: "LEGACY" } });
    const err = await engine
      .series({ schema: "wanBySite", siteId: SITE_ID, period: "DAY", values: ["rxBytes"] })
      .catch((e: unknown) => e);
    expect((err as StatsUnavailableError).reason).toBe("legacy");
  });
});
