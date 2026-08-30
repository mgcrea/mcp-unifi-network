// The tool list depends on the console's Network version, but `createServer` is
// a synchronous pure factory and must stay one — putting a network call inside
// it would make a test that forgets to mock `fetch` hang rather than fail. So
// the probe runs in `cli.ts` and its result is passed INTO the factory.

import type { Logger } from "#/client/auth";
import type { SiteRef } from "#/client/sites";
import type { Page, UnifiClient } from "#/client/unifi";
import { INTEGRATION_PATHS } from "#/config";
import { tierFor } from "#/version";
import type { VersionTier } from "#/version";

export type Probe = {
  appVersion: string | undefined;
  tier: VersionTier;
  versionSource: "override" | "probe" | "assumed";
  sites: SiteRef[];
  /** Which of the two Integration mount points this console actually serves. */
  pathPrefix: string;
  /** Non-fatal reason the probe could not read the console. Surfaced, not thrown. */
  unreachable: string | undefined;
};

/**
 * What a server assumes when it never probed: the newest tier.
 *
 * Under-registering is invisible and unrecoverable inside a conversation — the
 * model is told the tool does not exist and has no way to learn why. Over-
 * registering yields a 404 carrying an explanation. Always prefer the failure
 * mode that explains itself.
 */
export const ASSUMED_PROBE: Probe = {
  appVersion: undefined,
  tier: "full",
  versionSource: "assumed",
  sites: [],
  pathPrefix: INTEGRATION_PATHS[0],
  unreachable: undefined,
};

/**
 * A 401 here is a rejected API key, not an unreachable console, and reporting it
 * as "unreachable" sends the reader looking at the network instead of at the
 * key — which is the single most common setup mistake.
 */
const explainProbeFailure = (message: string): string => {
  if (!message) return "unknown error";
  if (/\b401\b/.test(message)) {
    return `${message} (the console answered, so it is reachable — the API key was rejected)`;
  }
  if (/\b403\b/.test(message)) {
    return `${message} (the key authenticated but lacks permission to read the console version)`;
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(message)) {
    return `${message} (self-signed certificate — set NODE_EXTRA_CA_CERTS, or UNIFI_INSECURE_TLS=1)`;
  }
  return message;
};

const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    return cause?.code ? `${cause.code}: ${err.message}` : err.message;
  }
  return String(err);
};

/**
 * Read the console's version and site list.
 *
 * Never throws and never exceeds `timeoutMs`. A sleeping console, a VPN that is
 * not up yet, an unexpected certificate — none of it may stop the server
 * connecting. Rule 2 applies to the network exactly as it applies to
 * credentials: the server comes up and says what is wrong.
 */
export const probeConsole = async (
  client: UnifiClient,
  opts: { override?: string | undefined; timeoutMs: number; logger?: Logger },
): Promise<{ probe: Probe; client: UnifiClient }> => {
  // An explicit version short-circuits the network entirely, which is what makes
  // CI and Docker deterministic and instant.
  if (opts.override) {
    return {
      probe: {
        appVersion: opts.override,
        tier: tierFor(opts.override),
        versionSource: "override",
        sites: [],
        pathPrefix: INTEGRATION_PATHS[0],
        unreachable: undefined,
      },
      client,
    };
  }

  const signal = AbortSignal.timeout(opts.timeoutMs);
  let active = client;
  let lastError = "";

  for (const path of INTEGRATION_PATHS) {
    const candidate = active.baseUrl.replace(/\/integrations?\/v1$/, path);
    const probeClient = candidate === active.baseUrl ? active : active.withBaseUrl(candidate);
    try {
      const info = await probeClient.get<{ applicationVersion?: string }>("/info", undefined, {
        signal,
        raw: true,
      });
      const appVersion =
        typeof info?.applicationVersion === "string" ? info.applicationVersion : undefined;

      // The version is the whole point; the site list is a bonus that pre-seeds
      // the resolver, so a failure here must not discard what we just learned.
      let sites: SiteRef[] = [];
      try {
        const page = await probeClient.get<Page<SiteRef>>("/sites", { limit: 200 }, { signal });
        sites = Array.isArray(page?.data) ? page.data : [];
      } catch (err) {
        opts.logger?.debug?.(`[unifi] site pre-fetch failed: ${describeError(err)}`);
      }

      opts.logger?.debug?.(
        `[unifi] probe: ${path} version=${appVersion ?? "?"} sites=${sites.length}`,
      );
      return {
        probe: {
          appVersion,
          tier: tierFor(appVersion),
          versionSource: "probe",
          sites,
          pathPrefix: path,
          unreachable: undefined,
        },
        client: probeClient,
      };
    } catch (err) {
      lastError = describeError(err);
      active = probeClient;
      // A 404 here usually means the other mount point; anything else means the
      // console is unreachable and trying the alias would only double the wait.
      if (!/\b404\b/.test(lastError)) break;
    }
  }

  opts.logger?.debug?.(`[unifi] probe failed: ${lastError}`);
  return {
    probe: { ...ASSUMED_PROBE, unreachable: explainProbeFailure(lastError) },
    client,
  };
};
