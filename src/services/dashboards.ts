import type { Service, ServiceContext } from "./types.js";
import type { ZulipMessage, ZulipReactionEvent } from "../zulip.js";
import type { DashboardRow } from "../db.js";
import {
  createDashboard,
  getActiveDashboards,
  getDashboardsByChannelTopic,
  getDashboardByNameAndLocation,
  getDashboardByMsgId,
  deleteDashboard,
} from "../db.js";
import { dashboardRegistry } from "../dashboards/registry.js";
import { htmlToText } from "../html-to-text.js";

const DEFAULT_INTERVAL_MS = 60_000;

/** Active intervals keyed by dashboard DB row id. */
const timers = new Map<number, NodeJS.Timeout>();

// ── Tick / lifecycle helpers ─────────────────────────────────────

async function tickDashboard(
  row: DashboardRow,
  ctx: ServiceContext,
): Promise<void> {
  const def = dashboardRegistry.get(row.name);
  if (!def) {
    console.warn(`[dashboards] unknown dashboard "${row.name}", cleaning up`);
    stopAndCleanup(row, ctx);
    return;
  }

  try {
    const content = await def.fetch(row.params, ctx, row);
    const res = await ctx.client.callEndpoint(
      `/messages/${row.msg_id}`,
      "PATCH",
      { content },
    );
    // Zulip returns result:"error" with code "BAD_REQUEST" when the message
    // no longer exists (manually deleted). Treat non-success as gone.
    if ((res as { result: string }).result !== "success") {
      console.log(
        `[dashboards] message ${row.msg_id} gone for "${row.name}", cleaning up`,
      );
      stopAndCleanup(row, ctx);
    }
  } catch {
    // Network blip — leave the timer running; next tick will retry.
    console.warn(`[dashboards] tick failed for "${row.name}" (id=${row.id})`);
  }
}

function stopAndCleanup(row: DashboardRow, _ctx: ServiceContext): void {
  const timer = timers.get(row.id);
  if (timer) {
    clearInterval(timer);
    timers.delete(row.id);
  }
  deleteDashboard(row.id);
}

function startTimer(row: DashboardRow, ctx: ServiceContext, immediate = false): void {
  if (timers.has(row.id)) return;
  if (immediate) tickDashboard(row, ctx);
  const interval = setInterval(() => tickDashboard(row, ctx), row.interval_ms);
  timers.set(row.id, interval);
}

// ── Command handlers ─────────────────────────────────────────────

async function handleStart(
  argRaw: string,
  msg: ZulipMessage,
  ctx: ServiceContext,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  const [name, ...rest] = argRaw.split(/\s+/);
  const dashParams = rest.join(" ");

  const def = dashboardRegistry.get(name);
  if (!def) {
    const available = [...dashboardRegistry.keys()].join(", ") || "(none)";
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: `Unknown dashboard \`${name}\`. Available: ${available}`,
    });
    return;
  }

  // Validate params if the dashboard requires them
  if (def.validateParams) {
    const err = def.validateParams(dashParams);
    if (err) {
      await ctx.client.messages.send({
        to: channel,
        type: "stream",
        subject: topic,
        content: err,
      });
      return;
    }
  }

  // Check for duplicate in same channel+topic
  const existing = getDashboardByNameAndLocation(name, channel, topic);
  if (existing) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: `Dashboard \`${name}\` is already running here.`,
    });
    return;
  }

  const intervalMs = def.intervalMs ?? DEFAULT_INTERVAL_MS;

  // 1. Post placeholder message → get msg_id
  const res = await ctx.client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: `Starting dashboard \`${name}\`…`,
  });

  // 2. Create DB row (now we have row.id — needed for feed_items FK)
  const rowId = createDashboard({
    name,
    channel,
    topic,
    msgId: res.id,
    intervalMs,
    params: dashParams,
  });

  const row: DashboardRow = {
    id: rowId,
    name,
    channel,
    topic,
    msg_id: res.id,
    interval_ms: intervalMs,
    params: dashParams,
    bootstrapped: 0,
    created_at: new Date().toISOString(),
  };

  // 3. First tick — fetch may insert feed_items using row.id
  const content = await def.fetch(dashParams, ctx, row);

  // 4. Patch placeholder with real content
  await ctx.client.callEndpoint(`/messages/${res.id}`, "PATCH", { content });

  // Re-read row since fetch may have changed bootstrapped flag
  row.bootstrapped = 1;

  // 5. Start recurring timer
  startTimer(row, ctx);
  console.log(`[dashboards] started "${name}" in #${channel}>${topic}`);
}

async function handleStop(
  name: string | undefined,
  msg: ZulipMessage,
  ctx: ServiceContext,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  let rows: DashboardRow[];
  if (name) {
    const row = getDashboardByNameAndLocation(name, channel, topic);
    rows = row ? [row] : [];
  } else {
    rows = getDashboardsByChannelTopic(channel, topic);
  }

  if (rows.length === 0) {
    const what = name ? `\`${name}\`` : "any dashboards";
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: `No active ${what} found in this topic.`,
    });
    return;
  }

  for (const row of rows) {
    // Try to delete the dashboard message
    await ctx.client
      .callEndpoint(`/messages/${row.msg_id}`, "DELETE")
      .catch(() => {});
    stopAndCleanup(row, ctx);
  }

  const names = rows.map((r) => `\`${r.name}\``).join(", ");
  await ctx.client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: `Stopped dashboard(s): ${names}`,
  });
  console.log(
    `[dashboards] stopped ${rows.length} dashboard(s) in #${channel}>${topic}`,
  );
}

async function handleList(
  msg: ZulipMessage,
  ctx: ServiceContext,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  const rows = getDashboardsByChannelTopic(channel, topic);
  if (rows.length === 0) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: "No active dashboards in this topic.",
    });
    return;
  }

  const lines = rows.map((r) => {
    const def = dashboardRegistry.get(r.name);
    const desc = def?.description ?? "unknown";
    return `- **${r.name}** — ${desc} (every ${r.interval_ms / 1000}s)`;
  });

  await ctx.client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: `**Active dashboards:**\n${lines.join("\n")}`,
  });
}

async function handleRefresh(
  name: string | undefined,
  msg: ZulipMessage,
  ctx: ServiceContext,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  let rows: DashboardRow[];
  if (name) {
    const row = getDashboardByNameAndLocation(name, channel, topic);
    rows = row ? [row] : [];
  } else {
    rows = getDashboardsByChannelTopic(channel, topic);
  }

  if (rows.length === 0) {
    const what = name ? `\`${name}\`` : "any dashboards";
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: `No active ${what} found in this topic.`,
    });
    return;
  }

  for (const row of rows) {
    await tickDashboard(row, ctx);
  }
  console.log(
    `[dashboards] refreshed ${rows.length} dashboard(s) in #${channel}>${topic}`,
  );
}

// ── Service definition ───────────────────────────────────────────

const CMD_RE = /^dashboard\s+(start|stop|list|refresh)(?:\s+(.+))?$/i;

const dashboards: Service = {
  name: "dashboards",
  description: "Pluggable self-updating dashboard messages",
  defaultEnabled: true,
  commands: [
    { usage: "dashboard start <name> [params]", description: "Start a dashboard in this topic" },
    { usage: "dashboard stop [name]", description: "Stop a dashboard (or all in topic)" },
    { usage: "dashboard list", description: "List active dashboards in this topic" },
    { usage: "dashboard refresh [name]", description: "Refresh a dashboard (or all in topic) immediately" },
  ],

  async init(ctx: ServiceContext): Promise<void> {
    const rows = getActiveDashboards();
    for (const row of rows) {
      if (!dashboardRegistry.has(row.name)) {
        console.warn(
          `[dashboards] orphaned dashboard "${row.name}" (id=${row.id}), removing`,
        );
        deleteDashboard(row.id);
        continue;
      }
      startTimer(row, ctx, true);
    }
    if (rows.length > 0) {
      console.log(`  [dashboards] resumed ${timers.size} dashboard(s)`);
    }
  },

  async onReaction(event: ZulipReactionEvent, ctx: ServiceContext): Promise<void> {
    if (event.op !== "add" || event.user_id === ctx.botUserId) return;
    if (event.emoji_name !== "refresh") return;

    const row = getDashboardByMsgId(event.message_id);
    if (!row) return;

    await tickDashboard(row, ctx);
    // Remove the reaction to signal "done"
    await ctx.client.reactions
      .remove({ message_id: event.message_id, emoji_name: "refresh" })
      .catch(() => {});
    console.log(`[dashboards] reaction-refresh "${row.name}" (id=${row.id})`);
  },

  async onMessage(
    msg: ZulipMessage,
    ctx: ServiceContext,
  ): Promise<boolean> {
    const text = htmlToText(msg.content).replace(/@\S+/g, "").trim();
    const match = CMD_RE.exec(text);
    if (!match) return false;

    const sub = match[1].toLowerCase() as "start" | "stop" | "list" | "refresh";
    const argRaw = match[2]?.trim(); // everything after subcommand

    switch (sub) {
      case "start":
        if (!argRaw) {
          await ctx.client.messages.send({
            to: msg.display_recipient,
            type: "stream",
            subject: msg.subject,
            content: "Usage: `dashboard start <name> [params]`",
          });
          return true;
        }
        await handleStart(argRaw, msg, ctx);
        return true;
      case "stop": {
        const stopName = argRaw?.split(/\s+/)[0];
        await handleStop(stopName, msg, ctx);
        return true;
      }
      case "list":
        await handleList(msg, ctx);
        return true;
      case "refresh": {
        const refreshName = argRaw?.split(/\s+/)[0];
        await handleRefresh(refreshName, msg, ctx);
        return true;
      }
    }
  },
};

export default dashboards;
