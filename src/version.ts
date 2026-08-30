// Which endpoints exist depends on the Network application version, and the
// spread is wide: 7 paths on 9.0, 12 on 9.3, 32 on 10.0, 44 on 10.3. Tools are
// registered against a named tier rather than a raw version so every call site
// is an enum comparison and nobody hand-rolls semver in a registration block.

/** Ordered from least to most capable. `atLeast` relies on that order. */
export const TIERS = ["core", "clients-plus", "network-config", "routing", "full"] as const;

export type VersionTier = (typeof TIERS)[number];

/** The minimum `applicationVersion` that unlocks each tier, as [major, minor]. */
const TIER_FLOOR: [VersionTier, number, number][] = [
  // 10.3+ — switch stacks, LAG/MC-LAG, VPN, RADIUS, WANs, device tags, DPI tables.
  ["full", 10, 3],
  // 10.1+ — routing additions.
  ["routing", 10, 1],
  // 10.0+ — networks, WiFi broadcasts, firewall zones/policies, ACLs, DNS policies.
  ["network-config", 10, 0],
  // 9.3+ — client details/actions, port actions, hotspot vouchers.
  ["clients-plus", 9, 3],
];

/**
 * Parse the leading `major.minor` of an `applicationVersion`. Returns undefined
 * for anything unparseable rather than guessing, so the caller decides what an
 * unknown version means.
 */
export const parseVersion = (version: string | undefined): [number, number] | undefined => {
  const match = /^(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  if (!match) return undefined;
  // Compared numerically, never as strings: "10.10.0" > "10.9.0" is false as a
  // string comparison, and that is the bug this function exists not to have.
  return [Number(match[1]), Number(match[2])];
};

/**
 * The tier a console's `applicationVersion` unlocks.
 *
 * An unknown version resolves to the NEWEST tier, not the oldest. Under-
 * registering is invisible inside a conversation — the model is simply told the
 * tool does not exist and has no way to learn why. Over-registering produces a
 * 404 carrying `describeTierGap()`, which says exactly what is wrong. Prefer the
 * failure mode that explains itself.
 */
export const tierFor = (version: string | undefined): VersionTier => {
  const parsed = parseVersion(version);
  if (!parsed) return "full";
  const [major, minor] = parsed;
  for (const [tier, floorMajor, floorMinor] of TIER_FLOOR) {
    if (major > floorMajor || (major === floorMajor && minor >= floorMinor)) return tier;
  }
  return "core";
};

/** True when `have` is at least as capable as `need`. */
export const atLeast = (have: VersionTier, need: VersionTier): boolean =>
  TIERS.indexOf(have) >= TIERS.indexOf(need);

/** The lowest `applicationVersion` that would unlock a tier, for error prose. */
export const floorOf = (tier: VersionTier): string => {
  const found = TIER_FLOOR.find(([name]) => name === tier);
  return found ? `${found[1]}.${found[2]}` : "9.0";
};

/**
 * Explain a 404 that is really a version gap. Registered-but-absent endpoints
 * are the cost of assuming the newest tier when the probe failed, so this
 * message is what makes that trade survivable.
 */
export const describeTierGap = (need: VersionTier, appVersion: string | undefined): string =>
  `This endpoint needs UniFi Network ${floorOf(need)} or later. ` +
  (appVersion
    ? `GET /v1/info reports ${appVersion}, so it is not available on this console.`
    : `The console's version could not be read at startup, so tools were registered ` +
      `optimistically — this one is not available here. Set UNIFI_APP_VERSION to the ` +
      `version from GET /v1/info to gate the tool list correctly.`);
