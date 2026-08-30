// The context-window layer — but a thin one, and deliberately so.
//
// Integration API objects are already small: a client overview is 6 fields, a
// device overview 11, device statistics about 10. Copying them through a field
// allowlist would buy no tokens and cost a second schema that silently drops
// whatever UniFi adds in the next release. So shaping happens where the reason
// for shaping actually applies — the pagination envelope, and the one object
// with nested sub-structures — and nowhere else.

import type { SiteRef } from "#/client/sites";
import { normalizeMac } from "#/mac";

type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Collapse `{offset, limit, count, totalCount, data}` to `{data, totalCount}`
 * plus a `nextOffset` only when there is more.
 *
 * This is not about size. `offset`, `limit` and `count` merely echo the request,
 * and leaving them in forces the model to do arithmetic to work out whether
 * another page exists — a decision it gets wrong. Computing `nextOffset`, or
 * omitting it entirely, removes the decision.
 */
export const unwrapPage = <T = unknown>(
  response: unknown,
  transform: (item: T) => unknown = (item) => item,
): Rec => {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { data: [], totalCount: 0 };
  }
  const data = (response.data as T[]).map(transform);
  const offset = typeof response.offset === "number" ? response.offset : 0;
  const count = typeof response.count === "number" ? response.count : data.length;
  const totalCount = typeof response.totalCount === "number" ? response.totalCount : data.length;
  const nextOffset = offset + count;
  return {
    data,
    totalCount,
    ...(nextOffset < totalCount ? { nextOffset } : {}),
  };
};

/** Shape the result of `UnifiClient.listAll`, which already merged the pages. */
export const wrapCollected = <T>(
  collected: { data: T[]; totalCount: number; truncated: boolean },
  transform: (item: T) => unknown = (item) => item,
): Rec => ({
  data: collected.data.map(transform),
  totalCount: collected.totalCount,
  ...(collected.truncated
    ? {
        truncated: true,
        note:
          `Returned ${collected.data.length} of ${collected.totalCount}. Narrow the result with ` +
          `\`filter\` rather than raising \`limit\` — the console filters server-side.`,
      }
    : {}),
});

/**
 * The only Integration object worth trimming, and only when listing. `features`
 * and `interfaces` are nested arrays that dominate a device overview and mean
 * nothing without the detail view. `unifi_get_device` returns the full object
 * untouched — that is the point of a get.
 */
export const summarizeDevice = (device: unknown): unknown => {
  if (!isRecord(device)) return device;
  const { features: _features, interfaces: _interfaces, ...rest } = device;
  return {
    ...rest,
    ...(typeof device.macAddress === "string" ? { macAddress: safeMac(device.macAddress) } : {}),
  };
};

/**
 * Passed through unchanged apart from the MAC.
 *
 * Deliberately NOT an allowlist: a client overview is six flat fields, so
 * projecting it would save nothing and would silently drop whatever the next
 * Network release adds. If this ever grows, add the field here rather than
 * turning it into a filter.
 */
export const summarizeClient = (client: unknown): unknown => {
  if (!isRecord(client)) return client;
  return {
    ...client,
    ...(typeof client.macAddress === "string" ? { macAddress: safeMac(client.macAddress) } : {}),
  };
};

/** Normalize when we can, pass through when we cannot — never fail a read over formatting. */
const safeMac = (value: string): string => {
  try {
    return normalizeMac(value);
  } catch {
    return value;
  }
};

/**
 * Every response that mentions a site carries all three identifiers, never a
 * bare id — so the model never has to go back and ask what "the site" was, and
 * so the id it needs for the legacy tools is already in front of it.
 */
export const annotateSite = (site: SiteRef): Rec => ({
  id: site.id,
  internalReference: site.internalReference ?? null,
  name: site.name ?? null,
});
