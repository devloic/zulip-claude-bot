import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { ZulipClient, ZulipMessageEvent } from "./zulip.js";
import {
  fetchTopicMessages,
  sendMessage,
  startStreamingMessage,
} from "./zulip.js";
import { htmlToText } from "./html-to-text.js";
import { askClaude } from "./claude.js";

export async function handleMessage(
  client: ZulipClient,
  botEmail: string,
  event: ZulipMessageEvent,
  config: Config,
  zulipMcp: McpSdkServerConfigWithInstance,
): Promise<void> {
  const msg = event.message;

  // Only handle stream (channel) messages
  if (msg.type !== "stream") {
    return;
  }

  // Don't respond to own messages
  if (msg.sender_email === botEmail) {
    return;
  }

  // Only respond to @-mentions
  if (!event.flags.includes("mentioned")) {
    return;
  }

  const channel = msg.display_recipient;
  const topic = msg.subject;

  console.log(`Processing message ${msg.id} from ${msg.sender_full_name}`);

  // Post streaming message (shows spinner, then live text, then final answer)
  const streaming = await startStreamingMessage(client, channel, topic);

  try {
    // Extract question from HTML content
    const question = htmlToText(msg.content);
    if (!question.trim()) {
      await streaming.cancel();
      await sendMessage(
        client,
        channel,
        topic,
        "It looks like you mentioned me but didn't include a question. How can I help?",
      );
      return;
    }

    // Fetch recent topic messages for context
    const recentMessages = await fetchTopicMessages(
      client,
      channel,
      topic,
      config.contextMessages,
    );

    // Format conversation context (exclude the triggering message itself)
    const context = recentMessages
      .filter((m) => m.id !== msg.id)
      .map((m) => `${m.sender_full_name}: ${htmlToText(m.content)}`)
      .join("\n");

    // Ask Claude with streaming
    console.log("Calling Claude...");
    const answer = await askClaude(
      question,
      context,
      config,
      zulipMcp,
      (text) => streaming.update(text),
    );
    console.log(`Claude responded (${answer.length} chars)`);

    // Finalize with the complete answer
    await streaming.finalize(answer);
  } catch (err) {
    await streaming.cancel();
    const errorMsg =
      err instanceof Error ? err.message : "An unknown error occurred";
    console.error(`Error handling message ${msg.id}:`, errorMsg);
    await sendMessage(
      client,
      channel,
      topic,
      `Sorry, I encountered an error processing your request: ${errorMsg}`,
    ).catch((sendErr) => {
      console.error("Failed to send error message:", sendErr);
    });
  }
}
