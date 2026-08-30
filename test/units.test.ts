import { describe, expect, it, vi } from "vitest";

import { summarizeLegacyDevice, summarizeLegacyEvent } from "../src/client/legacy-shape.js";
import { summarizeDevice, unwrapPage, wrapCollected } from "../src/client/shape.js";
import { createHttpFetch } from "../src/client/tls.js";
import { and, eq, inSet, like, not, or, quote } from "../src/filter.js";
import { macCompact, normalizeMac } from "../src/mac.js";
import { atLeast, describeTierGap, floorOf, parseVersion, tierFor } from "../src/version.js";

describe("version tiers", () => {
  it("maps a version to what it unlocks", () => {
    expect(tierFor("9.0.99")).toBe("core");
    expect(tierFor("9.3.45")).toBe("clients-plus");
    expect(tierFor("9.5.21")).toBe("clients-plus");
    expect(tierFor("10.0.162")).toBe("network-config");
    expect(tierFor("10.1.84")).toBe("routing");
    expect(tierFor("10.6.101")).toBe("full");
  });

  it("assumes the newest tier for an unknown version", () => {
    // Under-registering is invisible; over-registering explains itself.
    expect(tierFor(undefined)).toBe("full");
    expect(tierFor("not-a-version")).toBe("full");
  });

  it("compares numerically, not as strings", () => {
    // "10.10.0" > "10.9.0" is false as a string comparison, and that is the
    // bug parseVersion exists not to have.
    expect(parseVersion("10.10.0")).toEqual([10, 10]);
    expect(tierFor("10.10.0")).toBe("full");
    expect(tierFor("9.10.0")).toBe("clients-plus");
  });

  it("orders tiers", () => {
    expect(atLeast("full", "core")).toBe(true);
    expect(atLeast("core", "network-config")).toBe(false);
    expect(atLeast("clients-plus", "clients-plus")).toBe(true);
    expect(floorOf("network-config")).toBe("10.0");
  });

  it("names the version a gap needs", () => {
    expect(describeTierGap("network-config", "9.3.45")).toContain("10.0");
    expect(describeTierGap("network-config", "9.3.45")).toContain("9.3.45");
    expect(describeTierGap("full", undefined)).toContain("UNIFI_APP_VERSION");
  });
});

describe("MAC normalization", () => {
  it("accepts every format seen in the wild", () => {
    for (const input of [
      "AA:BB:CC:DD:EE:FF",
      "aabbccddeeff",
      "aa-bb-cc-dd-ee-ff",
      "aabb.ccdd.eeff",
      " AA:bb:CC:dd:EE:ff ",
    ]) {
      expect(normalizeMac(input)).toBe("aa:bb:cc:dd:ee:ff");
    }
    expect(macCompact("AA:BB:CC:DD:EE:FF")).toBe("aabbccddeeff");
  });

  it("refuses garbage readably rather than passing it upstream", () => {
    expect(() => normalizeMac("not-a-mac")).toThrow(/12 hex digits/);
    expect(() => normalizeMac("aabbccddee")).toThrow(/12 hex digits/);
  });
});

describe("filter grammar", () => {
  it("quotes strings and doubles an embedded quote", () => {
    // A backslash is NOT an escape here — using one silently produces a filter
    // that parses as something else.
    expect(quote("O'Brien")).toBe("'O''Brien'");
    expect(eq("name", "lab")).toBe("name.eq('lab')");
    expect(eq("firmwareUpdatable", true)).toBe("firmwareUpdatable.eq(true)");
    expect(like("name", "*lab*")).toBe("name.like('*lab*')");
    expect(inSet("id", [1, 2])).toBe("id.in(1,2)");
  });

  it("collapses zero and one clause rather than emitting and(x)", () => {
    expect(and()).toBeUndefined();
    expect(and(undefined, undefined)).toBeUndefined();
    expect(and(eq("a", "1"))).toBe("a.eq('1')");
    expect(and(eq("a", "1"), eq("b", "2"))).toBe("and(a.eq('1'),b.eq('2'))");
    expect(or(eq("a", "1"), eq("b", "2"))).toBe("or(a.eq('1'),b.eq('2'))");
    expect(not(undefined)).toBeUndefined();
    expect(not(eq("a", "1"))).toBe("not(a.eq('1'))");
  });
});

describe("response shaping", () => {
  it("emits nextOffset only when a page remains", () => {
    // The boundary is the off-by-one worth pinning: at exactly totalCount there
    // is nothing more, and a nextOffset there sends the caller after an empty page.
    expect(unwrapPage({ offset: 0, limit: 2, count: 2, totalCount: 5, data: [1, 2] })).toEqual({
      data: [1, 2],
      totalCount: 5,
      nextOffset: 2,
    });
    expect(unwrapPage({ offset: 3, limit: 2, count: 2, totalCount: 5, data: [4, 5] })).toEqual({
      data: [4, 5],
      totalCount: 5,
    });
  });

  it("drops the pagination echo entirely", () => {
    const shaped = unwrapPage({ offset: 0, limit: 50, count: 1, totalCount: 1, data: [{}] });
    expect(shaped).not.toHaveProperty("offset");
    expect(shaped).not.toHaveProperty("limit");
    expect(shaped).not.toHaveProperty("count");
  });

  it("explains a truncated collection instead of silently cutting it", () => {
    const shaped = wrapCollected({ data: [1, 2], totalCount: 900, truncated: true });
    expect(shaped.truncated).toBe(true);
    expect(String(shaped.note)).toContain("filter");
  });

  it("trims the nested blocks from a listed device but keeps the rest", () => {
    const shaped = summarizeDevice({
      id: "d1",
      name: "AP",
      macAddress: "AA:BB:CC:DD:EE:FF",
      state: "ONLINE",
      features: { switching: {} },
      interfaces: { ports: [] },
    }) as Record<string, unknown>;
    expect(shaped).not.toHaveProperty("features");
    expect(shaped).not.toHaveProperty("interfaces");
    expect(shaped.state).toBe("ONLINE");
    expect(shaped.macAddress).toBe("aa:bb:cc:dd:ee:ff");
  });
});

describe("legacy projection", () => {
  it("drops the tables that dominate a device payload", () => {
    const raw = {
      _id: "1",
      mac: "aa:bb:cc:dd:ee:ff",
      name: "USW",
      model: "US8P150",
      state: 1,
      port_table: Array.from({ length: 8 }, (_, i) => ({ port_idx: i, ...bigObject() })),
      radio_table: [bigObject()],
      ethernet_table: [bigObject()],
      sys_stats: bigObject(),
      uplink: bigObject(),
    };
    const shaped = summarizeLegacyDevice(raw) as Record<string, unknown>;
    expect(shaped.portCount).toBe(8);
    expect(shaped.radioCount).toBe(1);
    for (const dropped of ["port_table", "radio_table", "ethernet_table", "sys_stats", "uplink"]) {
      expect(shaped).not.toHaveProperty(dropped);
    }
    // The point of the exercise: an order-of-magnitude smaller payload.
    expect(JSON.stringify(shaped).length).toBeLessThan(JSON.stringify(raw).length / 10);
  });

  it("keeps the fields an event is actually read for", () => {
    const shaped = summarizeLegacyEvent({
      _id: "e1",
      key: "EVT_WU_Connected",
      msg: "User connected",
      time: 1,
      datetime: "2026-08-30T00:00:00Z",
      subsystem: "wlan",
      noise: "x".repeat(500),
    }) as Record<string, unknown>;
    expect(shaped.key).toBe("EVT_WU_Connected");
    expect(shaped).not.toHaveProperty("noise");
  });
});

describe("TLS", () => {
  it("uses the platform fetch untouched when verification stays on", () => {
    // The insecure branch needs a real socket to exercise, so it is verified
    // manually against a console rather than here.
    expect(createHttpFetch({ insecureTls: false })).toBe(fetch);
    expect(createHttpFetch({ insecureTls: true, logger: { warn: vi.fn() } })).not.toBe(fetch);
  });
});

const bigObject = (): Record<string, number> =>
  Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_${i}`, i]));
