import { describe, expect, it } from "vitest";

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
