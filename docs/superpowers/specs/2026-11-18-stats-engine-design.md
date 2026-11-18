# Network 11 statistics engine

Status: approved 2026-11-18.

## Why

UniFi Network 11 moved all time-series history to a new statistics engine under
`/v2/api/stats/*`. It is not part of the official Integration API spec. The legacy
`stat/report/*` endpoints now answer `{"meta":{"rc":"ok"},"data":[]}` permanently.

This server has never exposed history, so nothing is broken, but two kinds of question
have no answer today:

- "What happened over the last day?" Examples: WAN availability, a client's signal, roams,
  per-AP radio load.
- Failures that are only visible over a window. On 2026-11-18 the home console's
  UAP-AC-Pro "Salon" carried exactly 0 bytes and 0% channel utilisation on 5 GHz from at
  least 19:00 to 19:50. During that time 6-9 clients sat on 2.4 GHz at 50-60% channel use.
  `unifi_health_check` reported the network as healthy throughout. This is the third onset
  of the known firmware hang.

## Goals

- Expose any statistics schema through one generic, size-bounded read tool.
- Make `unifi_health_check` detect a hung radio and degraded WAN from history.
- Give `unifi_diagnose_client` a 24-hour history of the device in question.

## Non-goals

- No fallback to `stat/report` on 10.x. The server never offered history there.
- No writes. The engine is read-only.
- No caching of series data. Only metadata is cached.
- No new prompts.

## Anti-goals

- A health check that flags a radio because it had no clients for five minutes. The
  detector must require a sustained run and a dead-radio signature.
- A stats failure (403, 404, LEGACY) that breaks `unifi_health_check` or
  `unifi_diagnose_client`. Enrichment degrades to a note and never fails the tool.
- Unbounded output. One hour of `activityBySiteByClient` for 45 clients is already 62 KB.

## Facts verified on the live console (11.0.99)

- `GET /v2/api/stats/source` returns the bare JSON string `"MODERN"`.
- `GET /v2/api/stats/schemas` returns `[{name, keys[], values[], nested[{name, keys,
  values, nested}] | null}]`. There are about 30 schemas.
- `GET /v2/api/stats/recent/series?schema&period&end&filter&projection` returns
  `[{<keys...>, series:[{timestamp, duration, <values>, <nestedName>:[{<nested keys>,
  <values>}]}]}]`.
  - Bucket sizes: HOUR and DAY give 5 minutes, WEEK 1 hour, MONTH 8 hours.
  - The newest bucket is partial: its `duration` is shorter than the bucket size.
  - An `end` in the future yields `[]`.
  - `start` is ignored before 11.0.89, so only `period` and `end` are sent.
- Filters compose: `and(siteId.eq('<id>'),clientId.eq('<mac>'))` works.
- `siteId` is the `_id` from `/api/self/sites`. This is a third site identifier, distinct
  from the Integration UUID (`external_id`) and from `internalReference`/`name`.
- `clientId` is the client MAC (lowercase, colon-separated).
- `deviceMac` is the device MAC.
- `radioBand` values are `ng` (2.4 GHz) and `na` (5 GHz).
- A hung 5 GHz radio reports `rxBytes: 0, txBytes: 0, avgTotalCuPct: 0` with no
  `distinctClientCount`. A healthy idle radio still reports non-zero channel utilisation.
- The API key authenticates these paths on UniFi OS. View Only accounts get HTTP 403
  `"No permission"`, as reported by the community and not tested here.
- `stat/device?mac=` is not honoured as a filter on 11; it returns every device.

## Approaches

1. **Generic tools only:** `list_stat_schemas` plus `get_stat_series`. Cheap and complete,
   but "is my network OK?" still misses a hung radio, because nobody queries history
   unprompted.
2. **Generic tools plus enrichment of `health_check` and `diagnose_client` (chosen).** The
   two generic tools reach every schema. The detectors live where the open-ended questions
   already land.
3. **One purpose-built tool per question:** WAN history, radio history, client history.
   Friendlier, but the tool count grows with every need and most schemas stay unreachable.

## Design

### `src/client/stats.ts`: StatsEngine (legacy transport)

Built on `UnifiLegacyClient`, because the engine lives under the Network app's proxy,
the same as the v2 system-log paths.

- `source(): Promise<"MODERN" | "LEGACY">`. Cached once it succeeds.
- `schemas(): Promise<StatSchema[]>`. Cached for the process lifetime.
- `siteId(legacyName): Promise<string>`. Reads `GET /api/self/sites`, matches
  `name === legacyName`, returns `_id`, and caches the map.
- `series({schema, siteId, period, end, match, projection})`.
  - Builds `filter` as `siteId.eq('…')`, or as `and(siteId.eq('…'),<key>.eq('…'), …)`.
  - Every interpolated value must match `^[0-9a-f:-]+$`, so nothing can inject into the
    filter grammar.
  - `projection` is `values(a,b)` with an optional `,nested(x)`. Names are validated
    against the schema.
- Errors are mapped to remedies:
  - **403:** the account lacks permission; the engine needs a Full Admin role or a key
    created by one, and View Only is refused.
  - **404, or a `LEGACY` source:** this console predates the Network 11 statistics engine.

### `src/client/stats-rollup.ts`: folding buckets

`rollup(points, resolution)` groups points into `raw | hour | day | total` buckets. The rule
for each metric comes from its name:

| Pattern | Rule |
| --- | --- |
| `*Bytes`, `*Packets`, `*Count` (not `distinct*`), `durationMs`, `*S` (seconds) | sum |
| `avg*`, and `*Pct` without a prefix | mean weighted by bucket `duration` |
| `max*` / `min*` | max / min |
| `distinct*` | max (distinct counts are not additive) |
| `mostCommon*` | mode |

- Nested group arrays are rolled up the same way, matched on their key fields.
- The output marks the newest bucket `partial: true` when its duration is short.
- Numbers are rounded: byte and packet counts to integers, other numbers to 1 decimal.

### Gating (`src/version.ts`, `src/tools/index.ts`)

- New tier `stats`, with a floor of 11.0, appended after `full`.
- An unknown version resolves to the newest tier. `ASSUMED_PROBE` follows suit.
- The stats tools register only when the legacy transport is ready and
  `atLeast(tier, "stats")`.
- `unifi_get_console_info` reports them as gated off on 10.x.

### Tool `unifi_list_stat_schemas` (read-only)

Returns a compact list: `{name, keys, values, nested: [{name, keys, values, nested}]}`.

### Tool `unifi_get_stat_series` (read-only)

Inputs:

- `site`.
- `schema`. An unknown name gets an error that lists the valid ones.
- `period`: `HOUR | DAY | WEEK | MONTH`, default `DAY`.
- `end`: ISO string or epoch ms, default now.
- `client`: a MAC in any spelling, normalised. Allowed only when the schema has a `clientId`
  key.
- `device`: a MAC, or a device name resolved through `stat/device`. Allowed only when the
  schema has a `deviceMac` key.
- `values`: defaults to the schema's top-level values.
- `nested`: one group name.
- `resolution`: `auto | raw | hour | day | total`. `auto` gives HOUR→raw, DAY→hour,
  WEEK→day, MONTH→day.
- `limit`: default 10, maximum 100.

Output:

- Series are sorted by the total of the first requested value, descending.
- Each series carries its keys, plus `deviceName` for `deviceMac` schemas.
- Each series carries `points` (`t` as ISO plus values) and window `totals`.
- The top level carries `seriesTotal` and `truncated`.

### `unifi_health_check` additions

Two extra reads, both over DAY:

- `wirelessBySiteByDevice` with `values(distinctClientCount),nested(byRadioBand)`, from which
  the detector uses `rxBytes`, `txBytes`, `avgTotalCuPct` and `distinctClientCount`.
- `wanBySite` with `values(avgAvailabilityPct,failoverS,avgLatencyMs,maxLatencyMs,rxBytes,
  txBytes)`.

Hung-radio detector:

- A hang is a run of consecutive closed `na` buckets of at least 30 minutes where
  `rxBytes + txBytes == 0` and `avgTotalCuPct == 0`.
- During the run, `ng` must have had `distinctClientCount >= 1`.
- The AP must report an `na` band at all.
- A run that reaches the newest closed bucket is a **warn**, for example: "Salon's 5 GHz
  carried nothing for 50 min while 2.4 GHz served 9 clients — matches a hung radio; restart
  the AP."
- A run that ended inside the window is a **note** with its start and end, which gives an
  onset log.
- AP names come from the `stat/device` read the tool already makes.

WAN findings:

- **warn:** 24-hour availability is below 99.5%.
- **note:** failover time is above 0.
- **warn:** 24-hour average latency is above 100 ms.
- The summary gains `wan24h: {rxBytes, txBytes, availabilityPct, avgLatencyMs}`.

When history is unavailable (not registered, LEGACY, 403, 404 or a timeout), the tool
adds one note, sets `summary.wan24h: null`, and leaves `ok` unaffected.

### `unifi_diagnose_client` addition

- For up to 3 matches whose verdict is `connected` or `known_offline`, the tool adds
  `history24h`.
- Sources: `activityBySiteByClient` over DAY with `nested(byDevice)`, and
  `roamBySiteByClient`.
- Fields: `rxBytes`, `txBytes`, `avgSignalDbm`, `worstHourSignalDbm`, `avgSatisfaction`,
  `roams`, `lastActive` (the last bucket with bytes above 0), and
  `aps: [{name, mac, sharePct}]` (share is by `durationMs`).
- On failure the field becomes `history24h: {unavailable: reason}`.
- Verdicts `blocked` and `absent` get no history.

### Docs

- README: two new rows in the legacy tools table.
- README: a pitfalls entry covering two facts. On Network 11 `stat/report` is permanently
  empty and history lives under `/v2/api/stats`. Stats filters take the third site ID.

## Testing

Tests are written first and use fixtures shaped like the live responses, anonymised:

- Rollup rules.
- Filter-value validation and composition.
- Site `_id` resolution and caching.
- Registration matrix: on 10.x versus 11.x, and with versus without the legacy transport.
- Hung-radio detector:
  - an ongoing run, which warns;
  - a run that ended, which produces a note;
  - an idle radio with non-zero channel use, which produces no finding;
  - a run shorter than 30 minutes, which produces no finding.
- WAN findings.
- `diagnose_client` history, including degrading when the read fails.
- The 403 remedy text.

## Left to the builder

- Direction of rx/tx on client schemas: whether `activityBySiteByClient.rxBytes` is what the
  client received. Verify it against live `stat/sta` counters and state it in the tool
  description.
- Exact rounding.
- Internal module layout beyond the two named files.
