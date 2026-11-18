import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { UnifiLegacyClient } from "#/client/legacy";
import type { Period, SeriesRow, StatSchema, StatsEngine } from "#/client/stats";
import { BUCKET_MS, rollup } from "#/client/stats-rollup";
import type { Resolution } from "#/client/stats-rollup";
import { normalizeMac } from "#/mac";
import type { ToolContext } from "#/tools/index";
import { siteArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

const AUTO_RESOLUTION: Record<Period, Resolution> = {
  HOUR: "raw",
  DAY: "hour",
  WEEK: "day",
  MONTH: "day",
};

const EMPTY_NOTE =
  "The engine returned no data for this window — a future `end`, a console with no history " +
  "yet, or a key with nothing recorded.";

/** Every device on the site, by MAC, with the name the UI shows. */
export const readDeviceNames = async (
  legacy: UnifiLegacyClient,
  legacyName: string,
): Promise<Map<string, string>> => {
  const rows = await legacy.request<unknown[]>(
    "GET",
    `/api/s/${encodeURIComponent(legacyName)}/stat/device`,
  );
  const names = new Map<string, string>();
  for (const row of Array.isArray(rows) ? (rows as Rec[]) : []) {
    if (typeof row.mac === "string") {
      names.set(row.mac.toLowerCase(), typeof row.name === "string" ? row.name : row.mac);
    }
  }
  return names;
};

const list = (devices: { mac: string; name: string }[]): string =>
  devices.map((d) => `${d.name} (${d.mac})`).join(", ");

/**
 * A device MAC from a MAC or a name. A name is matched exactly first, then as
 * a substring, case-insensitively — and anything but exactly one match is an
 * error naming the candidates, because silently dropping the filter would
 * answer with the whole site.
 */
export const resolveDeviceMac = async (
  legacy: UnifiLegacyClient,
  legacyName: string,
  input: string,
): Promise<{ mac: string; name?: string }> => {
  try {
    return { mac: normalizeMac(input) };
  } catch {
    // Not a MAC: treat it as a name.
  }
  const names = await readDeviceNames(legacy, legacyName);
  const all = [...names].map(([mac, name]) => ({ mac, name }));
  const wanted = input.trim().toLowerCase();
  const exact = all.filter((d) => d.name.toLowerCase() === wanted);
  const matches =
    exact.length > 0 ? exact : all.filter((d) => d.name.toLowerCase().includes(wanted));
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new Error(
    matches.length === 0
      ? `No device is named like "${input}". This site's devices: ${list(all) || "(none)"}.`
      : `"${input}" matches ${matches.length} devices: ${list(matches)}. Pass one MAC or a more specific name.`,
  );
};

const parseEnd = (end: string | number | undefined): number | undefined => {
  if (end === undefined) return undefined;
  if (typeof end === "number") return end;
  const parsed = /^\d+$/.test(end.trim()) ? Number(end) : Date.parse(end);
  if (!Number.isFinite(parsed)) throw new Error(`Cannot read "${end}" as a time; pass ISO 8601.`);
  return parsed;
};

const requireKey = (schema: StatSchema, key: string, arg: string, all: StatSchema[]): void => {
  if (schema.keys.includes(key)) return;
  const fits = all.filter((s) => s.keys.includes(key)).map((s) => s.name);
  throw new Error(
    `Schema ${schema.name} has no ${key} key, so \`${arg}\` cannot narrow it. ` +
      `Schemas keyed by ${key}: ${fits.join(", ") || "(none)"}.`,
  );
};

/** A schema with its nested groups, in the shape the engine lists them. */
const compactSchema = (s: StatSchema): Rec => ({
  name: s.name,
  keys: s.keys,
  values: s.values,
  ...(s.nested && s.nested.length > 0 ? { nested: s.nested.map(compactSchema) } : {}),
});

const numberOf = (v: unknown): number => (typeof v === "number" ? v : 0);

export const registerStatsTools = (
  server: McpServer,
  stats: StatsEngine,
  legacy: UnifiLegacyClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_list_stat_schemas",
    {
      title: "UniFi: List Stat Schemas",
      description:
        "List the time series the Network 11 statistics engine keeps — WAN throughput, latency " +
        "and availability; per-AP and per-radio traffic, channel utilisation and retries; " +
        "per-client traffic, signal, satisfaction and roams; switch-port traffic and PoE; " +
        "device CPU and memory; firewall flow counts — with each schema's keys, values and " +
        "nested groups. Use it to pick the `schema`, `values` and `nested` arguments of " +
        "unifi_get_stat_series.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ({ schemas: (await stats.schemas()).map(compactSchema) })),
  );

  server.registerTool(
    "unifi_get_stat_series",
    {
      title: "UniFi: Get Stat Series",
      description:
        "History from the Network 11 statistics engine: how much a client used, when an AP's " +
        "5 GHz radio went quiet, how WAN latency and availability moved over the week, which " +
        "switch port carried what. Pick a schema from unifi_list_stat_schemas. Buckets are 5 " +
        "minutes for HOUR and DAY, 1 hour for WEEK, 8 hours for MONTH (30 days is the longest " +
        "window), folded to `resolution` here: bytes and packets are summed, averages weighted " +
        "by time, distinct counts take the maximum. Narrow with `client` or `device` rather " +
        "than reading a whole site — an unfiltered client schema is one series per client.",
      inputSchema: z.object({
        site: siteArg,
        schema: z.string().min(1).describe("Schema name, e.g. wanBySite, wirelessBySiteByDevice."),
        period: z
          .enum(["HOUR", "DAY", "WEEK", "MONTH"])
          .default("DAY")
          .describe("The window, ending at `end`. Defaults to DAY."),
        end: z
          .union([z.string(), z.number()])
          .optional()
          .describe("End of the window, ISO 8601 or epoch ms. Defaults to now."),
        client: z
          .string()
          .optional()
          .describe("Only this client, by MAC in any spelling. For schemas keyed by clientId."),
        device: z
          .string()
          .optional()
          .describe("Only this device, by MAC or name. For schemas keyed by deviceMac."),
        values: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("Which values to read. Defaults to every top-level value of the schema."),
        nested: z
          .string()
          .optional()
          .describe("One nested group to include, e.g. byRadioBand, byRadioName, byPort."),
        resolution: z
          .enum(["auto", "raw", "hour", "day", "total"])
          .default("auto")
          .describe("Fold points to this size. auto: HOUR→raw, DAY→hour, WEEK and MONTH→day."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Most series to return, busiest first by the first value. Defaults to 10."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(async () => {
        const legacyName = await ctx.sites.resolveLegacyName(args.site);
        const [schema, all, siteId] = await Promise.all([
          stats.schema(args.schema),
          stats.schemas(),
          stats.siteId(legacyName),
        ]);

        const match: Record<string, string> = {};
        if (args.client !== undefined) {
          requireKey(schema, "clientId", "client", all);
          match.clientId = normalizeMac(args.client);
        }
        if (args.device !== undefined) {
          requireKey(schema, "deviceMac", "device", all);
          match.deviceMac = (await resolveDeviceMac(legacy, legacyName, args.device)).mac;
        }

        const values = args.values ?? schema.values;
        const end = parseEnd(args.end) ?? stats.now();
        const rows = await stats.series({
          schema: schema.name,
          siteId,
          period: args.period,
          end,
          match,
          values,
          ...(args.nested ? { nested: args.nested } : {}),
        });

        const resolution =
          args.resolution === "auto" ? AUTO_RESOLUTION[args.period] : args.resolution;
        const header = {
          schema: schema.name,
          period: args.period,
          resolution,
          end: new Date(end).toISOString(),
        };
        if (rows.length === 0) return { ...header, seriesTotal: 0, series: [], note: EMPTY_NOTE };

        const names = schema.keys.includes("deviceMac")
          ? await readDeviceNames(legacy, legacyName).catch(() => new Map<string, string>())
          : new Map<string, string>();
        const bucketMs = BUCKET_MS[args.period];
        const first = values[0] as string;

        const shaped = rows.map((row: SeriesRow) => {
          const { series, ...keys } = row;
          const { t: _t, ...totals }: Rec = rollup(series, "total", bucketMs)[0] ?? { t: "" };
          const mac = typeof keys.deviceMac === "string" ? keys.deviceMac.toLowerCase() : undefined;
          return {
            ...keys,
            ...(mac && names.has(mac) ? { deviceName: names.get(mac) } : {}),
            totals,
            points: rollup(series, resolution, bucketMs),
          };
        });
        shaped.sort((a, b) => numberOf(b.totals[first]) - numberOf(a.totals[first]));

        return {
          ...header,
          seriesTotal: shaped.length,
          ...(shaped.length > args.limit ? { truncated: true } : {}),
          series: shaped.slice(0, args.limit),
        };
      }),
  );
};
