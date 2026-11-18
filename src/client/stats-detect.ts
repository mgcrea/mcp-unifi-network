// Readings over statistics-engine series that answer a question rather than
// return numbers. Pure, so the thresholds are tested without a console.
//
// The hung-radio detector exists because of a real failure: a UAP-AC-Pro's
// 5 GHz radio kept broadcasting and reporting "RUN" while carrying nothing, for
// hours, while every client crowded onto 2.4 GHz — and every live endpoint,
// including the health check, called the network healthy. Over a window the
// signature is unmistakable: the band reports EXACTLY zero bytes and zero
// channel utilisation. A radio that is merely idle still hears its neighbours'
// beacons, so its utilisation is never 0.0.

import type { SeriesRow } from "#/client/stats";
import { BUCKET_MS, rollup } from "#/client/stats-rollup";
import type { StatPoint } from "#/client/stats-rollup";

type Rec = Record<string, unknown>;

export type RadioRun = {
  mac: string;
  fromMs: number;
  /** Timestamp of the last silent bucket; the run ends one bucket later. */
  toMs: number;
  minutes: number;
  ngClientsMax: number;
  /** The run reaches the newest closed bucket: the radio is silent right now. */
  ongoing: boolean;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const band = (point: StatPoint, name: string): Rec | undefined => {
  const bands = point.byRadioBand;
  if (!Array.isArray(bands)) return undefined;
  return (bands as Rec[]).find((b) => b.radioBand === name);
};

/** A silent 5 GHz bucket while clients were on 2.4 GHz, or undefined. */
const silentClients = (point: StatPoint): number | undefined => {
  const na = band(point, "na");
  if (!na) return undefined;
  const dead = num(na.rxBytes) + num(na.txBytes) === 0 && num(na.avgTotalCuPct) === 0;
  const ngClients = num(band(point, "ng")?.distinctClientCount);
  return dead && ngClients >= 1 ? ngClients : undefined;
};

/**
 * Runs of at least `minMinutes` where a 5 GHz band carried nothing while
 * 2.4 GHz served clients. Only closed buckets count — the newest one is still
 * filling — and a missing timestamp ends a run, so a hang is never stitched
 * together across a stretch the console did not record.
 */
export const findHungRadios = (
  rows: SeriesRow[],
  opts: { bucketMs: number; minMinutes?: number },
): RadioRun[] => {
  const { bucketMs } = opts;
  const minMinutes = opts.minMinutes ?? 30;
  const runs: RadioRun[] = [];

  for (const row of rows) {
    if (typeof row.deviceMac !== "string") continue;
    const closed = row.series
      .filter((p) => p.duration === bucketMs)
      .toSorted((a, b) => a.timestamp - b.timestamp);
    const newest = closed.at(-1)?.timestamp;

    let run: { fromMs: number; toMs: number; ngClientsMax: number } | undefined;
    const close = () => {
      if (!run) return;
      const minutes = (run.toMs + bucketMs - run.fromMs) / 60_000;
      if (minutes >= minMinutes) {
        runs.push({
          mac: row.deviceMac as string,
          ...run,
          minutes,
          ongoing: run.toMs === newest,
        });
      }
      run = undefined;
    };

    for (const point of closed) {
      const clients = silentClients(point);
      if (run && point.timestamp !== run.toMs + bucketMs) close();
      if (clients === undefined) {
        close();
        continue;
      }
      if (run) {
        run.toMs = point.timestamp;
        run.ngClientsMax = Math.max(run.ngClientsMax, clients);
      } else {
        run = { fromMs: point.timestamp, toMs: point.timestamp, ngClientsMax: clients };
      }
    }
    close();
  }
  return runs;
};

export type WanSummary = {
  rxBytes: number;
  txBytes: number;
  availabilityPct: number | null;
  avgLatencyMs: number | null;
  failoverS: number;
};

const orNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The window's WAN totals from wanBySite, or null when it holds no points. */
export const summarizeWan = (rows: SeriesRow[]): WanSummary | null => {
  const points = rows.flatMap((row) => row.series);
  if (points.length === 0) return null;
  const total: Rec = rollup(points, "total", BUCKET_MS.DAY)[0] ?? {};
  return {
    rxBytes: num(total.rxBytes),
    txBytes: num(total.txBytes),
    availabilityPct: orNull(total.avgAvailabilityPct),
    avgLatencyMs: orNull(total.avgLatencyMs),
    failoverS: num(total.failoverS),
  };
};

export type ClientHistory = {
  rxBytes: number;
  txBytes: number;
  avgSignalDbm: number | null;
  /** The weakest hourly average: a single bad hour hides inside a day's mean. */
  worstHourSignalDbm: number | null;
  avgSatisfaction: number | null;
  roams: number;
  /** The last bucket that moved any bytes, ISO. */
  lastActive: string | null;
  /** Which APs carried the client, by share of its connected time. */
  aps: { mac: string; name?: string; sharePct: number }[];
};

/**
 * One client's window from activityBySiteByClient (nested byDevice) and
 * roamBySiteByClient, or null when the engine recorded nothing for it.
 */
export const summarizeClientHistory = (
  activity: SeriesRow[],
  roams: SeriesRow[],
  apNames: Map<string, string>,
): ClientHistory | null => {
  const points = activity.flatMap((row) => row.series);
  if (points.length === 0) return null;
  const bucketMs = BUCKET_MS.DAY;
  const total: Rec = rollup(points, "total", bucketMs)[0] ?? {};

  const hourly = rollup(points, "hour", bucketMs)
    .map((p) => p.avgSignalDbm)
    .filter((v): v is number => typeof v === "number");

  const active = points
    .filter((p) => num(p.rxBytes) + num(p.txBytes) > 0)
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .at(-1);

  const devices = (Array.isArray(total.byDevice) ? total.byDevice : []) as Rec[];
  const connected = devices.reduce((a, d) => a + num(d.durationMs), 0);
  const aps = devices
    .filter((d) => typeof d.deviceMac === "string")
    .map((d) => {
      const mac = String(d.deviceMac).toLowerCase();
      const name = apNames.get(mac);
      return {
        mac,
        ...(name ? { name } : {}),
        sharePct: connected > 0 ? Math.round((num(d.durationMs) / connected) * 100) : 0,
      };
    })
    .toSorted((a, b) => b.sharePct - a.sharePct);

  return {
    rxBytes: num(total.rxBytes),
    txBytes: num(total.txBytes),
    avgSignalDbm: orNull(total.avgSignalDbm),
    worstHourSignalDbm: hourly.length > 0 ? Math.min(...hourly) : null,
    avgSatisfaction: orNull(total.avgSatisfactionScore),
    roams: roams.flatMap((row) => row.series).reduce((a, p) => a + num(p.roamCount), 0),
    lastActive: active ? new Date(active.timestamp).toISOString() : null,
    aps,
  };
};
