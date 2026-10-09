import { describe, expect, it, vi } from "vitest";

import {
  summarizeKnownClient,
  summarizeLegacyDevice,
  summarizeLegacyEvent,
  summarizeSystemLogEvent,
} from "#/client/legacy-shape";
import { summarizeDevice, unwrapPage, wrapCollected } from "#/client/shape";
import { createHttpFetch } from "#/client/tls";
import { and, eq, inSet, like, not, or, quote } from "#/filter";
import { macCompact, normalizeMac } from "#/mac";
import { atLeast, describeTierGap, floorOf, parseVersion, tierFor } from "#/version";

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

  // Trimmed from a real UniFi Network 9 console: the raw entry is ~1.7 KB.
  const DISCONNECT = {
    category: "CLIENT_DEVICES",
    event: "CLIENT_DISCONNECTED_WIRELESS",
    id: "6ac579e63e6ab386f4379578",
    key: "CLIENT_DISCONNECTED_WIRELESS_2",
    message_raw:
      "{CLIENT} disconnected from {WLAN}. Time Connected: {DURATION}. Data Used: {DATA_UP} " +
      "(up) / {DATA_DOWN} (down). Last Connected To: {DEVICE} at {SIGNAL_STRENGTH} dBm.",
    parameters: {
      AVG_UTILIZATION: { name: "36" },
      CHANNEL: { name: "6" },
      CLIENT: { id: "20:58:43:b9:c2:6a", ip: "192.168.8.228", name: "MSZ-AY-VGK2-1" },
      DATA_UP: { id: "137915814", name: "131.53 MB", not_actionable: true },
      DATA_DOWN: { id: "7003168", name: "6.68 MB", not_actionable: true },
      SIGNAL_STRENGTH: { name: "-59" },
      DEVICE: {
        device_fingerprint_id: 2651,
        id: "80:2a:a8:c0:27:f4",
        ip: "192.168.6.76",
        model: "UAP-AC-Pro",
        name: "UAP-AC-Pro Grenier",
        version: "6.8.2",
      },
      DURATION: { id: "1770833", name: "20d 11h", not_actionable: true },
      WLAN: { id: "6383d06288918f078bf0f3db", name: "JavaSystem" },
    },
    severity: "LOW",
    show_on_dashboard: false,
    status: "NEW",
    subcategory: "MONITORING_WIFI",
    target: "CLIENT",
    timestamp: 1_791_326_694_190,
    title_raw: "WiFi Client Disconnected",
    type: "CLIENT_CONNECTION",
  };

  it("renders a system-log entry into the sentence the console would show", () => {
    const shaped = summarizeSystemLogEvent(DISCONNECT) as Record<string, unknown>;
    expect(shaped).toEqual({
      id: "6ac579e63e6ab386f4379578",
      time: "2026-10-06T22:44:54.190Z",
      event: "CLIENT_DISCONNECTED_WIRELESS",
      title: "WiFi Client Disconnected",
      severity: "LOW",
      message:
        "MSZ-AY-VGK2-1 (20:58:43:b9:c2:6a) disconnected from JavaSystem. Time Connected: " +
        "20d 11h. Data Used: 131.53 MB (up) / 6.68 MB (down). Last Connected To: " +
        "UAP-AC-Pro Grenier at -59 dBm.",
      client: { mac: "20:58:43:b9:c2:6a", name: "MSZ-AY-VGK2-1", ip: "192.168.8.228" },
    });
    expect(JSON.stringify(shaped).length).toBeLessThan(JSON.stringify(DISCONNECT).length / 2);
  });

  it("leaves a placeholder it has no parameter for rather than dropping it", () => {
    const shaped = summarizeSystemLogEvent({
      ...DISCONNECT,
      message_raw: "{CLIENT} did {SOMETHING_NEW}",
    }) as Record<string, unknown>;
    expect(shaped.message).toBe("MSZ-AY-VGK2-1 (20:58:43:b9:c2:6a) did {SOMETHING_NEW}");
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

describe("summarizeKnownClient", () => {
  const NOW = Date.UTC(2026, 7, 30) as number;

  // The controller omits `blocked` entirely until a client has been blocked at
  // least once, so absent and false are different facts. Collapsing them loses
  // the only record that a block ever happened, which is exactly what an
  // "did I block this by accident?" question is asking about.
  it("separates never-blocked from unblocked", () => {
    expect(summarizeKnownClient({ mac: "a" }, NOW)).toMatchObject({
      blocked: false,
      wasEverBlocked: false,
    });
    expect(summarizeKnownClient({ mac: "b", blocked: false }, NOW)).toMatchObject({
      blocked: false,
      wasEverBlocked: true,
    });
    expect(summarizeKnownClient({ mac: "c", blocked: true }, NOW)).toMatchObject({
      blocked: true,
      wasEverBlocked: true,
    });
  });

  // Legacy timestamps are UNIX seconds. Passing one to `new Date` gives 1970,
  // which is wrong in a way that still renders as a plausible date.
  it("reads timestamps as seconds, not milliseconds", () => {
    const out = summarizeKnownClient(
      { mac: "a", first_seen: 1_669_582_112, last_seen: Math.floor(NOW / 1000) - 86_400 * 30 },
      NOW,
    );
    expect(out.firstSeen).toBe("2022-11-27T20:48:32.000Z");
    expect(out.daysSinceSeen).toBe(30);
  });

  // `last_seen` is the last ASSOCIATION and stops moving while a client stays
  // connected, so an always-on device reports an ancient one. Measured on a
  // live console: 23 of 46 connected clients looked stale, several by 100+
  // days. Reading it as "last active" declares healthy devices dead.
  it("reports a connected client as present however old its association is", () => {
    const ancient = { mac: "a", last_seen: Math.floor(NOW / 1000) - 86_400 * 120 };
    expect(summarizeKnownClient(ancient, NOW).daysSinceSeen).toBe(120);
    const live = summarizeKnownClient(ancient, NOW, true);
    expect(live.daysSinceSeen).toBe(0);
    expect(live.connectedNow).toBe(true);
    // The raw association time is still reported, under a name that says so.
    expect(live.lastAssociatedAt).toBe(new Date((NOW / 1000 - 86_400 * 120) * 1000).toISOString());
  });

  it("omits a fixed IP that is configured but not in use", () => {
    expect(summarizeKnownClient({ mac: "a", fixed_ip: "10.0.0.9" }, NOW).fixedIp).toBeUndefined();
    expect(
      summarizeKnownClient({ mac: "a", fixed_ip: "10.0.0.9", use_fixedip: true }, NOW).fixedIp,
    ).toBe("10.0.0.9");
  });
});
