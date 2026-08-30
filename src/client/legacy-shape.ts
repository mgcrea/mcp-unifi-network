// Legacy controller payloads are the reason this file exists. A `stat/sta`
// client carries ~88 fields; a `stat/device` object declares ~423 across its
// nested tables, and one UDM-Pro is routinely 50-150 KB. Twenty devices returned
// raw is a blown context window, every time.
//
// Two layers, and BOTH are required:
//
//   1. `?attrs=` — server-side, so the controller never builds what we drop.
//      Saves the bytes on the wire, but it is advisory: the controller adds
//      `_id` and `site_id` back unasked, and older builds ignore it entirely.
//   2. The allowlists below — client-side, applied anyway. This is the layer
//      that actually guarantees the response size.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const LEGACY_CLIENT_ATTRS = [
  "mac",
  "hostname",
  "name",
  "oui",
  "ip",
  "network",
  "essid",
  "ap_mac",
  "sw_mac",
  "sw_port",
  "is_wired",
  "is_guest",
  "authorized",
  "blocked",
  "first_seen",
  "last_seen",
  "uptime",
  "rx_bytes",
  "tx_bytes",
  "signal",
  "satisfaction",
  "note",
] as const;

export const LEGACY_DEVICE_ATTRS = [
  "_id",
  "mac",
  "name",
  "model",
  "type",
  "ip",
  "version",
  "adopted",
  "state",
  "disabled",
  "uptime",
  "last_seen",
  "upgradable",
  "required_version",
  "num_sta",
  "satisfaction",
] as const;

const pick = (source: Rec, keys: readonly string[]): Rec => {
  const out: Rec = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
};

export const summarizeLegacyClient = (client: unknown): unknown =>
  isRecord(client) ? pick(client, LEGACY_CLIENT_ATTRS) : client;

/**
 * `port_table`, `radio_table`, `vap_table`, `ethernet_table`, `lldp_table` and
 * `sys_stats` are arrays of ~40-field objects and are most of a device payload
 * by weight. `attrs` cannot reliably exclude them, so they are dropped here —
 * `port_table` leaving behind only its length, which is the part anyone reads.
 */
export const summarizeLegacyDevice = (device: unknown): unknown => {
  if (!isRecord(device)) return device;
  const summary = pick(device, LEGACY_DEVICE_ATTRS);
  if (Array.isArray(device.port_table)) summary.portCount = device.port_table.length;
  if (Array.isArray(device.radio_table)) summary.radioCount = device.radio_table.length;
  return summary;
};

/** Trim an event or alarm to the fields that carry meaning in a conversation. */
export const summarizeLegacyEvent = (event: unknown): unknown => {
  if (!isRecord(event)) return event;
  return pick(event, [
    "_id",
    "key",
    "msg",
    "datetime",
    "time",
    "subsystem",
    "site_id",
    "user",
    "guest",
    "ap",
    "sw",
    "gw",
    "ssid",
    "network",
    "archived",
  ]);
};

/**
 * A known client from `rest/user` — the controller's roster of every device it
 * has ever seen, which is a different set from the connected clients the
 * Integration API returns and the only place a *former* block is recorded.
 *
 * Two traps, both of which have produced a wrong answer here already:
 *
 *  1. **`blocked` is omitted when false.** Only a client that has been blocked
 *     at some point carries the key at all, so `blocked === false` and "key
 *     absent" mean different things — the first is a device someone unblocked,
 *     the second a device never touched. `wasEverBlocked` preserves that, since
 *     it is the interesting signal when the question is "did I do this?".
 *  2. **Timestamps are seconds, not milliseconds.** `new Date(last_seen)` gives
 *     January 1970 and looks plausible enough to ship.
 */
const seconds = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

/** Legacy timestamps are UNIX seconds; `new Date(n)` on one yields 1970. */
const iso = (value: unknown): string | undefined => {
  const s = seconds(value);
  return s === undefined ? undefined : new Date(s * 1000).toISOString();
};

export const summarizeKnownClient = (client: unknown, now = Date.now()): Rec => {
  if (!isRecord(client)) return { raw: client };
  const lastSeen = seconds(client.last_seen);

  const out: Rec = {
    mac: client.mac,
    blocked: client.blocked === true,
    // Distinguishes "unblocked at some point" from "never blocked" — see above.
    wasEverBlocked: "blocked" in client,
  };
  const name = client.name ?? client.hostname;
  if (name) out.name = name;
  if (client.oui) out.oui = client.oui;
  if (client.device_name) out.fingerprint = client.device_name;
  out.isWired = client.is_wired === true;
  if (client.is_guest === true) out.isGuest = true;
  if (iso(client.first_seen)) out.firstSeen = iso(client.first_seen);
  if (iso(client.last_seen)) out.lastSeen = iso(client.last_seen);
  if (lastSeen !== undefined) {
    out.daysSinceSeen = Math.floor((now / 1000 - lastSeen) / 86400);
  }
  if (client.last_ip) out.lastIp = client.last_ip;
  if (client.last_uplink_name) out.lastUplink = client.last_uplink_name;
  if (client.last_connection_network_name) out.network = client.last_connection_network_name;
  if (client.use_fixedip === true && client.fixed_ip) out.fixedIp = client.fixed_ip;
  if (client.note) out.note = client.note;
  return out;
};
