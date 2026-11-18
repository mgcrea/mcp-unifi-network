// UniFi Network 11 moved every time series — WAN, radios, clients, ports — to a
// new statistics engine under /v2/api/stats, and left the old
// `stat/report/*` endpoints answering `{"meta":{"rc":"ok"},"data":[]}` forever.
// It is not in the official Integration API spec, so everything here was
// established against a live 11.0.99 console:
//
//  - `GET  /v2/api/stats/source` is the bare string "MODERN" (11) or "LEGACY" (10).
//  - `GET  /v2/api/stats/schemas` lists ~30 schemas: keys, values, nested groups.
//  - `GET  /v2/api/stats/recent/series?schema&period&end&filter&projection`.
//    `start` is ignored before 11.0.89, so a window is always `period` + `end`.
//
// The site filter takes neither of the identifiers the rest of this server
// uses. It wants the `_id` of the site's `/api/self/sites` record — a THIRD
// identifier, distinct from the Integration UUID and from "default" — so it is
// resolved here and never asked of the caller.

import { SiteResolutionError, StatsUnavailableError, UnifiLegacyError } from "#/client/errors";
import type { UnifiLegacyClient } from "#/client/legacy";
import type { StatPoint } from "#/client/stats-rollup";

export type StatSchema = {
  name: string;
  keys: string[];
  values: string[];
  nested: StatSchema[] | null;
};

export type Period = "HOUR" | "DAY" | "WEEK" | "MONTH";

export type SeriesRow = Record<string, unknown> & { series: StatPoint[] };

export type SeriesRequest = {
  schema: string;
  siteId: string;
  period: Period;
  /** Epoch ms. Defaults to now; a future `end` makes the engine answer `[]`. */
  end?: number;
  /** Key matches beyond the site, e.g. `{ clientId: mac }`. */
  match?: Record<string, string>;
  values: string[];
  nested?: string;
};

/** UUIDs and MACs only: anything else could step outside the filter grammar. */
const SAFE_VALUE = /^[0-9a-f:-]+$/;

const clause = (key: string, value: string): string => {
  const lowered = value.trim().toLowerCase();
  if (!SAFE_VALUE.test(lowered)) {
    throw new Error(
      `Invalid ${key} "${value}" for a statistics filter: only a MAC address or a UUID is accepted.`,
    );
  }
  return `${key}.eq('${lowered}')`;
};

/** `siteId.eq('…')`, or `and(siteId.eq('…'),clientId.eq('…'),…)` with matches. */
export const buildFilter = (siteId: string, match: Record<string, string> = {}): string => {
  const clauses = [
    clause("siteId", siteId),
    ...Object.entries(match).map(([k, v]) => clause(k, v)),
  ];
  return clauses.length === 1 ? (clauses[0] as string) : `and(${clauses.join(",")})`;
};

const FORBIDDEN =
  "The statistics engine refused this account (HTTP 403). It needs a Full Admin role, or an API " +
  "key created by a Full Admin; View Only accounts are refused even though they can read the " +
  "rest of the console.";

const ABSENT =
  "This console predates the Network 11 statistics engine (/v2/api/stats), so no history is " +
  "available from it. Upgrade to UniFi Network 11.0 or later.";

const LEGACY =
  'The console reports its statistics source as "LEGACY", i.e. Network 10 or older, where the ' +
  "engine is not in use. History needs UniFi Network 11.0 or later.";

const describeNames = (names: string[]): string => names.join(", ");

export class StatsEngine {
  private readonly legacy: UnifiLegacyClient;
  private readonly clock: () => number;
  private cachedSource: "MODERN" | "LEGACY" | undefined;
  private cachedSchemas: StatSchema[] | undefined;
  private cachedSiteIds: Map<string, string> | undefined;

  constructor(legacy: UnifiLegacyClient, opts: { now?: () => number } = {}) {
    this.legacy = legacy;
    this.clock = opts.now ?? Date.now;
  }

  now(): number {
    return this.clock();
  }

  /** One GET, with the two statuses that mean "no engine for you" turned into remedies. */
  private async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    try {
      return await this.legacy.request<T>("GET", path, query ? { query } : {});
    } catch (err) {
      if (err instanceof UnifiLegacyError && err.status === 403) {
        throw new StatsUnavailableError("forbidden", FORBIDDEN);
      }
      if (err instanceof UnifiLegacyError && err.status === 404) {
        throw new StatsUnavailableError("absent", ABSENT);
      }
      throw err;
    }
  }

  async source(): Promise<"MODERN" | "LEGACY"> {
    if (this.cachedSource) return this.cachedSource;
    const raw = await this.get<unknown>("/v2/api/stats/source");
    const source = raw === "LEGACY" ? "LEGACY" : "MODERN";
    this.cachedSource = source;
    return source;
  }

  private async requireModern(): Promise<void> {
    if ((await this.source()) === "LEGACY") throw new StatsUnavailableError("legacy", LEGACY);
  }

  async schemas(): Promise<StatSchema[]> {
    if (this.cachedSchemas) return this.cachedSchemas;
    await this.requireModern();
    const raw = await this.get<unknown>("/v2/api/stats/schemas");
    const schemas = (Array.isArray(raw) ? raw : []) as StatSchema[];
    this.cachedSchemas = schemas;
    return schemas;
  }

  async schema(name: string): Promise<StatSchema> {
    const schemas = await this.schemas();
    const found = schemas.find((s) => s.name === name);
    if (found) return found;
    throw new Error(
      `Unknown statistics schema "${name}". This console has: ` +
        `${describeNames(schemas.map((s) => s.name))}.`,
    );
  }

  /** The site's `/api/self/sites` `_id`, keyed by its legacy name. */
  async siteId(legacyName: string): Promise<string> {
    if (!this.cachedSiteIds) {
      const raw = await this.legacy.request<unknown>("GET", "/api/self/sites");
      const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      const entries: [string, string][] = [];
      for (const row of rows) {
        const { name, ["_id"]: id } = row;
        if (typeof name === "string" && typeof id === "string") entries.push([name, id]);
      }
      this.cachedSiteIds = new Map(entries);
    }
    const id = this.cachedSiteIds.get(legacyName);
    if (id) return id;
    const known = [...this.cachedSiteIds].map(([name, _id]) => `  ${name} → ${_id}`).join("\n");
    throw new SiteResolutionError(
      `No /api/self/sites record is named "${legacyName}", so its statistics cannot be read. ` +
        `This console's sites:\n${known || "  (none returned)"}`,
    );
  }

  async series(req: SeriesRequest): Promise<SeriesRow[]> {
    const schema = await this.schema(req.schema);
    const unknown = req.values.filter((v) => !schema.values.includes(v));
    if (unknown.length > 0) {
      throw new Error(
        `Schema ${schema.name} has no value ${describeNames(unknown)}. ` +
          `Its values: ${describeNames(schema.values)}.`,
      );
    }
    const nestedNames = (schema.nested ?? []).map((n) => n.name);
    if (req.nested !== undefined && !nestedNames.includes(req.nested)) {
      throw new Error(
        `Schema ${schema.name} has no nested group ${req.nested}. ` +
          (nestedNames.length > 0
            ? `Its groups: ${describeNames(nestedNames)}.`
            : "It has no nested groups."),
      );
    }

    const projection =
      `values(${req.values.join(",")})` + (req.nested ? `,nested(${req.nested})` : "");
    const raw = await this.get<unknown>("/v2/api/stats/recent/series", {
      schema: schema.name,
      period: req.period,
      end: req.end ?? this.now(),
      filter: buildFilter(req.siteId, req.match),
      projection,
    });
    return (Array.isArray(raw) ? raw : []).filter(
      (row): row is SeriesRow =>
        typeof row === "object" && row !== null && Array.isArray((row as SeriesRow).series),
    );
  }
}
