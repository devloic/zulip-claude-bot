import type { Config } from "./config.js";
import type { ZulipClient, ZulipMessageEvent } from "./zulip.js";
import { fetchTopicMessages, sendMessage } from "./zulip.js";
import { htmlToText } from "./html-to-text.js";
import { askClaude } from "./claude.js";

export async function handleMessage(
  client: ZulipClient,
  botEmail: string,
  event: ZulipMessageEvent,
  config: Config,
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

  try {
    // Extract question from HTML content
    const question = htmlToText(msg.content);
    if (!question.trim()) {
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

    // Ask Claude
    const answer = await askClaude(question, context, config);

    // Send response
    await sendMessage(client, channel, topic, answer);
  } catch (err) {
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
