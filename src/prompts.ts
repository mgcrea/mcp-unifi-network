import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Prompts, which clients surface as slash commands.
 *
 * These are NOT a second copy of the tool descriptions. A tool description says
 * what one call does; these carry the ORDER to call things in and the wrong
 * conclusions to avoid on the way — the part that cost hours to learn and that
 * no single description can hold, because it spans several tools.
 *
 * Prompt arguments are strings in the MCP protocol, with no enum or number
 * types, so anything numeric is parsed here and every argument is optional
 * wherever a sensible default exists: a slash command that errors on a missing
 * argument is worse than one that assumes a week.
 */
const user = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export const registerPrompts = (server: McpServer): void => {
  server.registerPrompt(
    "diagnose-client",
    {
      title: "Diagnose a device that will not connect",
      description:
        "Work out why one device cannot get on the WiFi — blocked, absent, out of range, or " +
        "connected and failing higher up.",
      argsSchema: z.object({
        device: z
          .string()
          .describe('MAC, name, or fragment — e.g. "husqvarna", "14:5d:34:1a:62:da", "mower".'),
      }),
    },
    ({ device }) =>
      user(
        `Work out why "${device}" cannot connect to the WiFi.\n\n` +
          `Start with unifi_diagnose_client — not unifi_list_clients. The live client list only ` +
          `shows what is connected right now, so a device with this complaint is usually absent ` +
          `from it, and that empty result reads misleadingly like an all-clear.\n\n` +
          `If the name finds nothing, try the manufacturer instead: an appliance often has no ` +
          `friendly name and is only findable by vendor or MAC.\n\n` +
          `If the verdict is "absent", do not stop there and do not report "device not found". ` +
          `Absent is a diagnosis: a client record is written on association, which happens ` +
          `before the password is checked, so a device refused at the 802.11 authentication ` +
          `frame leaves no record and no event anywhere in this API. Follow the remedy in the ` +
          `explanation field, and read unifi://troubleshooting before concluding anything.\n\n` +
          `Report the verdict, the evidence behind it, and the single next action.`,
      ),
  );

  server.registerPrompt(
    "new-devices",
    {
      title: "Review devices that recently joined",
      description:
        "List devices seen on the network for the first time recently, with enough identity to " +
        "judge whether each is expected.",
      argsSchema: z.object({
        days: z.string().optional().describe("How many days back. Defaults to 7."),
      }),
    },
    ({ days }) => {
      const parsed = Number.parseInt(days ?? "", 10);
      const window = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
      return user(
        `List every device that joined this network for the first time in the last ${window} ` +
          `days, and assess whether each looks expected.\n\n` +
          `Use unifi_legacy_list_known_clients with firstSeenWithinDays=${window}. It must be ` +
          `firstSeenWithinDays, not seenWithinDays: the second matches every device that has ` +
          `been active recently, which on a normal network is nearly all of them.\n\n` +
          `For each result give the name or vendor, the network it joined, and the AP it came ` +
          `in on. Expect noise: phones using MAC randomisation mint a fresh address per network ` +
          `and appear as unnamed entries with an empty vendor — say so rather than presenting ` +
          `them as intruders. Flag anything with a real vendor that you cannot account for.\n\n` +
          `Do not describe this as a security audit. It is a list of first sightings, and a ` +
          `device being new is not evidence of anything by itself.`,
      );
    },
  );

  server.registerPrompt(
    "network-health",
    {
      title: "Check the network is healthy",
      description:
        "Review subsystem health, device state, firmware, WiFi security posture and blocked " +
        "clients, and report what actually needs attention.",
    },
    () =>
      user(
        `Check whether this UniFi network is healthy.\n\n` +
          `Call unifi_health_check first — it composes subsystem health, device state and ` +
          `firmware, WiFi security posture, blocked clients and any configuration ` +
          `contradictions into one ranked list, so it is a single call rather than five.\n\n` +
          `Report the warnings first and say plainly what each one costs. Notes are usually ` +
          `deliberate choices; mention them briefly and do not present them as problems. If ` +
          `nothing is wrong, say so in a sentence rather than padding the answer with every ` +
          `subsystem that is fine.\n\n` +
          `Only reach for more tools if a finding needs explaining — unifi_legacy_list_events ` +
          `for what happened, unifi_diagnose_client for a specific device.`,
      ),
  );
};
