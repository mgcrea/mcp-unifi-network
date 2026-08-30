// The Integration API's `filter` query parameter is a small expression language,
// and it is the whole search surface of this API — there is no separate search
// endpoint. Building the strings here rather than in the tools keeps the quoting
// rules in one tested place, and keeps the tool files free of string bashing.
//
// Grammar: `<property>.<function>(<args>)`, combined with `and(...)`, `or(...)`
// and `not(...)`. Strings are single-quoted; `*` is the wildcard in `like`.

/**
 * Single-quote a string literal. The API escapes an embedded quote by doubling
 * it — a backslash is NOT an escape here, and using one produces a filter that
 * parses as something else entirely rather than failing.
 */
export const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Render one argument by JavaScript type; strings get quoted, numbers do not. */
const arg = (value: string | number | boolean): string =>
  typeof value === "string" ? quote(value) : String(value);

const call =
  (fn: string) =>
  (property: string, value: string | number | boolean): string =>
    `${property}.${fn}(${arg(value)})`;

export const eq = call("eq");
export const ne = call("ne");
export const gt = call("gt");
export const ge = call("ge");
export const lt = call("lt");
export const le = call("le");
export const like = call("like");
export const contains = call("contains");

export const isNull = (property: string): string => `${property}.isNull()`;
export const isNotNull = (property: string): string => `${property}.isNotNull()`;

// Joined without spaces throughout: URLSearchParams encodes a space as `+`, and
// whether the console's filter parser decodes that back to a space is not worth
// depending on. The grammar treats the separator as insignificant.
export const inSet = (property: string, values: (string | number)[]): string =>
  `${property}.in(${values.map(arg).join(",")})`;

/**
 * Combine clauses, dropping undefined ones.
 *
 * Zero clauses yield `undefined` and one clause yields itself unwrapped, so call
 * sites can write `compact({ filter: and(a, b, c) })` with no branching — and so
 * a single clause is never sent as the pointless `and(x)`.
 */
const combine =
  (fn: "and" | "or") =>
  (...parts: (string | undefined)[]): string | undefined => {
    const kept = parts.filter((part): part is string => Boolean(part));
    if (kept.length === 0) return undefined;
    if (kept.length === 1) return kept[0];
    return `${fn}(${kept.join(",")})`;
  };

export const and = combine("and");
export const or = combine("or");

export const not = (part: string | undefined): string | undefined =>
  part === undefined ? undefined : `not(${part})`;

/**
 * Shared prose for the raw `filter` passthrough on every list tool. The full
 * grammar is deliberately not modelled in zod: a schema expressive enough to
 * cover it is one no model can fill in correctly, so the escape hatch is a
 * string and the teaching happens in the description.
 */
export const FILTER_ARG_DESCRIPTION =
  "Raw server-side filter expression, applied by the console before it answers — much cheaper " +
  "than fetching pages and filtering here. Syntax: `property.function(value)`, combined with " +
  "`and(...)`, `or(...)` and `not(...)`. Strings take single quotes (double an embedded quote " +
  "to escape it); `*` is the wildcard in `like`. Functions: eq, ne, gt, ge, lt, le, like, in, " +
  "notIn, isNull, isNotNull, contains, containsAny, containsAll. " +
  "Examples: `state.eq('OFFLINE')`, `firmwareUpdatable.eq(true)`, " +
  "`and(type.eq('WIRED'),name.like('*lab*'))`. " +
  "The structured arguments on this tool build the common expressions for you — use this only " +
  "for what they cannot express, and do not pass both.";
