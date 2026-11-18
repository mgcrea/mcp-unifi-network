# Network 11 Statistics Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Network 11's `/v2/api/stats` engine. Expose it through two generic tools,
and use it in `unifi_health_check` (hung 5 GHz radio, WAN quality) and in
`unifi_diagnose_client` (24 h client history).

**Architecture:** `StatsEngine` (`src/client/stats.ts`) wraps `UnifiLegacyClient` for the
stats engine's paths. `stats-rollup.ts` folds buckets into coarser resolutions.
`stats-detect.ts` holds the pure detectors. `createServer` builds the engine when the
legacy transport exists and passes it to registration. The tools register only at the new
`stats` tier (≥ 11.0). The health and diagnose enrichments degrade to a note when the
engine is missing or refuses.

**Tech Stack:** TypeScript (ESM, `#/` imports), zod 4, `@modelcontextprotocol/server` v2, vitest, oxlint/oxfmt, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-18-stats-engine-design.md`

## Global Constraints

- Series requests send `schema`, `period`, `end`, `filter` and `projection`. They never send `start`.
- Periods: `HOUR | DAY | WEEK | MONTH`. Bucket sizes: HOUR and DAY give 300 000 ms, WEEK 3 600 000 ms, MONTH 28 800 000 ms.
- Interpolated filter values must match `/^[0-9a-f:-]+$/` (checked after lowercasing).
- `siteId` in filters is the `_id` from `GET /api/self/sites`, matched on `name === internalReference`.
- `stats` tier floor is 11.0. An unknown or unparseable version resolves to the newest tier, which is `stats`.
- `unifi_get_stat_series`: `period` defaults to `DAY`; `limit` defaults to 10, minimum 1, maximum 100.
- `resolution: "auto"` maps HOUR→raw, DAY→hour, WEEK→day, MONTH→day.
- Hung radio: at least 30 min of consecutive closed `na` buckets with `rxBytes + txBytes === 0` and `avgTotalCuPct === 0`, while `ng` has `distinctClientCount >= 1` during the run.
- WAN: **warn** when 24 h `avgAvailabilityPct < 99.5`; **note** when `failoverS > 0`; **warn** when 24 h `avgLatencyMs > 100`.
- History is never fatal. A stats failure gives one note in health, or `history24h: {unavailable}` in diagnose, and never changes `ok`.
- `history24h` is added for at most 3 matches, and only for the verdicts `connected` and `known_offline`.
- Every new tool is `readOnlyHint: true`.
- Run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` before each commit.

## Review Focus

1. Multi-site console where `/api/self/sites` has no record named after the resolved `internalReference`. Expect a `SiteResolutionError` naming the site. Never an empty series. (Task 3)
2. An empty series `[]`, from a fresh console, an `end` in the future, or a client with no history. Expect empty output with a `note`. Health raises no hung-radio finding and diagnose returns `history24h: {empty: true}`. (Tasks 4, 5, 6)
3. A gap in the timestamps, such as a controller restart that drops buckets. The detector's run must break at the gap, so a hang is never stitched together across missing data. (Task 5)
4. An AP with no `na` band (2.4-only or a mesh unit), or a non-AP device in the series. Expect no finding. (Task 5)
5. A `device` argument naming no device or several. Expect an error that lists the candidate names and MACs, rather than an unfiltered series. (Task 4)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/version.ts` (modify) | add `stats` tier |
| `src/tools/sites.ts` (modify) | capability text for `stats` |
| `src/client/probe.ts` (modify) | `ASSUMED_PROBE.tier` → newest |
| `src/client/stats-rollup.ts` (create) | pure bucket folding and rounding |
| `src/client/stats.ts` (create) | `StatsEngine`: source, schemas, site `_id`, series, error remedies |
| `src/client/errors.ts` (modify) | `StatsUnavailableError` |
| `src/client/stats-detect.ts` (create) | pure detectors: hung radio, WAN findings, client history summary |
| `src/tools/stats.ts` (create) | `unifi_list_stat_schemas`, `unifi_get_stat_series` |
| `src/tools/index.ts` (modify) | gate and register the stats tools; pass the engine to health and diagnose |
| `src/server.ts` (modify) | construct the `StatsEngine` |
| `src/tools/health.ts`, `src/tools/diagnose.ts` (modify) | enrichment |
| `test/stats.test.ts` (create) | rollup, engine and detector unit tests |
| `test/tools.test.ts`, `test/units.test.ts` (modify) | registration matrix, tool behaviour, tiers |
| `README.md` (modify) | tool rows and pitfalls entry |

---

### Task 1: `stats` tier

**Files:**
- Modify: `src/version.ts`, `src/client/probe.ts` (`ASSUMED_PROBE`), `src/tools/sites.ts` (`CAPABILITY_BY_TIER`)
- Test: `test/units.test.ts` ("version tiers")

**Interfaces:**
- Produces: `TIERS = ["core","clients-plus","network-config","routing","full","stats"]`.
- Produces: `tierFor("11.0.99") === "stats"` and `tierFor(undefined) === "stats"`.
- Produces: `floorOf("stats") === "11.0"`.

- [ ] **Step 1: Update the failing tests** in "version tiers":
  - add `expect(tierFor("11.0.99")).toBe("stats")` and `expect(tierFor("11.1.50")).toBe("stats")`;
  - keep `tierFor("10.6.101") === "full"`;
  - change the unknown-version expectations to `"stats"`;
  - add `expect(floorOf("stats")).toBe("11.0")`.
- [ ] **Step 2: Run** `pnpm vitest run test/units.test.ts`. Expect a FAIL on the new expectations.
- [ ] **Step 3: Implement.**
  - Append `"stats"` to `TIERS` and add `["stats", 11, 0]` first in `TIER_FLOOR`.
  - In `tierFor`, an unparseable version returns `TIERS[TIERS.length - 1]`.
  - `ASSUMED_PROBE.tier` becomes the same newest tier.
  - `CAPABILITY_BY_TIER.stats = "statistics history (WAN, radios, clients, ports) from the Network 11 engine"`.
  - Update the comments in `version.ts` that name `full` as the newest tier.
- [ ] **Step 4: Run** `pnpm test`. Expect everything to pass. Fix any test that asserted `"full"` for an assumed probe; the `version_source` expectations stay.
- [ ] **Step 5: Commit** `feat(version): add the Network 11 stats tier`

---

### Task 2: Bucket rollup

**Files:**
- Create: `src/client/stats-rollup.ts`
- Test: `test/stats.test.ts` (describe "rollup")

**Interfaces:**
- Produces:
  ```ts
  export type StatPoint = { timestamp: number; duration: number } & Record<string, unknown>;
  export type Resolution = "raw" | "hour" | "day" | "total";
  export type RolledPoint = { t: string; durationMs: number; partial?: true } & Record<string, unknown>;
  export const BUCKET_MS: Record<"HOUR" | "DAY" | "WEEK" | "MONTH", number>;
  export const ruleFor: (metric: string) => "sum" | "mean" | "max" | "min" | "mode";
  export const rollup: (points: StatPoint[], resolution: Resolution, bucketMs: number) => RolledPoint[];
  ```
- Rules come from the spec table. Test order: `distinct*` → max. `mostCommon*` → mode. `avg*` → mean. `max*` → max. `min*` → min. `*Pct` → mean. `*Bytes`, `*Packets`, `*Count`, `durationMs`, names ending in an uppercase `S` such as `uptimeS`/`failoverS`/`activityS` → sum. Anything else → mean.
- `mean` is weighted by `duration`. Values that are absent are skipped, and are neither counted as zero nor included in the weight.
- Nested arrays (any value that is an array of objects) are rolled up per group. Within a group, entries are matched on their non-numeric fields (for example `radioBand`) and each metric uses the same rules.
- `t` is the ISO string of the group's first `timestamp`. Grouping for `hour` and `day` uses UTC boundaries.
- `partial: true` is set when the newest raw point's `duration < bucketMs` and that point falls in the output bucket.
- Rounding: `*Bytes` and `*Packets` → integer; other numbers → 1 decimal.

- [ ] **Step 1: Write failing tests:**
  - `ruleFor`: `rxBytes`→sum, `roamCount`→sum, `distinctClientCount`→max, `avgSignalDbm`→mean, `maxLatencyMs`→max, `minLatencyMs`→min, `mostCommonRadioProtocol`→mode, `avgTotalCuPct`→mean, `failoverS`→sum.
  - Twelve 5-min points with `rxBytes: 100` and `avgSignalDbm` alternating -60/-70 → `rollup(.., "hour", 300_000)` gives one point with `rxBytes: 1200`, `avgSignalDbm: -65`, `durationMs: 3_600_000`.
  - A duration-weighted mean: a full point with `-60` plus a 100 000 ms partial with `-90` gives `-67.5`, and the point is flagged `partial: true`.
  - Nested `byRadioBand` entries for `ng` and `na` are summed per band under `"total"`.
  - A missing `avgSignalDbm` in some points is excluded from the mean.
  - Under `"raw"`, numbers are only rounded: `rxBytes: 1.6` → `2`, `avgSignalDbm: -64.27` → `-64.3`.
- [ ] **Step 2: Run** `pnpm vitest run test/stats.test.ts`. Expect a FAIL (module missing).
- [ ] **Step 3: Implement** `src/client/stats-rollup.ts` to the interface above.
- [ ] **Step 4: Run** the tests. Expect a PASS.
- [ ] **Step 5: Commit** `feat(stats): fold engine buckets into coarser resolutions`

---

### Task 3: StatsEngine client

**Files:**
- Create: `src/client/stats.ts`
- Modify: `src/client/errors.ts`
- Test: `test/stats.test.ts` (describe "StatsEngine"). Construct `UnifiLegacyClient` with `apiKey` and a `vi.fn` fetch.

**Interfaces:**
- Consumes: `UnifiLegacyClient.request`.
- Produces:
  ```ts
  export class StatsUnavailableError extends Error {
    readonly reason: "forbidden" | "absent" | "legacy";
  } // in errors.ts
  export type StatSchema = { name: string; keys: string[]; values: string[]; nested: StatSchema[] | null };
  export type Period = "HOUR" | "DAY" | "WEEK" | "MONTH";
  export type SeriesRow = Record<string, unknown> & { series: StatPoint[] };
  export class StatsEngine {
    constructor(legacy: UnifiLegacyClient, opts?: { now?: () => number });
    now(): number;
    source(): Promise<"MODERN" | "LEGACY">;
    schemas(): Promise<StatSchema[]>;
    schema(name: string): Promise<StatSchema>; // throws Error listing valid names
    siteId(legacyName: string): Promise<string>;
    series(req: { schema: string; siteId: string; period: Period; end?: number;
                  match?: Record<string, string>; values: string[]; nested?: string }): Promise<SeriesRow[]>;
  }
  export const buildFilter: (siteId: string, match?: Record<string, string>) => string;
  ```
- Behaviour:
  - Filter: `siteId.eq('<id>')` alone, otherwise `and(siteId.eq('<id>'),<k>.eq('<v>'),…)`. Values are lowercased and must match `/^[0-9a-f:-]+$/`; anything else throws before any I/O.
  - Projection: `values(a,b)`, followed by `,nested(x)` when `nested` is set. Every value must be in the schema's `values`. `nested` must name one of the schema's `nested` groups. Otherwise throw, listing the valid names.
  - `end` defaults to `now()`.
  - `source()` and `schemas()` are cached after their first success. `siteId` caches the whole `_id` map.
  - A `source()` of `"LEGACY"` makes `series()` and `schemas()` throw `StatsUnavailableError("legacy")`.
  - Error mapping on a `UnifiLegacyError`:
    - status 403 → `StatsUnavailableError("forbidden")`. Message: the engine refused this account (HTTP 403); it needs a Full Admin role or an API key created by one, and View Only accounts are refused.
    - status 404 → `StatsUnavailableError("absent")`. Message: this console predates the Network 11 statistics engine (`/v2/api/stats`).
  - `siteId` with no matching name throws `SiteResolutionError`, listing each `name` → `_id` pair.

- [ ] **Step 1: Write failing tests:**
  - `buildFilter("6606…", {clientId: "92:B7:C1:1E:52:51"})` equals `"and(siteId.eq('6606…'),clientId.eq('92:b7:c1:1e:52:51'))"`.
  - `buildFilter` throws on `"x') or (1"`.
  - `series()` hits `/v2/api/stats/recent/series` with query `schema`, `period=DAY`, `end`, `filter` and `projection=values(rxBytes,txBytes),nested(byRadioBand)`, and no `start` key.
  - `series()` rejects an unknown value name with a message containing a valid name.
  - `siteId("default")` resolves from a `/api/self/sites` payload `[{_id:"6606…", name:"default"}]`, and a second call makes no new fetch.
  - `siteId("warehouse")` throws `SiteResolutionError` (Review Focus 1).
  - A 403 from the console → `StatsUnavailableError` with `reason === "forbidden"` and a message matching `/Full Admin/`.
  - A 404 → `reason === "absent"`.
  - `source()` → `"LEGACY"` makes `series()` reject with `reason === "legacy"`.
- [ ] **Step 2: Run.** Expect a FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect a PASS.
- [ ] **Step 5: Commit** `feat(stats): add a client for the Network 11 statistics engine`

---

### Task 4: Generic tools and registration

**Files:**
- Create: `src/tools/stats.ts`
- Modify: `src/tools/index.ts` (add `stats?: StatsEngine` to `RegisterOptions`), `src/server.ts`, `README.md` (two rows in the legacy table)
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `StatsEngine` (Task 3), `rollup` and `BUCKET_MS` (Task 2), `normalizeMac`, `siteArg`, `wrap`, and `ctx.sites.resolveLegacyName`.
- Produces: `registerStatsTools(server, stats: StatsEngine, legacy: UnifiLegacyClient, ctx: ToolContext): void`.
- Produces: `resolveDeviceMac(legacy, legacyName, input): Promise<{mac: string; name?: string}>`, exported from `src/tools/stats.ts` for reuse by Task 6.
  - It reads `stat/device` once.
  - A MAC is accepted as-is.
  - A name is matched case-insensitively, exactly first, then as a substring.
  - Zero matches or more than one throws, listing `name (mac)` for the candidates (Review Focus 5).
- Registration in `registerTools`: inside the legacy block, `if (opts.stats && atLeast(ctx.probe.tier, "stats")) registerStatsTools(...)`.
- `createServer` builds `new StatsEngine(legacy)` whenever `legacy` exists and passes it as `opts.stats`.
- `unifi_list_stat_schemas`: no inputs except `site`, which is ignored. Returns `{schemas}`.
- `unifi_get_stat_series`:
  - Inputs:
    - `site`;
    - `schema` (string);
    - `period` (enum, default DAY);
    - `end` (string ISO or number ms, optional);
    - `client` (optional; accepted only when the schema's `keys` include `clientId`, otherwise an error);
    - `device` (optional; only with a `deviceMac` key);
    - `values` (string[], optional, default `schema.values`);
    - `nested` (optional);
    - `resolution` (enum, default `auto`);
    - `limit` (1–100, default 10).
  - Output:
    - `{schema, period, resolution, end: ISO, seriesTotal, truncated?, series: [{...keys, deviceName?, totals, points}]}`.
    - `totals` = `rollup(points, "total", …)[0]` without `t`.
    - Series are sorted by `totals[values[0]]`, descending, before the limit is applied.
    - `deviceName` comes from one `stat/device` read, done only when the schema has a `deviceMac` key.
    - An empty result → `{seriesTotal: 0, series: [], note: "The engine returned no data for this window — a future \`end\`, a console with no history yet, or a key with nothing recorded."}`.
  - Description: lead with what it answers, for example "how much did X use", "when did the radio go quiet" or "WAN latency over the week"; point to `unifi_list_stat_schemas`; state the bucket sizes, the 30-day maximum and the rx/tx direction finding from Task 7.

- [ ] **Step 1: Write failing tests:**
  - Registration matrix:
    - add `"unifi_get_stat_series"` and `"unifi_list_stat_schemas"` for the legacy env with `probe: probeFor("11.0.99")`;
    - the existing "exactly this set" test at 10.6.101 stays unchanged, proving they are absent below 11.0;
    - absent without legacy even at 11.0.99.
  - Annotations test still passes (readOnly).
  - Extend `legacyServer` with an optional `stats: {source?: string; schemas?: unknown[]; series?: Record<string, unknown[]>; status?: number}` and `probe`. Route `/v2/api/stats/source`, `/v2/api/stats/schemas`, `/v2/api/stats/recent/series` (keyed by the `schema` query param) and `/api/self/sites` before the existing loop.
  - `unifi_get_stat_series` with `schema: "wanBySite", period: "HOUR"` over 12 points returns 12 raw points, with `totals.rxBytes` equal to the sum.
  - With `period: "DAY"` over 24 h of 5-min points, it returns 24 hourly points.
  - `client: "92B7C11E5251"` sends `clientId.eq('92:b7:c1:1e:52:51')` in the filter.
  - `client` on `wanBySite` → a tool error mentioning `clientId`.
  - `device: "Salon"` resolves through `stat/device` to its MAC. `device: "UAP"` with two matches → a tool error listing both names.
  - `limit: 2` over 3 series returns the top 2 by the first value and `truncated: true`, `seriesTotal: 3`.
  - An empty series → `seriesTotal: 0` and a `note` (Review Focus 2).
  - `stats.status: 403` → a tool error matching `/Full Admin/`.
- [ ] **Step 2: Run.** Expect a FAIL.
- [ ] **Step 3: Implement** the tools, the registration and the `createServer` wiring. Add the README rows in the legacy table: `unifi_list_stat_schemas` | "What history the Network 11 engine keeps", and `unifi_get_stat_series` | "History: WAN, radios, clients, ports — any schema". Note the 11.0 requirement.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Expect everything to pass.
- [ ] **Step 5: Commit** `feat(stats): add unifi_list_stat_schemas and unifi_get_stat_series`

---

### Task 5: Health check — hung radio and WAN

**Files:**
- Create: `src/client/stats-detect.ts`
- Modify: `src/tools/health.ts`, and `src/tools/index.ts` (pass `opts.stats` only when `atLeast(tier,"stats")`)
- Test: `test/stats.test.ts` (describe "detectors"), `test/tools.test.ts` ("unifi_health_check")

**Interfaces:**
- Consumes: `SeriesRow`, `StatsEngine`, `BUCKET_MS`.
- Signature change: `registerHealthTool(server, legacy, ctx, stats?: StatsEngine)`; `registerTools` passes `opts.stats` only when `atLeast(ctx.probe.tier, "stats")`.
- Produces (pure):
  ```ts
  export type RadioRun = { mac: string; name?: string; fromMs: number; toMs: number; minutes: number; ngClientsMax: number; ongoing: boolean };
  export const findHungRadios: (rows: SeriesRow[], opts: { bucketMs: number; minMinutes?: number /* 30 */ }) => RadioRun[];
  export type WanSummary = { rxBytes: number; txBytes: number; availabilityPct: number | null; avgLatencyMs: number | null; failoverS: number };
  export const summarizeWan: (rows: SeriesRow[]) => WanSummary | null; // null when no points
  ```
- `findHungRadios`:
  - Considers closed buckets only, meaning `duration === bucketMs`.
  - A run is consecutive by timestamp: the next bucket's `timestamp === previous + bucketMs`. A gap ends the run (Review Focus 3).
  - A bucket counts as dead when its `na` entry exists and has `rxBytes + txBytes === 0` and `avgTotalCuPct === 0`, and the same bucket's `ng` entry has `distinctClientCount >= 1`.
  - A row with no `na` entry in any bucket is skipped (Review Focus 4).
  - `ongoing` means the run includes the newest closed bucket.
  - `minutes = (toMs + bucketMs - fromMs) / 60000`.
- `health.ts`: when `stats` is given, read two DAY series in parallel with the four existing reads:
  - `wirelessBySiteByDevice` with `values: ["distinctClientCount"], nested: "byRadioBand"`;
  - `wanBySite` with `values: ["rxBytes","txBytes","avgAvailabilityPct","avgLatencyMs","maxLatencyMs","failoverS"]`.
  - Names come from the `stat/device` rows already read.
- Finding text, exact:
  - Ongoing run → warn `"wifi"`: `` `"${name}" 5 GHz has carried nothing for ${minutes} min (since ${HH:MM}) while 2.4 GHz served up to ${n} client(s) — this matches a hung radio. Restart the AP (unifi_restart_device).` ``
  - Ended run → note `"wifi"`: `` `"${name}" 5 GHz was silent ${HH:MM}–${HH:MM} (${minutes} min) with clients on 2.4 GHz, then recovered.` ``
  - Times use the server's local time, `HH:MM`.
  - WAN warn `"wan"`: `` `24 h WAN availability ${pct}% (below 99.5%).` ``
  - WAN note `"wan"`: `` `WAN failed over for ${s} s in the last 24 h.` ``
  - WAN warn `"wan"`: `` `24 h average WAN latency ${ms} ms.` `` when it is above 100.
- `summary.wan24h`: the `WanSummary`, or `null`.
- Any `StatsUnavailableError` or other rejection from the stats reads → one note `"history"` carrying the error message, and `wan24h: null`. It is NOT added to `unavailable` and does not change `ok`.
- `stats` absent (tier < 11 or no legacy) → no history note and `wan24h` omitted. Existing tests are unchanged.

- [ ] **Step 1: Write failing detector tests**, with a fixture builder `radioRow(mac, buckets: {na?: {rx, tx, cu}, ngClients: number}[], endMs, bucketMs = 300_000)`:
  - 10 dead buckets ending at the newest closed bucket, with `ngClients: 6` → one run, `minutes: 50`, `ongoing: true`, `ngClientsMax: 6`.
  - The same 10 dead buckets followed by 2 live ones → `ongoing: false`.
  - 5 dead buckets → no run.
  - A dead bucket with `cu: 1.2` (an idle but live radio) → no run.
  - Dead buckets but `ngClients: 0` → no run.
  - 4 dead buckets, a missing timestamp, then 4 dead → no run (gap).
  - A row whose buckets have only `ng` → no run.
  - A trailing partial bucket (`duration < bucketMs`) neither extends nor breaks the run.
  - `summarizeWan` over 2 points with availability 100 and 98 at equal duration → `availabilityPct: 99`. An empty row list → `null`.
- [ ] **Step 2: Write failing tool tests** in "unifi_health_check" (`probeFor("11.0.99")`, legacy key env):
  - An ongoing run on a device named "UAP-AC-Pro Salon" → `ok: false`, and a warn finding matching `/Salon.*5 GHz has carried nothing for 50 min/`.
  - WAN availability 98.9 → warn matching `/98.9%/`.
  - Stats `status: 403` → `ok: true` on an otherwise clean network, a note with area `"history"` matching `/Full Admin/`, and `summary.wan24h === null`.
  - Empty series → no wifi finding, and `summary.wan24h === null` (Review Focus 2).
  - The existing "reports ok on a clean network" test at 10.6.101 stays green and makes no `/v2/api/stats` request (assert on `urls()`).
- [ ] **Step 3: Run.** Expect a FAIL.
- [ ] **Step 4: Implement** `stats-detect.ts` and the health wiring. Update the `unifi_health_check` description to mention the 24 h history checks (hung 5 GHz radio, WAN availability) on Network 11.
- [ ] **Step 5: Run** the full check suite. Expect everything to pass.
- [ ] **Step 6: Commit** `feat(health): flag a hung 5 GHz radio and degraded WAN from 24 h history`

---

### Task 6: Diagnose — client history

**Files:**
- Modify: `src/client/stats-detect.ts`, `src/tools/diagnose.ts`, `src/tools/index.ts` (pass `opts.stats`)
- Test: `test/stats.test.ts`, `test/tools.test.ts` ("unifi_diagnose_client")

**Interfaces:**
- Produces (pure):
  ```ts
  export type ClientHistory = { rxBytes: number; txBytes: number; avgSignalDbm: number | null; worstHourSignalDbm: number | null;
    avgSatisfaction: number | null; roams: number; lastActive: string | null; aps: { mac: string; name?: string; sharePct: number }[] };
  export const summarizeClientHistory: (activity: SeriesRow[], roams: SeriesRow[], apNames: Map<string, string>) => ClientHistory | null;
  ```
  - `worstHourSignalDbm` is the minimum `avgSignalDbm` across `rollup(.., "hour")` points.
  - `lastActive` is the ISO time of the last bucket with `rxBytes + txBytes > 0`.
  - `aps` comes from nested `byDevice`, with each AP's share of the summed `durationMs`. Shares are rounded to integers and sorted descending.
  - Returns `null` when `activity` has no points.
- Signature change: `registerDiagnoseTool(server, legacy, ctx, stats?: StatsEngine)`, gated the same way as health.
- `diagnose.ts`: for the first 3 results whose verdict is `connected` or `known_offline`, when `stats` is given:
  - read DAY `activityBySiteByClient` (`match: {clientId: mac}`, values `rxBytes, txBytes, durationMs, avgSignalDbm, avgSatisfactionScore`, `nested: "byDevice"`) and DAY `roamBySiteByClient` (`values: ["roamCount"]`) in parallel;
  - AP names come from one `stat/device` read, shared across matches.
  - The result gets `history24h: ClientHistory`; `{empty: true}` when the summary is `null`; or `{unavailable: <error message>}` on rejection.
  - `blocked` and `absent` get no `history24h`.

- [ ] **Step 1: Write failing tests:**
  - `summarizeClientHistory` over 24 hourly-shaped points across two APs (durationMs 3:1) gives `aps[0].sharePct: 75`, `roams` equal to the sum of `roamCount`, and `worstHourSignalDbm` equal to the lowest hourly mean.
  - Diagnosing "Fridge" (known offline) at 11.0.99 with stats fixtures gives `results[0].history24h.rxBytes > 0`.
  - The same call with a stats 403 gives `history24h.unavailable` matching `/Full Admin/`, and the tool is not an error.
  - "Laptop" (blocked) has no `history24h`.
  - An empty activity series gives `history24h: {empty: true}`.
  - At 10.6.101, no `/v2/api/stats` request is made.
- [ ] **Step 2: Run.** Expect a FAIL.
- [ ] **Step 3: Implement.** Add a line to the `unifi_diagnose_client` description: on Network 11 each known device also gets its last 24 h (traffic, signal, roams, APs).
- [ ] **Step 4: Run** the full check suite. Expect everything to pass.
- [ ] **Step 5: Commit** `feat(diagnose): add a client's last 24 h from the stats engine`

---

### Task 7: Live verification and docs

**Files:**
- Modify: `README.md` (pitfalls section `## Traps worth knowing`), and `src/tools/stats.ts` (rx/tx wording)

- [ ] **Step 1: Verify the rx/tx direction live, read-only.**
  - Pick a connected wireless client.
  - Compare `stat/sta` `rx_bytes`/`tx_bytes` deltas with `activityBySiteByClient` `rxBytes`/`txBytes` over the same 5 min. Legacy `stat/sta` counts from the AP's side.
  - Record which way round the engine counts, and state it in the `unifi_get_stat_series` description: "for client schemas, rxBytes is what the client <received|sent>".
- [ ] **Step 2: Add the pitfalls entry** to the README section `## Traps worth knowing`, covering:
  - on Network 11 `stat/report/*` returns `[]` forever, and history lives under `/v2/api/stats`;
  - the stats filter takes the site `_id` from `/api/self/sites`, a third site identifier, which the tools resolve for you;
  - View Only accounts get 403.
- [ ] **Step 3: Build and smoke-test against the live console.** The user's server runs under Bastion with Keychain credentials, so if no local `UNIFI_*` env is available, ask the user to point Bastion at the branch build rather than hunting for the key.
  - Run `pnpm build`, then `node dist/cli.js` with the user's existing env, through `npx @modelcontextprotocol/inspector` or the test harness.
  - `unifi_get_stat_series schema=wanBySite period=DAY` should return 24 hourly points.
  - `unifi_health_check` should show `wan24h`. It should list the 19:00–19:50 Salon silence as a note if it is still inside the 24 h window.
  - Diagnose one known client and check `history24h`.
- [ ] **Step 4: Run** the full check suite. Expect everything to pass.
- [ ] **Step 5: Commit** `docs: document the Network 11 statistics engine`
