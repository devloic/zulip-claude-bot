import type { DashboardDef } from "./registry.js";
import { dashboardRegistry } from "./registry.js";
import { activeServices } from "../services/loader.js";

function buildHelp(): string {
  const lines: string[] = ["## Bot Commands\n"];

  // ── Service commands (tasks, dashboards, etc.) ───────────────
  for (const svc of activeServices) {
    if (!svc.commands || svc.commands.length === 0) continue;

    lines.push(`### ${svc.name.charAt(0).toUpperCase() + svc.name.slice(1)}`);
    lines.push(`*${svc.description}*\n`);
    lines.push("| Command | Description |");
    lines.push("|---------|-------------|");
    for (const cmd of svc.commands) {
      lines.push(`| \`${cmd.usage}\` | ${cmd.description} |`);
    }
    lines.push("");
  }

  // ── Available dashboards ─────────────────────────────────────
  lines.push("### Available Dashboards\n");
  lines.push("| Name | Description | Interval |");
  lines.push("|------|-------------|----------|");
  for (const [name, def] of dashboardRegistry) {
    const usage = def.usage ?? name;
    const interval = def.intervalMs
      ? def.intervalMs >= 60_000
        ? `${def.intervalMs / 60_000} min`
        : `${def.intervalMs / 1_000}s`
      : "60s";
    lines.push(`| \`${usage}\` | ${def.description} | ${interval} |`);
  }
  lines.push("");

  // ── AI assistant (always present) ────────────────────────────
  lines.push("### AI Assistant");
  lines.push(
    "Mention the bot with any question or request — it will respond using Claude with full conversation context. " +
      "Claude can also query Zulip directly (search messages, list channels/users, create channels, etc.).",
  );

  return lines.join("\n");
}

export const helpDef: DashboardDef = {
  description: "Bot features & command reference",
  intervalMs: 60 * 60_000,
  async fetch(_params, _ctx, _row) {
    return buildHelp();
  },
};
