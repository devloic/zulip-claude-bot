import zulipInit from "zulip-js";
import type { Config } from "./config.js";

// zulip-js doesn't ship types, so we define the shapes we use.

export interface ZulipMessage {
  id: number;
  sender_email: string;
  sender_full_name: string;
  type: "stream" | "private";
  display_recipient: string;
  subject: string;
  content: string;
}

export interface ZulipMessageEvent {
  type: "message";
  id: number;
  message: ZulipMessage;
  flags: string[];
}

export interface ZulipClient {
  messages: {
    retrieve(params: {
      narrow: Array<{ operator: string; operand: string }>;
      anchor: string;
      num_before: number;
      num_after: number;
    }): Promise<{ messages: ZulipMessage[]; result: string }>;
    send(params: {
      to: string;
      type: string;
      subject: string;
      content: string;
    }): Promise<{ id: number; result: string; msg: string }>;
  };
  users: {
    me: {
      getProfile(): Promise<{
        email: string;
        full_name: string;
        user_id: number;
        result: string;
      }>;
    };
  };
  queues: {
    register(params: {
      event_types: string[];
    }): Promise<{ queue_id: string; last_event_id: number; result: string }>;
  };
  events: {
    retrieve(params: {
      queue_id: string;
      last_event_id: number;
      dont_block?: boolean;
    }): Promise<{
      events: Array<ZulipMessageEvent | { type: string; id: number }>;
      result: string;
    }>;
  };
}

export async function initZulip(
  config: Config,
): Promise<{ client: ZulipClient; botEmail: string; botName: string }> {
  const client = (await zulipInit({
    username: config.zulipUsername,
    apiKey: config.zulipApiKey,
    realm: config.zulipRealm,
  })) as unknown as ZulipClient;

  const profile = await client.users.me.getProfile();
  return {
    client,
    botEmail: profile.email,
    botName: profile.full_name,
  };
}

export async function fetchTopicMessages(
  client: ZulipClient,
  channel: string,
  topic: string,
  count: number,
): Promise<ZulipMessage[]> {
  const response = await client.messages.retrieve({
    narrow: [
      { operator: "channel", operand: channel },
      { operator: "topic", operand: topic },
    ],
    anchor: "newest",
    num_before: count,
    num_after: 0,
  });
  return response.messages;
}

const MAX_MESSAGE_LENGTH = 9500;

export async function sendMessage(
  client: ZulipClient,
  channel: string,
  topic: string,
  content: string,
): Promise<void> {
  const chunks = splitMessage(content, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: chunk,
    });
  }
}

/**
 * Split a message at paragraph boundaries if it exceeds maxLen.
 * Falls back to hard-splitting if a single paragraph is too long.
 */
function splitMessage(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > maxLen) {
    // Try to split at a paragraph boundary (double newline)
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx <= 0) {
      // Fall back to single newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx <= 0) {
      // Hard split at maxLen
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
