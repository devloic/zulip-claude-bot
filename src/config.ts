import "dotenv/config";

export interface Config {
  zulipUsername: string;
  zulipApiKey: string;
  zulipRealm: string;
  contextMessages: number;
  claudeMaxTurns: number;
  claudeCwd: string;
  claudeModel?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    zulipUsername: requireEnv("ZULIP_USERNAME"),
    zulipApiKey: requireEnv("ZULIP_API_KEY"),
    zulipRealm: requireEnv("ZULIP_REALM"),
    contextMessages: parseInt(process.env.CONTEXT_MESSAGES ?? "20", 10),
    claudeMaxTurns: parseInt(process.env.CLAUDE_MAX_TURNS ?? "10", 10),
    claudeCwd: process.env.CLAUDE_CWD ?? process.cwd(),
    claudeModel: process.env.CLAUDE_MODEL || undefined,
  };
}
