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

  const getMessageById = tool(
    "zulip_get_message_by_id",
    "Fetch a single message by its numeric ID. Returns full message details including sender, content, reactions, and timestamps.",
    { message_id: z.number().describe("The message's numeric ID") },
    async ({ message_id }) =>
      text(
        await client.callEndpoint(`/messages/${message_id}`, "GET", {
          apply_markdown: false,
        }),
      ),
  );

  const getRawMessage = tool(
    "zulip_get_raw_message",
    "Get the raw markdown source of a message (before rendering). Useful to see exact code snippets and formatting.",
    { message_id: z.number().describe("The message's numeric ID") },
    async ({ message_id }) =>
      text(await client.callEndpoint(`/messages/${message_id}`, "GET", {
        apply_markdown: false,
      })),
  );

  const getMessageReactions = tool(
    "zulip_get_reactions",
    "Get all reactions (emoji) on a specific message, including who reacted.",
    { message_id: z.number().describe("The message's numeric ID") },
    async ({ message_id }) => {
      const res = await client.callEndpoint(`/messages/${message_id}`, "GET");
      const msg = res.message as { reactions?: unknown[] } | undefined;
      return text({ reactions: msg?.reactions ?? [] });
    },
  );

  const getMessageEditHistory = tool(
    "zulip_get_message_edit_history",
    "Get the edit history of a message, showing all previous versions and when they were changed.",
    { message_id: z.number().describe("The message's numeric ID") },
    async ({ message_id }) =>
      text(
        await client.callEndpoint(
          `/messages/${message_id}/history`,
          "GET",
        ),
      ),
  );

  const getUserGroups = tool(
    "zulip_get_user_groups",
    "List all user groups in the organization with their names, descriptions, and members.",
    {},
    async () => text(await client.callEndpoint("/user_groups", "GET")),
  );

  const getOwnSubscriptions = tool(
    "zulip_get_own_subscriptions",
    "List channels/streams the bot is subscribed to, with details like color, pin status, and notification settings.",
    {},
    async () =>
      text(await client.callEndpoint("/users/me/subscriptions", "GET")),
  );

  const getChannelByName = tool(
    "zulip_get_channel_by_name",
    "Get details about a specific channel by its name, including description, ID, and settings.",
    { channel: z.string().describe("The channel/stream name") },
    async ({ channel }) => {
      // Zulip API uses stream_id; look up by listing and filtering
      const res = await client.callEndpoint("/streams", "GET");
      const streams = (res.streams as Array<{ name: string }>) ?? [];
      const match = streams.find(
        (s) => s.name.toLowerCase() === channel.toLowerCase(),
      );
      return text(match ?? { error: `Channel '${channel}' not found` });
    },
  );

  const getLinkifiers = tool(
    "zulip_get_linkifiers",
    "Get the organization's linkifier patterns that auto-link text like '#1234' to external URLs (e.g., issue trackers).",
    {},
    async () => text(await client.callEndpoint("/realm/linkifiers", "GET")),
  );

  const getCustomEmoji = tool(
    "zulip_get_custom_emoji",
    "List all custom emoji in the organization.",
    {},
    async () => text(await client.callEndpoint("/realm/emoji", "GET")),
  );

  const getUserStatus = tool(
    "zulip_get_user_status",
    "Get a user's custom status text and emoji (different from online/offline presence).",
    { user_id: z.number().describe("The user's numeric ID") },
    async ({ user_id }) =>
      text(await client.callEndpoint(`/users/${user_id}/status`, "GET")),
  );

  // ── Write tools (require confirmed: true) ──────────────────────

  const CONFIRM_MSG =
    "REFUSED: confirmed must be true. You MUST first describe the action to the user and only set confirmed=true after the user explicitly replies with confirmation (e.g. 'yes', 'do it', 'go ahead') in the conversation context.";

  const createChannel = tool(
    "zulip_create_channel",
    [
      "WRITE OPERATION — Create a new channel (stream) in the organization.",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST describe what you plan to create and ask the user to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      name: z.string().describe("Name for the new channel"),
      description: z
        .string()
        .optional()
        .describe("Channel description"),
      is_private: z
        .boolean()
        .optional()
        .describe("Whether the channel is private (default: false)"),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ name, description, is_private, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      return text(
        await client.callEndpoint("/users/me/subscriptions", "POST", {
          subscriptions: JSON.stringify([
            { name, description: description ?? "" },
          ]),
          invite_only: is_private ? "true" : "false",
        }),
      );
    },
  );

  const createTopic = tool(
    "zulip_create_topic",
    [
      "WRITE OPERATION — Create a new topic in an existing channel by sending an initial message.",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST describe the channel, topic name, and initial message to the user and ask them to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      channel: z.string().describe("The channel/stream name"),
      topic: z.string().describe("The new topic name"),
      content: z.string().describe("The initial message content (markdown)"),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ channel, topic, content, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      return text(
        await client.messages.send({
          to: channel,
          type: "stream",
          subject: topic,
          content,
        }),
      );
    },
  );

  const subscribeUsers = tool(
    "zulip_subscribe_users",
    [
      "WRITE OPERATION — Subscribe one or more users to a channel by their email addresses.",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST list the users and target channel and ask the user to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      channel: z.string().describe("The channel/stream name"),
      emails: z
        .array(z.string())
        .describe("Email addresses of users to subscribe"),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ channel, emails, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      return text(
        await client.callEndpoint("/users/me/subscriptions", "POST", {
          subscriptions: JSON.stringify([{ name: channel }]),
          principals: JSON.stringify(emails),
        }),
      );
    },
  );

  // ── Channel folder tools ────────────────────────────────────────

  const getChannelFolders = tool(
    "zulip_get_channel_folders",
    "List all channel folders in the organization. Folders group related channels together.",
    {},
    async () => text(await client.callEndpoint("/channel_folders", "GET")),
  );

  const createChannelFolder = tool(
    "zulip_create_channel_folder",
    [
      "WRITE OPERATION — Create a new channel folder to group related channels.",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST describe the folder name and description to the user and ask them to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      name: z.string().describe("Name for the new folder"),
      description: z
        .string()
        .optional()
        .describe("Folder description"),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ name, description, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      const params: Record<string, string> = { name };
      if (description) params.description = description;
      return text(
        await client.callEndpoint("/channel_folders/create", "POST", params),
      );
    },
  );

  const updateChannelFolder = tool(
    "zulip_update_channel_folder",
    [
      "WRITE OPERATION — Update a channel folder's name, description, or archive status.",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST describe the changes to the user and ask them to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      folder_id: z.number().describe("The folder's numeric ID"),
      name: z.string().optional().describe("New folder name"),
      description: z.string().optional().describe("New folder description"),
      is_archived: z
        .boolean()
        .optional()
        .describe("Set true to archive, false to unarchive"),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ folder_id, name, description, is_archived, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      const params: Record<string, unknown> = {};
      if (name !== undefined) params.name = name;
      if (description !== undefined) params.description = description;
      if (is_archived !== undefined) params.is_archived = is_archived;
      return text(
        await client.callEndpoint(
          `/channel_folders/${folder_id}`,
          "PATCH",
          params,
        ),
      );
    },
  );

  const moveChannelToFolder = tool(
    "zulip_move_channel_to_folder",
    [
      "WRITE OPERATION — Move a channel into a folder (or remove from folder by setting folder_id to null).",
      "REQUIRES CONFIRMATION: Before calling this tool, you MUST describe which channel and folder to the user and ask them to confirm.",
      "Only set confirmed=true after the user has explicitly confirmed in the conversation.",
    ].join(" "),
    {
      stream_id: z.number().describe("The channel's numeric ID"),
      folder_id: z
        .number()
        .nullable()
        .describe(
          "The folder ID to move the channel into, or null to remove from folder",
        ),
      confirmed: z
        .boolean()
        .describe(
          "Must be true. Only set after user explicitly confirms in the conversation.",
        ),
    },
    async ({ stream_id, folder_id, confirmed }) => {
      if (!confirmed) return text({ error: CONFIRM_MSG });
      return text(
        await client.callEndpoint(`/streams/${stream_id}`, "PATCH", {
          channel_folder_id: folder_id,
        }),
      );
    },
  );

  return createSdkMcpServer({
    name: "zulip",
    version: "1.0.0",
    tools: [
      // Read tools
      listChannels,
      getChannelTopics,
      listUsers,
      getUserProfile,
      searchMessages,
      getChannelMessages,
      getChannelSubscribers,
      getUserPresence,
      getMessageById,
      getRawMessage,
      getMessageReactions,
      getMessageEditHistory,
      getUserGroups,
      getOwnSubscriptions,
      getChannelByName,
      getLinkifiers,
      getCustomEmoji,
      getUserStatus,
      getChannelFolders,
      // Write tools (require confirmation)
      createChannel,
      createTopic,
      subscribeUsers,
      createChannelFolder,
      updateChannelFolder,
      moveChannelToFolder,
    ],
  });
}
