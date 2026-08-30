# @mgcrea/mcp-unifi-network

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-unifi-network?style=for-the-badge)](https://www.npmjs.com/package/@mgcrea/mcp-unifi-network)
[![build status](https://img.shields.io/github/actions/workflow/status/mgcrea/mcp-unifi-network/ci.yml?style=for-the-badge)](https://github.com/mgcrea/mcp-unifi-network/actions)

Model Context Protocol server for the UniFi Network API — sites, devices, clients, hotspot
vouchers, networks, WiFi and firewall configuration, plus an optional tier for the parts the
official API does not cover. **Read-only by default:** the mutating tools are not registered at
all until you opt in, so an agent cannot call them.

## Features

- Wraps the **official Network Integration API** (`X-API-KEY`, no cookie, no CSRF) as the
  primary transport, with server-side filtering pushed down to the console.
- Accepts a site as its **UUID, its legacy 8-character name, or its display name** and translates
  — so the obvious guess works on the first call instead of returning a 400.
- **Registers tools against the console's actual Network version.** This API had 7 endpoints in
  9.0 and 44 in 10.3, so an older console is offered only what it can serve.
- Optional **legacy controller tier** for what the official API lacks: blocking, unblocking and
  reconnecting clients, events, alarms, health, port forwarding and adoption.
- Native `fetch`, no HTTP client. Two runtime dependencies plus `undici` — see Security.

## Security

**Supply chain.** Three runtime dependencies: the MCP SDK, Zod, and `undici`. The last is a
deviation from the rest of this fleet, taken deliberately: local UniFi consoles ship self-signed
certificates, Node's native `fetch` ignores a `node:https` agent, and the only _scoped_ way to
relax verification is an undici dispatcher. The alternative,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, is process-global and would silently disable verification for
every other request the process makes. `undici` is the same engine Node's own `fetch` already runs.

**TLS.** Verification is on by default, and `UNIFI_INSECURE_TLS` is refused in cloud mode where it
would be a pure downgrade. When it is on, the banner says `tls=INSECURE` on every start.
Verifying instead takes two things together, and either alone achieves nothing: the certificate is
self-signed, so `NODE_EXTRA_CA_CERTS` must point at it; **and** it is issued to `unifi.local` with
no IP SAN, so `UNIFI_HOST` must be a host name that resolves to the console rather than its IP.
See `.env.example` for both commands.

**Your credentials.** The API key and, if the legacy tier is enabled, the console password come
from the environment or from `~/.config/unifi/config.json`, which is warned about if it is
group-readable. The legacy session cookie is a full console-admin credential and is held **in
memory only** — never written to disk. Nothing is sent anywhere but your console.

**Configuration never kills the server.** A contradictory setting is resolved to the safe option
and reported through the startup banner and `unifi_auth_status`, rather than throwing — a server
that exits at startup appears in the client as a bare `Connection closed` with stderr swallowed,
taking its own explanation with it.

**Blast radius.** With the defaults, this server can only read. Turning on `UNIFI_ALLOW_WRITES`
adds: restart a device, power-cycle a PoE port, authorize and unauthorize guest access, create
and delete vouchers, and — with the legacy tier — block, unblock and reconnect clients. Every
irreversible one requires an explicit `confirm: true` that the schema enforces before the handler
runs. **Firewall and network configuration are read-only in every configuration**: a wrong policy
locks you out of the console you are managing it through, with no undo.

## Configure

| Variable                                                     | Default                       | Meaning                                                   |
| ------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| `UNIFI_HOST`                                                 | —                             | The console. A pasted browser URL is accepted and split.  |
| `UNIFI_API_KEY`                                              | —                             | Settings → Control Plane → Integrations → Create API Key. |
| `UNIFI_MODE`                                                 | inferred                      | `unifios` · `cloud` · `classic`.                          |
| `UNIFI_CONSOLE_ID`                                           | —                             | Cloud mode: the console id from unifi.ui.com.             |
| `UNIFI_SITE`                                                 | —                             | Default site. UUID, legacy name or display name.          |
| `UNIFI_ALLOW_WRITES`                                         | `false`                       | Register the mutating tools.                              |
| `UNIFI_INSECURE_TLS`                                         | `false`                       | Disable certificate verification, this server only.       |
| `UNIFI_ENABLE_LEGACY`                                        | `false`                       | Register the `unifi_legacy_*` tools.                      |
| `UNIFI_USERNAME` / `UNIFI_PASSWORD`                          | —                             | Legacy tier only. A **local** admin, not SSO.             |
| `UNIFI_APP_VERSION`                                          | probed                        | Pin the version instead of probing at startup.            |
| `UNIFI_PAGE_LIMIT` / `UNIFI_MAX_PAGES` / `UNIFI_MAX_RETRIES` | 50 / 20 / 3                   | Tuning.                                                   |
| `UNIFI_CONFIG`                                               | `~/.config/unifi/config.json` | JSON alternative to all of the above.                     |

`.env.example` is the annotated version. Environment variables beat the config file **per field**,
so a one-off `UNIFI_ALLOW_WRITES=0` overrides a file that says `true` without discarding the rest.

## Quick start

```bash
npx -y @mgcrea/mcp-unifi-network
```

or from source:

```bash
pnpm install && pnpm build
UNIFI_HOST=192.168.1.1 UNIFI_API_KEY=… node dist/cli.js
```

The banner on stderr reports what it resolved:

```
unifi-mcp connected (mode=unifios, host=192.168.1.1, version=10.6.101, tier=full (probe),
  sites=1, integration=on, legacy=off, tls=verified, writes=disabled)
```

### Wire into Claude Code

Copy `.mcp.json.example` to `.mcp.json` (gitignored) and fill it in.

### Inspect the tools

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

**W** = registered only with `UNIFI_ALLOW_WRITES=1`. ⚠️ = requires `confirm: true`.
**Needs** = the minimum UniFi Network version.

| Tool                           | What it does                                             |               | Needs |
| ------------------------------ | -------------------------------------------------------- | ------------- | ----- |
| `unifi_auth_status`            | Configuration, console version, and what to set          |               | —     |
| `unifi_get_console_info`       | Version, tier, and which capabilities are gated off here |               | 9.0   |
| `unifi_list_sites`             | Every site with all three of its identifiers             |               | 9.0   |
| `unifi_list_clients`           | Currently connected clients                              |               | 9.0   |
| `unifi_get_client`             | One client in full                                       |               | 9.3   |
| `unifi_list_devices`           | Adopted devices, state, model, firmware                  |               | 9.0   |
| `unifi_get_device`             | One device in full                                       |               | 9.0   |
| `unifi_get_device_stats`       | CPU, memory, uptime, uplink throughput                   |               | 9.0   |
| `unifi_list_vouchers`          | Hotspot guest vouchers                                   |               | 9.3   |
| `unifi_list_networks`          | Networks / VLANs (read-only)                             |               | 10.0  |
| `unifi_list_wlans`             | WiFi broadcasts / SSIDs (read-only)                      |               | 10.0  |
| `unifi_list_firewall_zones`    | Firewall zones (read-only)                               |               | 10.0  |
| `unifi_list_firewall_policies` | Zone policies, and their ordering per zone pair          |               | 10.0  |
| `unifi_request`                | Escape hatch for any unwrapped endpoint                  | W for non-GET | 9.0   |
| `unifi_restart_device`         | Reboot a device                                          | W ⚠️          | 9.0   |
| `unifi_power_cycle_port`       | Reboot whatever is on a PoE port                         | W ⚠️          | 9.3   |
| `unifi_authorize_guest`        | Let a client onto the guest network                      | W             | 9.3   |
| `unifi_unauthorize_guest`      | Cut a guest's access immediately                         | W ⚠️          | 9.3   |
| `unifi_create_vouchers`        | Generate guest vouchers                                  | W             | 9.3   |
| `unifi_delete_vouchers`        | Delete one voucher, or every match of a filter           | W ⚠️          | 9.3   |

With `UNIFI_ENABLE_LEGACY=1`:

| Tool                            | What it does                                           |              |
| ------------------------------- | ------------------------------------------------------ | ------------ |
| `unifi_legacy_get_health`       | Per-subsystem health — the "is anything wrong" call    |              |
| `unifi_legacy_list_events`      | Controller event log                                   |              |
| `unifi_legacy_list_alarms`      | Open alarms                                            |              |
| `unifi_legacy_request`          | Escape hatch: port forwarding, adoption, upgrades, DPI | W ⚠️ non-GET |
| `unifi_legacy_unblock_client`   | Let a blocked client back on                           | W            |
| `unifi_legacy_block_client`     | Block a client by MAC                                  | W ⚠️         |
| `unifi_legacy_reconnect_client` | Kick a client so it reassociates                       | W ⚠️         |

## A worked example: find and reboot a stuck access point

```
unifi_list_devices { "state": "OFFLINE" }
  → [{ id: "…", name: "Garage AP", model: "U6LR", state: "OFFLINE", … }]

unifi_get_device_stats { "deviceId": "…" }
  → { uptimeSec: 32, cpuUtilizationPct: 94, … }

unifi_restart_device { "deviceId": "…", "confirm": true }
```

The first call filters **on the console** — `state.eq('OFFLINE')` goes down as a query parameter,
so nothing is fetched and discarded here.

## Traps worth knowing

All of these are baked into the tool descriptions, but they explain the shape of this server.

1. **There are two kinds of API key.** A cloud key from `unifi.ui.com` is not a local console
   key, and using one against a local console gives a 401 that looks like a typo. See Configure.
2. **Cloud mode cannot reach a console the Site Manager API does not list.** `UNIFI_CONSOLE_ID`
   has to come from `GET https://api.ui.com/v1/hosts`, and that listing is not the same as what
   unifi.ui.com shows you. A console grouped into a **Fabric** — several consoles (Network,
   Protect, NAS) presented under one name — appears in the web UI but **not** in `/v1/hosts`,
   even with `cloudConnected: true` on the console itself. Observed on a UDM-Pro that the portal
   showed and the API did not, on both `/v1/hosts` and `/ea/hosts`, with no pagination involved.
   For such a console there is no host id, so cloud mode is unavailable and you need a local
   Integration key with `UNIFI_MODE=unifios`.
3. **`siteId` is a UUID, not `default`.** A site has three identifiers: the UUID this API's paths
   take, the legacy 8-character `internalReference` that appears in every controller URL and forum
   post, and a display name. Every tool accepts all three. The legacy tools need the
   `internalReference`, and that translation happens for you too.
4. **The endpoint set depends on the console's version.** 7 paths in 9.0, 12 in 9.3, 32 in 10.0,
   44 in 10.3. The server probes `GET /v1/info` at startup and registers accordingly, so the tool
   list can differ between two runs against different consoles. `unifi_get_console_info` says why.
   If the console cannot be reached at startup the server still comes up, assumes the newest
   version, and lets any gap surface as an error naming the version it needs — a visible failure
   beats a silently missing tool.
5. **Local consoles use self-signed certificates, and pinning one is not enough.** The
   certificate is issued to `unifi.local` with no IP SAN, so a console addressed by IP fails
   verification however the certificate is trusted — you need a host name too. See Security.
6. **The classic self-hosted controller has no Integration API.** API keys are UniFi OS only, so
   port 8443 means the legacy tier or nothing. The config refuses the contradictory combination
   rather than failing later at request time.
7. **The legacy API reports errors with HTTP 200.** `{"meta":{"rc":"error"}}` is a failure however
   healthy the status line looks. That is unwrapped for you in one place.
8. **Legacy payloads are enormous** — a `stat/device` object declares ~423 fields and one UDM-Pro
   is 50–150 KB. Legacy responses are projected down, and `unifi_legacy_request` refuses anything
   over 5 MB rather than parsing it. Pass `attrs` and `_limit`.
9. **Login is rate-limited.** The legacy session is established once per server start and reused;
   a 429 on login is never retried, because retrying deepens the lockout.

## Troubleshooting

**The server does not appear / `Connection closed`.** Run `node dist/cli.js` by hand with the same
environment and read stderr — this server is built never to exit on missing configuration, so a
real crash is visible there.

**A tool I expected is missing.** Call `unifi_auth_status`, then `unifi_get_console_info`. It is
almost always the version gate or the write flag, both of which unregister rather than refuse.

**401 on every call.** The key is per-console and shown only once. Re-create it under
one of **two different kinds of key**, which are not interchangeable and which produce a
confusing 401 when mixed up:

- **Local Integration key** — created on the console itself at
  `https://<console>/network/default/settings/control-plane/integrations`. This is what
  `UNIFI_MODE=unifios` needs. Use the URL rather than hunting the sidebar: on Network 10.6
  `Control Plane` lives under a heading named after your console at the _bottom_ of the settings
  sidebar, below `System`, which is why it gets reported as missing.
- **Cloud Site Manager key** — created at `https://unifi.ui.com/settings/api-keys`. A console's
  local API **rejects this with a 401**. It is used with `UNIFI_MODE=cloud` and
  `UNIFI_CONSOLE_ID`, which also works behind CGNAT and needs no TLS workaround at all.

Either kind is shown once and can afterwards only be renamed or deleted, any admin can create one,
and creation sometimes errors on the first attempt, so retry before assuming it is broken.

**`fetch failed` / certificate errors.** Self-signed certificate; see Security.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest, offline, no credentials needed
pnpm typecheck
pnpm lint && pnpm format
```

Release:

```bash
pnpm dlx release-it        # bump, commit, tag
git push --follow-tags     # CI publishes to npm and cuts the GitHub release
```

The offline suite covers the registration matrix, the confirm gates, site resolution and both
error envelopes. The real-console check is the `curl` probe in `.env.example` plus the inspector.

## License

MIT
