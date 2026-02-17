import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

export async function askClaude(
  question: string,
  conversationContext: string,
  config: Config,
  zulipMcp: McpSdkServerConfigWithInstance,
  onText?: (accumulatedText: string) => void,
): Promise<string> {
  const systemPrompt = [
    "You are a helpful coding assistant bot in a Zulip chat.",
    "You have access to tools for reading files, searching code, running commands, and web search.",
    "You also have access to Zulip API tools (prefixed with mcp__zulip__) to look up channels, users, topics, messages, and presence.",
    "Answer questions clearly and concisely. Use Zulip-compatible markdown formatting.",
    "When referencing code, include file paths and line numbers when possible.",
    "",
    "Here is the recent conversation context from this Zulip topic:",
    "---",
    conversationContext,
    "---",
  ].join("\n");

  const options: Parameters<typeof query>[0]["options"] = {
    systemPrompt,
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "WebSearch",
      "mcp__zulip__*",
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: config.claudeCwd,
    maxTurns: config.claudeMaxTurns,
    persistSession: false,
    mcpServers: { zulip: zulipMcp },
  };

  if (config.claudeModel) {
    options.model = config.claudeModel;
  }

  if (onText) {
    (options as Record<string, unknown>).includePartialMessages = true;
  }

  let accumulated = "";

  for await (const message of query({ prompt: question, options })) {
    // Stream text deltas to the callback
    if (onText && message.type === "stream_event") {
      const event = (message as { event: Record<string, unknown> }).event;
      if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          accumulated += delta.text;
          onText(accumulated);
        }
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        return message.result;
      }
      const errors =
        "errors" in message ? message.errors.join("; ") : "Unknown error";
      throw new Error(`Claude query failed (${message.subtype}): ${errors}`);
    }
  }

  throw new Error("Claude query ended without a result message");
}
