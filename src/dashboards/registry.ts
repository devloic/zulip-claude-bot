import type { ServiceContext } from "../services/types.js";
import type { DashboardRow } from "../db.js";
import { helpDef } from "./help.js";
import { rssDef } from "./rss.js";

export interface DashboardDef {
  description: string;
  /** Override the default 60s interval. */
  intervalMs?: number;
  /** Usage hint shown in help, e.g. "rss <url>". Defaults to just the name. */
  usage?: string;
  /** Validate params before starting. Return error message or null if OK. */
  validateParams?(params: string): string | null;
  /** Called each tick; returns the markdown content for the pinned message. */
  fetch(params: string, ctx: ServiceContext, row: DashboardRow): Promise<string>;
}

export const dashboardRegistry = new Map<string, DashboardDef>();

// ── Built-in dashboards ──────────────────────────────────────────

dashboardRegistry.set("clock", {
  description: "Current date & time",
  intervalMs: 5_000,
  async fetch(_params, _ctx, _row) {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    const time = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZone: "UTC",
    });
    return `🕐 **${date}** — ${time} UTC`;
  },
});

// ── Additional dashboards (registered after Map exists) ──────────

dashboardRegistry.set("help", helpDef);
dashboardRegistry.set("rss", rssDef);
