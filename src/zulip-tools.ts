import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { ZulipClient } from "./zulip.js";

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

/**
 * Create an MCP server that exposes Zulip API tools to Claude.
 * The tools give Claude read access to channels, users, topics, and messages.
 */
export function createZulipMcpServer(client: ZulipClient) {
  const listChannels = tool(
    "zulip_list_channels",
    "List all channels (streams) in the Zulip organization, with their descriptions and subscriber counts.",
    {},
    async () => text(await client.callEndpoint("/streams", "GET")),
  );

  const getChannelTopics = tool(
    "zulip_get_channel_topics",
    "List recent topics in a channel/stream.",
    { stream_id: z.number().describe("The numeric ID of the channel") },
    async ({ stream_id }) =>
      text(await client.callEndpoint(`/users/me/${stream_id}/topics`, "GET")),
  );

  const listUsers = tool(
    "zulip_list_users",
    "List all users in the Zulip organization with their names, emails, roles, and active status.",
    {},
    async () => text(await client.callEndpoint("/users", "GET")),
  );

  const getUserProfile = tool(
    "zulip_get_user",
    "Get detailed profile information for a specific user by their user ID.",
    { user_id: z.number().describe("The user's numeric ID") },
    async ({ user_id }) =>
      text(await client.callEndpoint(`/users/${user_id}`, "GET")),
  );

  const searchMessages = tool(
    "zulip_search_messages",
    "Search Zulip messages using a search query. Supports Zulip search operators like 'stream:', 'topic:', 'sender:', 'has:', 'is:', and free-text search.",
    {
      query: z
        .string()
        .describe(
          "Zulip search query, e.g. 'stream:general topic:meeting' or 'has:link sender:user@example.com'",
        ),
      num_results: z
        .number()
        .optional()
        .describe("Number of results to return (default 20, max 100)"),
    },
    async ({ query, num_results }) => {
      const count = Math.min(num_results ?? 20, 100);
      return text(
        await client.callEndpoint("/messages", "GET", {
          narrow: JSON.stringify([{ operator: "search", operand: query }]),
          anchor: "newest",
          num_before: count,
          num_after: 0,
        }),
      );
    },
  );

  const getChannelMessages = tool(
    "zulip_get_messages",
    "Fetch recent messages from a specific channel and optionally a specific topic.",
    {
      channel: z.string().describe("Channel/stream name"),
      topic: z.string().optional().describe("Topic name (optional)"),
      num_messages: z
        .number()
        .optional()
        .describe("Number of messages to fetch (default 20, max 100)"),
    },
    async ({ channel, topic, num_messages }) => {
      const count = Math.min(num_messages ?? 20, 100);
      const narrow: Array<{ operator: string; operand: string }> = [
        { operator: "stream", operand: channel },
      ];
      if (topic) {
        narrow.push({ operator: "topic", operand: topic });
      }
      return text(
        await client.callEndpoint("/messages", "GET", {
          narrow: JSON.stringify(narrow),
          anchor: "newest",
          num_before: count,
          num_after: 0,
        }),
      );
    },
  );

  const getChannelSubscribers = tool(
    "zulip_get_channel_subscribers",
    "Get the list of subscriber user IDs for a channel/stream.",
    { stream_id: z.number().describe("The numeric ID of the channel") },
    async ({ stream_id }) =>
      text(await client.callEndpoint(`/streams/${stream_id}/members`, "GET")),
  );

  const getUserPresence = tool(
    "zulip_get_user_presence",
    "Check if a user is currently online/active, idle, or offline.",
    { user_id: z.number().describe("The user's numeric ID") },
    async ({ user_id }) =>
      text(await client.callEndpoint(`/users/${user_id}/presence`, "GET")),
  );

  return createSdkMcpServer({
    name: "zulip",
    version: "1.0.0",
    tools: [
      listChannels,
      getChannelTopics,
      listUsers,
      getUserProfile,
      searchMessages,
      getChannelMessages,
      getChannelSubscribers,
      getUserPresence,
    ],
  });
}
