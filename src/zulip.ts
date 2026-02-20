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

export interface ZulipReactionEvent {
  type: "reaction";
  id: number;
  op: "add" | "remove";
  user_id: number;
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  reaction_type: string;
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
  reactions: {
    add(params: {
      message_id: number;
      emoji_name: string;
    }): Promise<{ result: string }>;
    remove(params: {
      message_id: number;
      emoji_name: string;
    }): Promise<{ result: string }>;
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
      events: Array<
        | ZulipMessageEvent
        | ZulipReactionEvent
        | { type: string; id: number }
      >;
      result: string;
    }>;
  };
  callEndpoint(
    endpoint: string,
    method?: string,
    params?: Record<string, unknown>,
  ): Promise<{ result: string; msg?: string; [key: string]: unknown }>;
}

export async function initZulip(
  config: Config,
): Promise<{ client: ZulipClient; botEmail: string; botName: string; botUserId: number }> {
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
    botUserId: profile.user_id,
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

export interface StreamingMessage {
  /** Update with streamed text (flushes every ~40 new words). */
  update(content: string): void;
  /** Finalize with the complete answer. Handles long-message splitting. */
  finalize(content: string): Promise<void>;
  /** Delete the message (used on error or empty question). */
  cancel(): Promise<void>;
}

/**
 * Post a ":loading: Thinking..." status message that transitions
 * into a live-streaming response. Shows elapsed seconds until the
 * first text arrives, then progressively updates with Claude's output.
 */
export async function startStreamingMessage(
  client: ZulipClient,
  channel: string,
  topic: string,
): Promise<StreamingMessage> {
  const startTime = Date.now();
  let finalized = false;
  let textStarted = false;

  const res = await client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: ":loading: Thinking...",
  });
  const messageId = res.id;

  // Elapsed-seconds timer (runs until first text arrives)
  const spinnerTimer = setInterval(() => {
    if (finalized || textStarted) return;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    client
      .callEndpoint(`/messages/${messageId}`, "PATCH", {
        content: `:loading: Thinking... (${elapsed}s)`,
      })
      .catch(() => {});
  }, 2000);

  // Word-count-based updates (flush every ~40 new words)
  const WORD_FLUSH_THRESHOLD = 40;
  let lastFlushedWordCount = 0;
  let latestContent: string | null = null;

  function countWords(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function flush() {
    if (finalized || latestContent === null) return;
    lastFlushedWordCount = countWords(latestContent);
    const content = latestContent;
    latestContent = null;
    client
      .callEndpoint(`/messages/${messageId}`, "PATCH", { content })
      .catch(() => {});
  }

  function update(content: string) {
    if (finalized) return;
    if (!textStarted) {
      textStarted = true;
      clearInterval(spinnerTimer);
    }
    latestContent = content;
    if (countWords(content) - lastFlushedWordCount >= WORD_FLUSH_THRESHOLD) {
      flush();
    }
  }

  async function finalize(content: string) {
    finalized = true;
    clearInterval(spinnerTimer);

    if (content.length <= MAX_MESSAGE_LENGTH) {
      // Fits in one message — update the existing one
      await client
        .callEndpoint(`/messages/${messageId}`, "PATCH", { content })
        .catch(() => {});
    } else {
      // Split: first chunk replaces the streaming message, rest are new messages
      const chunks = splitMessage(content, MAX_MESSAGE_LENGTH);
      await client
        .callEndpoint(`/messages/${messageId}`, "PATCH", {
          content: chunks[0],
        })
        .catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await client.messages.send({
          to: channel,
          type: "stream",
          subject: topic,
          content: chunks[i],
        });
      }
    }
  }

  async function cancel() {
    finalized = true;
    clearInterval(spinnerTimer);
    await client
      .callEndpoint(`/messages/${messageId}`, "DELETE")
      .catch(() => {});
  }

  return { update, finalize, cancel };
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
