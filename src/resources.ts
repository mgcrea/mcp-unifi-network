import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Field notes, exposed as a resource rather than stuffed into tool descriptions.
 *
 * Every entry below is here because it produced a WRONG ANSWER against a real
 * console, not because it is interesting. The common shape is an API that
 * answers successfully while meaning something other than it appears to — an
 * empty result that is not an absence, a timestamp that is not what it is named.
 * Those cannot be defended against by reading the response; you have to know
 * beforehand. Hence this file.
 */
const TROUBLESHOOTING = `# UniFi Network: traps that produce confidently wrong answers

## 1. A client that cannot connect may be invisible to the ENTIRE API

A client record is created on ASSOCIATION, which happens before the password is
checked. A station refused at the 802.11 authentication frame therefore leaves:
no client record, no entry in the known-client roster, and no event — the
controller has no event type for an auth-frame rejection at all.

So "the device is nowhere in the API" is not evidence that it is not trying. It
is the expected appearance of the most common hard failure. Use
\`unifi_diagnose_client\`, which treats this state as a named diagnosis.

### The orphaned block
Blocking a client writes its MAC to \`/etc/persistent/cfg/blocked_sta\` on EVERY
access point. Deleting the client from the controller afterwards removes the
controller's half and leaves the AP's half behind, with no UI affordance to undo
it — the UI can only offer an unblock for a client it still lists. That file
lives under \`/etc/persistent/\`, so it survives reboots AND re-provisioning;
force-provisioning does not clear it.

\`unifi_legacy_unblock_client\` is safe on a MAC the controller has never heard
of, and clears exactly this. Try it before anything else — it costs nothing.

Observed in the wild: one MAC, 638 rejections across five APs over three months,
absent from every collection in the controller database.

### Reading the evidence
Only the AP's own syslog records this, and the gateway already collects it:

    ssh <gateway> 'grep -a "<mac>" /srv/unifi/logs/remote/*.log | tail -20'

\`auth: disallowed by ACL\` + \`rejected, reason:37\` means an ACL refusal.
Silence means the device never reached the AP (wrong SSID, wrong PSK, or out of
range). No API call substitutes for this.

## 2. A filter on a value that does not exist returns EMPTY, not an error

    filter=access.type.eq('BLOCKED')          -> 0 results
    filter=access.type.eq('NOT_A_REAL_VALUE') -> 0 results

Identical replies. A zero from a filtered query is therefore not evidence of
absence, and it is very easy to report a false all-clear from one. Whenever a
filtered count is load-bearing, re-run it with a value you know is fake; if that
also returns zero, the query proves nothing.

## 3. \`last_seen\` is the last ASSOCIATION, not the last activity

It stops advancing while a client stays connected, so a device online
continuously for months carries a months-old \`last_seen\`. Measured on a live
console: 23 of 46 connected clients looked stale, several by over 100 days.

Any staleness measure built on the raw field declares healthy always-on devices
dead. \`unifi_legacy_list_known_clients\` cross-references the live association
list and exposes \`connectedNow\`; the raw value is reported as
\`lastAssociatedAt\` so the name cannot be misread.

## 4. \`unifi_list_clients\` is a live roster, not an inventory

It returns what is connected right now. Blocked, powered-off and long-absent
devices are simply absent, so it cannot answer "is anything blocked?" or "what
did I see last summer?" — and its empty result reads like an all-clear.
\`unifi_legacy_list_known_clients\` is the historical view.

## 5. Site identifiers come in three forms

\`{id: <uuid>, internalReference: "default", name: "Default"}\`. Integration API
paths take the UUID; every \`unifi_legacy_*\` path takes the \`internalReference\`.
Every tool here accepts all three and translates, so a guess is free — but a raw
\`unifi_request\` call does NOT resolve names.

## 6. Two kinds of API key

A Site Manager key from unifi.ui.com is not a local console key. Used against a
local console it returns 401, which looks like a typo. A LOCAL key is accepted on
the legacy paths too, which is why the legacy tier needs no console password on
UniFi OS.
`;

export const registerResources = (server: McpServer): void => {
  server.registerResource(
    "unifi-troubleshooting",
    "unifi://troubleshooting",
    {
      title: "UniFi troubleshooting field notes",
      description:
        "Read this BEFORE concluding that a device is absent, that nothing is blocked, or that a " +
        "client has been offline for months. Documents the API behaviours that return a " +
        "successful, plausible, wrong answer — including why a device refused at the " +
        "authentication frame appears nowhere in the API, and how to read the access-point logs " +
        "that do record it.",
      mimeType: "text/markdown",
    },
    (uri) => ({ contents: [{ uri: uri.href, text: TROUBLESHOOTING, mimeType: "text/markdown" }] }),
  );
};
