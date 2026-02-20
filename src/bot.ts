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
import type { Service, ServiceContext } from "./services/types.js";

export async function handleMessage(
  event: ZulipMessageEvent,
  services: Service[],
  ctx: ServiceContext,
  zulipMcp: McpSdkServerConfigWithInstance,
): Promise<void> {
  const msg = event.message;

  if (msg.type !== "stream") return;
  if (msg.sender_email === ctx.botEmail) return;
  if (!event.flags.includes("mentioned")) return;

  const channel = msg.display_recipient;
  const topic = msg.subject;

  console.log(`Processing message ${msg.id} from ${msg.sender_full_name}`);

  // Let services handle the message first (first match wins)
  for (const svc of services) {
    if (!svc.onMessage) continue;
    try {
      const handled = await svc.onMessage(msg, ctx);
      if (handled) return;
    } catch (err) {
      console.error(`[${svc.name}] error in onMessage:`, err);
    }
  }

  // No service claimed it — pass to Claude
  const streaming = await startStreamingMessage(ctx.client, channel, topic);

  try {
    const question = htmlToText(msg.content);
    if (!question.trim()) {
      await streaming.cancel();
      await sendMessage(
        ctx.client,
        channel,
        topic,
        "It looks like you mentioned me but didn't include a question. How can I help?",
      );
      return;
    }

    const recentMessages = await fetchTopicMessages(
      ctx.client,
      channel,
      topic,
      ctx.config.contextMessages,
    );

    const context = recentMessages
      .filter((m) => m.id !== msg.id)
      .map((m) => `${m.sender_full_name}: ${htmlToText(m.content)}`)
      .join("\n");

    console.log("Calling Claude...");
    const answer = await askClaude(
      question,
      context,
      ctx.config,
      zulipMcp,
      (text) => streaming.update(text),
    );
    console.log(`Claude responded (${answer.length} chars)`);

    await streaming.finalize(answer);
  } catch (err) {
    await streaming.cancel();
    const errorMsg =
      err instanceof Error ? err.message : "An unknown error occurred";
    console.error(`Error handling message ${msg.id}:`, errorMsg);
    await sendMessage(
      ctx.client,
      channel,
      topic,
      `Sorry, I encountered an error processing your request: ${errorMsg}`,
    ).catch((sendErr) => {
      console.error("Failed to send error message:", sendErr);
    });
  }
}
