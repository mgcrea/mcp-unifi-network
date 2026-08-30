// A UniFi site has THREE identifiers and this API accepts only one of them.
//
//   { id: "661f0e6a-…", internalReference: "default", name: "Default" }
//
// `id` is what `/v1/sites/{siteId}/…` wants. `internalReference` is the legacy
// 8-character name that appears in every controller URL, every forum post and
// every older script — so it is overwhelmingly what a model will type. `name` is
// the label shown in the UI.
//
// The fix is not to document that a UUID is required. It is to accept all three
// and translate, so a caller that guesses "default" succeeds on the first call
// instead of burning a round trip on a 400.

import type { Logger } from "./auth.js";
import { SiteResolutionError } from "./errors.js";
import type { Page, UnifiClient } from "./unifi.js";

export type SiteRef = {
  id: string;
  internalReference?: string | undefined;
  name?: string | undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value.trim());

const describe = (site: SiteRef): string =>
  // The id comes FIRST on each line, so a model copying the leading token of a
  // line gets the thing the API actually wants.
  `  ${site.id} — internalReference ${JSON.stringify(site.internalReference ?? "?")}, ` +
  `name ${JSON.stringify(site.name ?? "?")}`;

export class SiteResolver {
  private readonly client: UnifiClient;
  private readonly defaultSite: string | undefined;
  private readonly logger: Logger | undefined;
  private cache: SiteRef[] | undefined;
  private inflight: Promise<SiteRef[]> | undefined;

  constructor(
    client: UnifiClient,
    opts: { defaultSite?: string | undefined; seed?: SiteRef[]; logger?: Logger } = {},
  ) {
    this.client = client;
    this.defaultSite = opts.defaultSite;
    this.logger = opts.logger;
    // The startup probe already fetched this, so seeding removes a round trip
    // from nearly every later tool call.
    if (opts.seed && opts.seed.length > 0) this.cache = opts.seed;
  }

  /** Drop the cache, so a site created after startup is found on the next call. */
  invalidate(): void {
    this.cache = undefined;
    this.inflight = undefined;
  }

  async list(): Promise<SiteRef[]> {
    if (this.cache) return this.cache;
    this.inflight ??= this.fetchSites().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchSites(): Promise<SiteRef[]> {
    const page = await this.client.get<Page<SiteRef>>("/sites", { limit: 200 });
    const sites = Array.isArray(page?.data) ? page.data : [];
    this.logger?.debug?.(`[unifi] resolved ${sites.length} site(s)`);
    this.cache = sites;
    return sites;
  }

  /** Resolve a UUID, an internalReference or a display name to the site UUID. */
  async resolve(input?: string): Promise<string> {
    const wanted = input?.trim() || this.defaultSite?.trim();

    if (!wanted) {
      const sites = await this.list();
      // The overwhelmingly common home/SMB case: exactly one site, so asking
      // which one would be pure ceremony.
      if (sites.length === 1 && sites[0]) return sites[0].id;
      if (sites.length === 0) {
        throw new SiteResolutionError(
          "No sites were returned by this console. Check that UNIFI_API_KEY belongs to it, " +
            "then call unifi_list_sites.",
        );
      }
      throw new SiteResolutionError(
        `This console has ${sites.length} sites, so \`site\` is required:\n` +
          `${sites.map(describe).join("\n")}\n` +
          `Pass an id — or a name — as \`site\`, or set UNIFI_SITE to make one the default.`,
        { sites },
      );
    }

    // A well-formed UUID is trusted without a lookup. That saves a round trip,
    // and it still works for a site the /sites listing paginated past.
    if (isUuid(wanted)) return wanted;

    const sites = await this.list();

    // internalReference is an id, so it is matched case-sensitively.
    const byReference = sites.find((site) => site.internalReference === wanted);
    if (byReference) return byReference.id;

    // name is a human label, so it is not.
    const lowered = wanted.toLowerCase();
    const byName = sites.filter((site) => site.name?.trim().toLowerCase() === lowered);
    if (byName.length === 1 && byName[0]) return byName[0].id;
    if (byName.length > 1) {
      throw new SiteResolutionError(
        `"${wanted}" matches ${byName.length} sites by name. Use the id instead:\n` +
          `${byName.map(describe).join("\n")}`,
        { sites: byName },
      );
    }

    // Models truncate UUIDs when echoing them back; accepting a prefix is free.
    if (wanted.length >= 8) {
      const byPrefix = sites.filter((site) => site.id.toLowerCase().startsWith(lowered));
      if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0].id;
    }

    throw new SiteResolutionError(
      `Unknown site "${wanted}". On this API \`siteId\` is a UUID, not the legacy ` +
        `8-character site name.\n` +
        `This console has ${sites.length} site${sites.length === 1 ? "" : "s"}:\n` +
        `${sites.map(describe).join("\n")}\n` +
        `Pass one of those ids — or its name — as \`site\`. Set UNIFI_SITE to make one the default.`,
      { sites },
    );
  }

  /**
   * The inverse mapping. The legacy controller API is keyed by
   * `internalReference` in `/api/s/<site>/…`, never by the UUID — passing a UUID
   * there yields `api.err.NoSiteContext`, which reads like a permissions problem.
   */
  async resolveLegacyName(input?: string): Promise<string> {
    const wanted = input?.trim() || this.defaultSite?.trim();

    if (wanted && !isUuid(wanted)) {
      const sites = await this.list().catch(() => [] as SiteRef[]);
      // Already an internalReference, or a name we can map to one.
      if (sites.length === 0) return wanted;
      const byReference = sites.find((site) => site.internalReference === wanted);
      if (byReference?.internalReference) return byReference.internalReference;
      const lowered = wanted.toLowerCase();
      const byName = sites.find((site) => site.name?.trim().toLowerCase() === lowered);
      if (byName?.internalReference) return byName.internalReference;
      return wanted;
    }

    const id = await this.resolve(input);
    const sites = await this.list();
    const found = sites.find((site) => site.id === id);
    if (found?.internalReference) return found.internalReference;
    throw new SiteResolutionError(
      `Site ${id} has no internalReference, which the legacy controller API needs in its ` +
        `/api/s/<site>/ path. Call unifi_list_sites and pass the internalReference directly.`,
    );
  }
}

/**
 * A resolver for a server with no Integration API at all (a classic controller).
 * The legacy tools still need a site name, and there is no /v1/sites to ask.
 */
export const staticLegacyResolver = (
  site: string | undefined,
): Pick<SiteResolver, "resolveLegacyName"> => ({
  resolveLegacyName: async (input?: string) => {
    const wanted = input?.trim() || site?.trim();
    if (wanted) return wanted;
    // Every controller has a site with this name; it is the one the UI opens on.
    return "default";
  },
});
