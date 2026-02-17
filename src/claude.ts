import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";

export async function askClaude(
  question: string,
  conversationContext: string,
  config: Config,
): Promise<string> {
  const systemPrompt = [
    "You are a helpful coding assistant bot in a Zulip chat.",
    "You have access to tools for reading files, searching code, running commands, and web search.",
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
    allowedTools: ["Read", "Grep", "Glob", "Bash", "WebSearch"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: config.claudeCwd,
    maxTurns: config.claudeMaxTurns,
    persistSession: false,
  };

  if (config.claudeModel) {
    options.model = config.claudeModel;
  }

  for await (const message of query({ prompt: question, options })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        return message.result;
      }
      // Error result
      const errors =
        "errors" in message ? message.errors.join("; ") : "Unknown error";
      throw new Error(`Claude query failed (${message.subtype}): ${errors}`);
    }
  }

  throw new Error("Claude query ended without a result message");
}
