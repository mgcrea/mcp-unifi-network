// The two transports disagree about MAC formatting, and callers paste whatever
// their last tool returned. Without one canonical form, an id from
// `unifi_list_clients` does not compare equal to the same id from
// `unifi_legacy_list_events`, and the model concludes they are different devices.

const HEX12 = /^[0-9a-f]{12}$/;

/**
 * Normalize any of the four formats seen in the wild to lower-case,
 * colon-separated: `AA:BB:CC:DD:EE:FF`, `aabbccddeeff`, `aa-bb-cc-dd-ee-ff`,
 * `aabb.ccdd.eeff`. Throws readably rather than passing garbage upstream, where
 * it would come back as a generic 400.
 */
export const normalizeMac = (value: string): string => {
  const stripped = value
    .trim()
    .toLowerCase()
    .replace(/[:.\- ]/g, "");
  if (!HEX12.test(stripped)) {
    throw new Error(
      `"${value}" is not a MAC address. Expected 12 hex digits, optionally separated ` +
        `by ":", "-" or "." — e.g. "aa:bb:cc:dd:ee:ff".`,
    );
  }
  return (stripped.match(/.{2}/g) ?? []).join(":");
};

/** Normalize when present, pass undefined through. For optional args. */
export const normalizeMacOpt = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : normalizeMac(value);

/** The separator-free form some legacy query parameters expect. */
export const macCompact = (value: string): string => normalizeMac(value).replace(/:/g, "");
