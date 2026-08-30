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
