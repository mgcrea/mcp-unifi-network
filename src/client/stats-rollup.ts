// The statistics engine answers in fixed buckets — 5 minutes for HOUR and DAY —
// so a day of one metric is 289 points. That is far more than a reader needs and
// far more than a tool result should carry, so points are folded here into
// hours, days or a single total.
//
// How a metric folds is decided by its NAME, because the engine names them
// consistently and a schema can add metrics this server has never seen: bytes
// and packets add up, averages are weighted by how long each bucket lasted, and
// distinct counts take the maximum — the same phone seen in twelve buckets is
// one phone, not twelve.

export type StatPoint = { timestamp: number; duration: number } & Record<string, unknown>;

export type Resolution = "raw" | "hour" | "day" | "total";

/** A folded point. `spanMs` is the time it covers; `partial` marks a bucket still filling. */
export type RolledPoint = { t: string; spanMs: number; partial?: true } & Record<string, unknown>;

export type Rule = "sum" | "mean" | "max" | "min" | "mode";

/** The engine's bucket size for each period. HOUR and DAY share 5-minute buckets. */
export const BUCKET_MS = {
  HOUR: 300_000,
  DAY: 300_000,
  WEEK: 3_600_000,
  MONTH: 28_800_000,
} as const;

/** How a metric folds, decided by its name. Order matters: `distinct*Count` is a max. */
export const ruleFor = (metric: string): Rule => {
  if (metric.startsWith("distinct")) return "max";
  if (metric.startsWith("mostCommon")) return "mode";
  if (metric.startsWith("avg")) return "mean";
  if (metric.startsWith("max")) return "max";
  if (metric.startsWith("min")) return "min";
  if (metric.endsWith("Pct")) return "mean";
  if (
    /(Bytes|Packets|Count)$/.test(metric) ||
    metric === "durationMs" ||
    // Seconds counters: uptimeS, failoverS, activityS, downtimeS.
    /[a-z]S$/.test(metric)
  ) {
    return "sum";
  }
  return "mean";
};

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const isGroupArray = (v: unknown): v is Rec[] => Array.isArray(v) && v.length > 0 && v.every(isRec);

/**
 * The key fields of each nested group, by group name, from the schema
 * (`{ byPort: ["portIdx"] }`). A key can be numeric, so it cannot be guessed
 * from the values — without this, every port folds into one entry.
 */
export type NestedKeys = Record<string, string[]>;

/** Fallback when the schema did not say: a string field (`radioBand`) is a key. */
const isKeyField = (name: string, value: unknown, keys: string[] | undefined): boolean =>
  keys ? keys.includes(name) : typeof value === "string" && !name.startsWith("mostCommon");

const round = (metric: string, value: number): number =>
  /(Bytes|Packets)$/.test(metric) ? Math.round(value) : Math.round(value * 10) / 10;

/**
 * Fold one metric across weighted samples. Absent samples were filtered out
 * before this, so a missing signal reading never drags a mean towards zero.
 */
const foldMetric = (metric: string, samples: { value: unknown; weight: number }[]): unknown => {
  const rule = ruleFor(metric);
  const numeric = samples.filter((s): s is { value: number; weight: number } =>
    Number.isFinite(s.value as number),
  );

  if (rule === "mode" || numeric.length === 0) {
    const counts = new Map<string, { value: unknown; n: number }>();
    for (const { value } of samples) {
      const key = JSON.stringify(value);
      const entry = counts.get(key) ?? { value, n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
    let best: { value: unknown; n: number } | undefined;
    for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
    return best?.value;
  }

  const values = numeric.map((s) => s.value);
  let result: number;
  switch (rule) {
    case "sum":
      result = values.reduce((a, b) => a + b, 0);
      break;
    case "max":
      result = Math.max(...values);
      break;
    case "min":
      result = Math.min(...values);
      break;
    default: {
      const weight = numeric.reduce((a, s) => a + s.weight, 0);
      result =
        weight > 0
          ? numeric.reduce((a, s) => a + s.value * s.weight, 0) / weight
          : values.reduce((a, b) => a + b, 0) / values.length;
    }
  }
  return round(metric, result);
};

/** Fold a set of records (points, or nested entries of one group) metric by metric. */
const foldRecords = (
  records: { rec: Rec; weight: number }[],
  skip: Set<string>,
  nestedKeys: NestedKeys,
): Rec => {
  const out: Rec = {};
  const names = new Set<string>();
  for (const { rec } of records) for (const name of Object.keys(rec)) names.add(name);

  for (const name of names) {
    if (skip.has(name)) continue;
    const present = records.filter(({ rec }) => rec[name] !== undefined && rec[name] !== null);
    if (present.length === 0) continue;

    if (present.some(({ rec }) => isGroupArray(rec[name]))) {
      out[name] = foldNested(
        present.map(({ rec, weight }) => ({ list: rec[name], weight })),
        nestedKeys[name],
        nestedKeys,
      );
      continue;
    }
    out[name] = foldMetric(
      name,
      present.map(({ rec, weight }) => ({ value: rec[name], weight })),
    );
  }
  return out;
};

/** Nested arrays fold entry by entry, matched on their key fields, in first-seen order. */
const foldNested = (
  lists: { list: unknown; weight: number }[],
  keyNames: string[] | undefined,
  nestedKeys: NestedKeys,
): Rec[] => {
  const groups = new Map<string, { keys: Rec; members: { rec: Rec; weight: number }[] }>();
  for (const { list, weight } of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRec(entry)) continue;
      const keys: Rec = {};
      for (const [name, value] of Object.entries(entry)) {
        if (isKeyField(name, value, keyNames)) keys[name] = value;
      }
      const id = JSON.stringify(keys);
      const group = groups.get(id) ?? { keys, members: [] };
      group.members.push({ rec: entry, weight });
      groups.set(id, group);
    }
  }
  return [...groups.values()].map(({ keys, members }) => ({
    ...keys,
    ...foldRecords(members, new Set(Object.keys(keys)), nestedKeys),
  }));
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const groupKey = (timestamp: number, resolution: Resolution, index: number): number => {
  switch (resolution) {
    case "raw":
      return index;
    case "hour":
      return Math.floor(timestamp / HOUR_MS);
    case "day":
      return Math.floor(timestamp / DAY_MS);
    default:
      return 0;
  }
};

/**
 * Fold engine points into `resolution`. Points are taken in timestamp order;
 * `bucketMs` is the engine's bucket size, used only to recognise the newest
 * bucket as still filling.
 */
export const rollup = (
  points: StatPoint[],
  resolution: Resolution,
  bucketMs: number,
  nestedKeys: NestedKeys = {},
): RolledPoint[] => {
  const sorted = points.toSorted((a, b) => a.timestamp - b.timestamp);
  const newest = sorted.at(-1);
  const partialAt = newest && newest.duration < bucketMs ? newest.timestamp : undefined;

  const groups = new Map<number, StatPoint[]>();
  sorted.forEach((point, index) => {
    const key = groupKey(point.timestamp, resolution, index);
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => {
    const first = group[0] as StatPoint;
    const folded = foldRecords(
      group.map((rec) => ({ rec, weight: rec.duration })),
      new Set(["timestamp", "duration"]),
      nestedKeys,
    );
    const partial = group.some((p) => p.timestamp === partialAt);
    return {
      t: new Date(first.timestamp).toISOString(),
      spanMs: group.reduce((a, p) => a + p.duration, 0),
      ...(partial ? { partial: true as const } : {}),
      ...folded,
    };
  });
};
