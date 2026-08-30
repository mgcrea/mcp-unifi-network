import { Agent, fetch as undiciFetch } from "undici";

import type { Logger } from "#/client/auth";

/**
 * The one place TLS is decided.
 *
 * Local UniFi consoles ship a self-signed certificate, and Node's native `fetch`
 * ignores a `node:https` Agent — the only scoped way to relax verification is an
 * undici dispatcher. That is why this server carries a third runtime dependency
 * where the rest of the fleet carries two: the alternative,
 * NODE_TLS_REJECT_UNAUTHORIZED=0, is process-global and would silently disable
 * verification for every other request the process ever makes.
 *
 * The relaxation lives in this function's return value. Nothing else in the
 * process inherits it, and `superRefine` already forbids pairing the flag with
 * cloud mode, so it can only ever address a LAN console.
 *
 * **The `fetch` here must be undici's own, not the global one.** Node's built-in
 * fetch is a *bundled copy* of undici, and it rejects a dispatcher constructed
 * from the separately-installed package with a bare `UND_ERR_INVALID_ARG` —
 * verified against a live console, where it surfaced as an unexplained
 * "fetch failed". Passing undici's own fetch keeps both sides on one class.
 * Verification stays on by default, so the global fetch remains the common path.
 *
 * Note what pinning a certificate can and cannot fix. These consoles present
 * `CN=unifi.local` with SANs for `unifi.local`, `localhost` and `127.0.0.1` —
 * and **no IP SAN**. Reached by IP, verification fails on the host name however
 * the certificate is trusted. Measured with `curl --cacert`: by host name
 * `ssl_verify=0`, by IP `ssl_verify=1`. So verifying needs BOTH
 * NODE_EXTRA_CA_CERTS and a host name that resolves to the console.
 */
export const createHttpFetch = (opts: { insecureTls: boolean; logger?: Logger }): typeof fetch => {
  if (!opts.insecureTls) return fetch;

  opts.logger?.warn?.(
    "UNIFI_INSECURE_TLS is set: TLS certificate verification is DISABLED for this server's " +
      "requests. To verify instead, address the console by a host name that resolves to it — " +
      "its certificate has no IP SAN — and point NODE_EXTRA_CA_CERTS at that certificate.",
  );

  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  // undici's fetch/Response are structurally the WHATWG ones the rest of the
  // client uses; the cast bridges the two nominal type declarations and is
  // confined to this file.
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as string, { ...init, dispatcher } as never)) as unknown as typeof fetch;
};
