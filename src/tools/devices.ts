import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { summarizeDevice, wrapCollected } from "#/client/shape";
import { and, eq, like } from "#/filter";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, deviceIdArg, filterArg, limitArg, siteArg, wrap } from "#/tools/util";
import { atLeast } from "#/version";

const STATES = [
  "ONLINE",
  "OFFLINE",
  "PENDING_ADOPTION",
  "UPDATING",
  "GETTING_READY",
  "ADOPTING",
  "DELETING",
  "CONNECTION_INTERRUPTED",
  "ISOLATED",
  "U5G_INCORRECT_TOPOLOGY",
] as const;

export const registerDeviceTools = (server: McpServer, ctx: ToolContext): void => {
  const { client, sites, allowWrites, probe } = ctx;

  server.registerTool(
    "unifi_list_devices",
    {
      description:
        "List the UniFi devices adopted by a site — access points, switches, gateways — with " +
        "their state, model, IP, MAC and firmware. Use `firmwareUpdatable: true` to find what " +
        'needs upgrading, or `state: "OFFLINE"` to find what is down. ' +
        "The nested `features` and `interfaces` blocks are omitted here; `unifi_get_device` " +
        "returns the complete object for one device.",
      inputSchema: {
        site: siteArg,
        state: z.enum(STATES).optional().describe("Only devices in this state."),
        name: z
          .string()
          .optional()
          .describe('Match the device name, with `*` as a wildcard — e.g. "*garage*".'),
        firmwareUpdatable: z
          .boolean()
          .optional()
          .describe("True to list only devices with a firmware update available."),
        filter: filterArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, state, name, firmwareUpdatable, filter, limit }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        const built =
          filter ??
          and(
            state ? eq("state", state) : undefined,
            name ? like("name", name) : undefined,
            firmwareUpdatable !== undefined
              ? eq("firmwareUpdatable", firmwareUpdatable)
              : undefined,
          );
        const collected = await client.listAll(
          client.sitePath(siteId, "/devices"),
          compact({ filter: built }),
          compact({ limit }),
        );
        return wrapCollected(collected, summarizeDevice);
      }),
  );

  server.registerTool(
    "unifi_get_device",
    {
      description:
        "Get one adopted device in full, including its `features`, `interfaces`, uplink and " +
        "adoption timestamps — everything `unifi_list_devices` trims away.",
      inputSchema: { site: siteArg, deviceId: deviceIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ site, deviceId }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        // A get returns the whole object unshaped — that is the point of a get.
        return client.get(client.sitePath(siteId, `/devices/${encodeURIComponent(deviceId)}`));
      }),
  );

  server.registerTool(
    "unifi_get_device_stats",
    {
      description:
        "Get a device's latest telemetry: uptime, CPU and memory utilization, load averages, " +
        "uplink throughput and per-radio transmit retry rates. This is the current snapshot the " +
        "console holds, not a time series — there is no history endpoint in this API.",
      inputSchema: { site: siteArg, deviceId: deviceIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ site, deviceId }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        return client.get(
          client.sitePath(siteId, `/devices/${encodeURIComponent(deviceId)}/statistics/latest`),
        );
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "unifi_restart_device",
    {
      description:
        "Restart an adopted device. It drops off the network for a minute or two and takes every " +
        "client on it down with it — restarting a gateway or the switch you are connected " +
        "through will interrupt your own session. There is no cancel once it is issued.",
      inputSchema: { site: siteArg, deviceId: deviceIdArg, confirm: confirmArg },
      // Deliberately NOT idempotent: calling it twice reboots twice, and the
      // second reboot interrupts the first boot. Marking it idempotent is an
      // invitation to exactly that retry.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ site, deviceId }) =>
      wrap(async () => {
        const siteId = await sites.resolve(site);
        return client.post(
          client.sitePath(siteId, `/devices/${encodeURIComponent(deviceId)}/actions`),
          { action: "RESTART" },
        );
      }),
  );

  if (atLeast(probe.tier, "clients-plus")) {
    server.registerTool(
      "unifi_power_cycle_port",
      {
        description:
          "Power-cycle one PoE port on a switch, rebooting whatever is plugged into it. Use this " +
          "to reboot a camera, phone or access point that has no restart tool of its own. " +
          "The port index is the physical port number as shown in the UniFi UI, from " +
          "`unifi_get_device`'s `interfaces.ports`.",
        inputSchema: {
          site: siteArg,
          deviceId: deviceIdArg.describe(
            "The SWITCH's `id` from `unifi_list_devices` — not the id of the device being " +
              "rebooted, which is only reachable through the port it is plugged into.",
          ),
          portIdx: z
            .number()
            .int()
            .min(1)
            .describe("Physical port number on that switch, as labelled in the UniFi UI."),
          confirm: confirmArg,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ site, deviceId, portIdx }) =>
        wrap(async () => {
          const siteId = await sites.resolve(site);
          return client.post(
            client.sitePath(
              siteId,
              `/devices/${encodeURIComponent(deviceId)}/interfaces/ports/${portIdx}/actions`,
            ),
            { action: "POWER_CYCLE" },
          );
        }),
    );
  }
};
