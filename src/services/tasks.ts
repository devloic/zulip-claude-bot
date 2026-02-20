import type { Service, ServiceContext } from "./types.js";
import type { ZulipClient, ZulipMessage, ZulipReactionEvent } from "../zulip.js";
import type { Config } from "../config.js";
import type { TaskRow, AssigneeRow } from "../db.js";
import {
  createTask,
  getTaskBySourceMsgId,
  getTaskByTaskMsgId,
  updateTaskMsgRef,
  completeTask,
  reopenTask,
  addAssignees,
  removeAssignees,
  getAssignees,
  getTasksForUser,
} from "../db.js";
import { htmlToText } from "../html-to-text.js";

interface ZulipStream {
  stream_id: number;
  name: string;
  folder_id?: number | null;
}

// Cache resolved tasks channels to avoid repeated API calls
const tasksChannelCache = new Map<string, string>();

/** Check if a channel name is a tasks channel (exact match or tasks-* prefix). */
function isTasksChannel(channelName: string, config: Config): boolean {
  const prefix = config.tasksChannel.toLowerCase();
  const name = channelName.toLowerCase();
  return name === prefix || name.startsWith(`${prefix}-`);
}

/**
 * Resolve which tasks channel to use for a given source channel.
 *
 * - Source in a folder -> use `tasks` channel in the same folder
 * - Source not in a folder -> use `tasks-{channelname}` channel
 *
 * Creates the channel (and moves it to the folder) if it doesn't exist.
 * Copies subscribers from the source channel.
 */
async function resolveTasksChannel(
  ctx: ServiceContext,
  sourceChannel: string,
): Promise<string> {
  const cached = tasksChannelCache.get(sourceChannel);
  if (cached) return cached;

  const res = await ctx.client.callEndpoint("/streams", "GET");
  const streams = (res.streams as ZulipStream[]) ?? [];

  const source = streams.find(
    (s) => s.name.toLowerCase() === sourceChannel.toLowerCase(),
  );
  const folderId = source?.folder_id ?? null;

  let tasksName: string;

  if (folderId) {
    tasksName = ctx.config.tasksChannel;
  } else {
    const slug = sourceChannel.toLowerCase().replace(/\s+/g, "-");
    tasksName = `${ctx.config.tasksChannel}-${slug}`;
  }

  const existing = streams.find(
    (s) => s.name.toLowerCase() === tasksName.toLowerCase(),
  );

  if (!existing) {
    let subscriberEmails: string[] = [];
    if (source) {
      const membersRes = await ctx.client.callEndpoint(
        `/streams/${source.stream_id}/members`,
        "GET",
      );
      const memberIds = (membersRes.subscribers as number[]) ?? [];
      if (memberIds.length > 0) {
        const usersRes = await ctx.client.callEndpoint("/users", "GET");
        const users = (usersRes.members as Array<{ user_id: number; email: string }>) ?? [];
        const idToEmail = new Map(users.map((u) => [u.user_id, u.email]));
        subscriberEmails = memberIds
          .map((id) => idToEmail.get(id))
          .filter((e): e is string => !!e);
      }
    }

    const createRes = await ctx.client.callEndpoint(
      "/users/me/subscriptions",
      "POST",
      {
        subscriptions: JSON.stringify([
          {
            name: tasksName,
            description: `Tasks promoted from channels${folderId ? " in this folder" : ""}`,
          },
        ]),
        ...(subscriberEmails.length > 0 && {
          principals: JSON.stringify(subscriberEmails),
        }),
      },
    );

    const subResult = createRes as {
      subscribed?: Record<string, string[]>;
      already_subscribed?: Record<string, string[]>;
    };
    const wasCreated = Object.values(subResult.subscribed ?? {}).some((names) =>
      names.some((n) => n.toLowerCase() === tasksName.toLowerCase()),
    );
    if (!wasCreated) {
      console.error(
        `  [tasks] failed to create #${tasksName}:`,
        JSON.stringify(createRes),
      );
      tasksChannelCache.set(sourceChannel, sourceChannel);
      return sourceChannel;
    }

    console.log(
      `  [tasks] created #${tasksName} with ${subscriberEmails.length} subscribers`,
    );

    if (folderId) {
      const updated = await ctx.client.callEndpoint("/streams", "GET");
      const newStream = ((updated.streams as ZulipStream[]) ?? []).find(
        (s) => s.name.toLowerCase() === tasksName.toLowerCase(),
      );
      if (newStream) {
        await ctx.client
          .callEndpoint(`/streams/${newStream.stream_id}`, "PATCH", {
            folder_id: folderId,
          })
          .catch((err) =>
            console.error(
              `  [tasks] failed to move #${tasksName} to folder:`,
              err,
            ),
          );
        console.log(`  [tasks] moved #${tasksName} to folder ${folderId}`);
      }
    }
  } else if (folderId && existing.folder_id !== folderId) {
    await ctx.client
      .callEndpoint(`/streams/${existing.stream_id}`, "PATCH", {
        folder_id: folderId,
      })
      .catch(() => {});
  }

  tasksChannelCache.set(sourceChannel, tasksName);
  return tasksName;
}

// ── Rendering ────────────────────────────────────────────────────

function renderTaskCard(
  task: TaskRow,
  assignees: AssigneeRow[],
  config: Config,
): string {
  const msgLink = `${config.zulipRealm}/#narrow/channel/${encodeURIComponent(task.source_channel)}/topic/${encodeURIComponent(task.source_topic)}/near/${task.source_msg_id}`;

  const statusEmoji = task.status === "done" ? "\u2705" : "\ud83d\udccb";
  const statusText =
    task.status === "done"
      ? `Done${task.completed_by ? ` by ${task.completed_by}` : ""}`
      : "Open \u2014 react with :check: when done";

  const lines = [
    `${statusEmoji} **Task** \u2014 [source message](${msgLink})`,
    "",
    quote(task.content),
    "",
  ];

  if (assignees.length > 0) {
    const mentions = assignees.map((a) =>
      a.user_id ? `@_**${a.user_name}|${a.user_id}**` : a.user_name,
    );
    lines.push(`**Assigned to**: ${mentions.join(", ")}`);
  }
  lines.push(`**Created by**: ${task.creator_name}`);
  lines.push(`**Status**: ${statusText}`);

  return lines.join("\n");
}

/** Re-render and PATCH the Zulip task message from DB state. */
async function syncTaskMessage(
  client: ZulipClient,
  task: TaskRow,
  assignees: AssigneeRow[],
  config: Config,
): Promise<void> {
  if (!task.task_msg_id) return;
  const content = renderTaskCard(task, assignees, config);
  await client
    .callEndpoint(`/messages/${task.task_msg_id}`, "PATCH", { content })
    .catch((err) =>
      console.error(`  [tasks] failed to sync task msg ${task.task_msg_id}:`, err),
    );
}

// ── Mention parsing helpers ──────────────────────────────────────

interface ParsedMention {
  userId: number;
  userName: string;
}

function parseMentions(html: string, botUserId: number): ParsedMention[] {
  const mentionRegex = /data-user-id="(\d+)"[^>]*>@([^<]+)</g;
  const mentions: ParsedMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(html)) !== null) {
    const userId = Number(match[1]);
    if (userId === botUserId) continue;
    mentions.push({ userId, userName: match[2] });
  }
  return mentions;
}

/**
 * Extract the quoted message ID from a Zulip quote-reply.
 * Zulip quote HTML contains: <a href=".../#narrow/.../near/MESSAGE_ID">said</a>
 */
function extractQuotedMessageId(html: string): number | null {
  const match = html.match(/href="[^"]*\/near\/(\d+)"/);
  return match ? Number(match[1]) : null;
}

// ── Command handlers ─────────────────────────────────────────────

async function handleTaskCreation(
  msg: ZulipMessage,
  ctx: ServiceContext,
  mentions: ParsedMention[],
  ownTopic: boolean,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  // Fetch the message preceding the command
  const response = await ctx.client.messages.retrieve({
    narrow: [
      { operator: "channel", operand: channel },
      { operator: "topic", operand: topic },
    ],
    anchor: String(msg.id),
    num_before: 1,
    num_after: 0,
  });

  const preceding = response.messages.filter((m) => m.id !== msg.id);
  if (preceding.length === 0) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: "There's no message above to promote into a task.",
    });
    return;
  }

  const targetMsg = preceding[preceding.length - 1];

  // Check for duplicate
  if (getTaskBySourceMsgId(targetMsg.id)) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: "A task already exists for that message.",
    });
    return;
  }

  const content = htmlToText(targetMsg.content);
  const tasksChannel = isTasksChannel(channel, ctx.config)
    ? channel
    : await resolveTasksChannel(ctx, channel);

  // Insert into DB
  const taskId = createTask({
    content,
    creatorName: msg.sender_full_name,
    sourceChannel: channel,
    sourceTopic: topic,
    sourceMsgId: targetMsg.id,
    ownTopic,
  });

  // Add assignees
  if (mentions.length > 0) {
    addAssignees(
      taskId,
      mentions.map((m) => ({ userName: m.userName, userId: m.userId })),
    );
  }

  // Post to Zulip
  const assigneeRows = getAssignees(taskId);
  const task = { ...getTaskBySourceMsgId(targetMsg.id)!, id: taskId };
  const inTasksChannel = isTasksChannel(channel, ctx.config);
  const taskTopic = ownTopic
    ? truncate(content, 50)
    : inTasksChannel
      ? topic
      : `${channel} / ${topic}`;

  const cardContent = renderTaskCard(
    { ...task, task_channel: tasksChannel, task_topic: taskTopic },
    assigneeRows,
    ctx.config,
  );

  const sendRes = await ctx.client.messages.send({
    to: tasksChannel,
    type: "stream",
    subject: taskTopic,
    content: cardContent,
  });

  // Store message reference
  updateTaskMsgRef(taskId, tasksChannel, taskTopic, sendRes.id);

  // React on source message
  await ctx.client.reactions
    .add({ message_id: targetMsg.id, emoji_name: ctx.config.taskEmoji })
    .catch(() => {});

  // Confirmation in source channel
  const assigneeMentions = mentions.map(
    (m) => `@_**${m.userName}|${m.userId}**`,
  );
  const parts = [`Task created by ${msg.sender_full_name}`];
  if (assigneeMentions.length) {
    parts.push(`assigned to ${assigneeMentions.join(", ")}`);
  }
  await ctx.client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: `${parts.join(", ")} in #**${tasksChannel}>${taskTopic}**`,
  });
}

async function handleAssign(
  msg: ZulipMessage,
  ctx: ServiceContext,
  removing: boolean,
): Promise<void> {
  const channel = msg.display_recipient;
  const topic = msg.subject;

  const mentions = parseMentions(msg.content, ctx.botUserId);
  if (mentions.length === 0) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: `Usage: quote-reply to a task and type \`@bot ${removing ? "unassign" : "assign"} @user\``,
    });
    return;
  }

  const quotedId = extractQuotedMessageId(msg.content);
  if (!quotedId) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content:
        "Please quote-reply to the specific task message you want to update.",
    });
    return;
  }

  const task = getTaskByTaskMsgId(quotedId);
  if (!task) {
    await ctx.client.messages.send({
      to: channel,
      type: "stream",
      subject: topic,
      content: "The quoted message is not a tracked task.",
    });
    return;
  }

  if (removing) {
    removeAssignees(
      task.id,
      mentions.map((m) => m.userId),
    );
  } else {
    addAssignees(
      task.id,
      mentions.map((m) => ({ userName: m.userName, userId: m.userId })),
    );
  }

  // Sync the Zulip message
  const updatedAssignees = getAssignees(task.id);
  await syncTaskMessage(ctx.client, task, updatedAssignees, ctx.config);

  const verb = removing ? "unassigned" : "assigned";
  const names = mentions.map((m) => m.userName).join(", ");
  await ctx.client.messages.send({
    to: channel,
    type: "stream",
    subject: topic,
    content: `${names} ${verb} ${removing ? "from" : "to"} this task.`,
  });
}

async function handleMyTasks(
  msg: ZulipMessage,
  ctx: ServiceContext,
  userName: string,
): Promise<void> {
  const results = getTasksForUser(userName);

  if (results.length === 0) {
    await ctx.client.messages.send({
      to: msg.display_recipient,
      type: "stream",
      subject: msg.subject,
      content: `No tasks found for ${userName}.`,
    });
    return;
  }

  const assigned = results.filter((r) => r.role === "assigned");
  const created = results.filter((r) => r.role === "created");
  const lines: string[] = [];

  if (assigned.length > 0) {
    lines.push(`**Tasks assigned to ${userName}** (${assigned.length}):\n`);
    for (const r of assigned) {
      lines.push(formatTaskLine(r.task, ctx));
    }
  }

  if (created.length > 0) {
    lines.push(`**Tasks created by ${userName}** (${created.length}):\n`);
    for (const r of created) {
      lines.push(formatTaskLine(r.task, ctx));
    }
  }

  await ctx.client.messages.send({
    to: msg.display_recipient,
    type: "stream",
    subject: msg.subject,
    content: lines.join("\n"),
  });
}

function formatTaskLine(task: TaskRow, ctx: ServiceContext): string {
  const preview = truncate(task.content, 80);
  const statusEmoji = task.status === "done" ? "\u2705" : "\ud83d\udccb";

  if (task.task_channel && task.task_topic && task.task_msg_id) {
    const link = `${ctx.config.zulipRealm}/#narrow/channel/${encodeURIComponent(task.task_channel)}/topic/${encodeURIComponent(task.task_topic)}/near/${task.task_msg_id}`;
    return `${statusEmoji} [${preview}](${link})\n   #**${task.task_channel}>${task.task_topic}**\n`;
  }

  return `${statusEmoji} ${preview}\n`;
}

// ── Service definition ───────────────────────────────────────────

const tasks: Service = {
  name: "tasks",
  description:
    "Promote messages into tasks via @bot task or :clipboard: reaction (SQLite-backed)",
  defaultEnabled: true,
  commands: [
    { usage: "task", description: "Promote the message above into a task" },
    { usage: "task --own-topic", description: "Promote into a task with its own topic" },
    { usage: "assign @user", description: "Assign a user to a task (quote-reply to task)" },
    { usage: "unassign @user", description: "Remove a user from a task (quote-reply to task)" },
    { usage: "my tasks", description: "List tasks assigned to or created by you" },
    { usage: "tasks @user", description: "List tasks for a specific user" },
  ],


  async onMessage(
    msg: ZulipMessage,
    ctx: ServiceContext,
  ): Promise<boolean> {
    const text = htmlToText(msg.content);
    const stripped = text.replace(/@\S+/g, "").trim();

    // "my tasks"
    if (stripped.match(/^my\s+tasks?\s*$/i)) {
      await handleMyTasks(msg, ctx, msg.sender_full_name);
      return true;
    }

    // "tasks @user"
    if (stripped.match(/^tasks\s*$/i)) {
      const mentions = parseMentions(msg.content, ctx.botUserId);
      if (mentions.length > 0) {
        await handleMyTasks(msg, ctx, mentions[0].userName);
        return true;
      }
    }

    // "assign" / "unassign"
    const assignMatch = stripped.match(/^(un)?assign\s*$/i);
    if (assignMatch) {
      await handleAssign(msg, ctx, !!assignMatch[1]);
      return true;
    }

    // "task" creation
    if (!stripped.match(/^task\b/i)) return false;

    const ownTopic = /--own-topic/i.test(text);
    const mentions = parseMentions(msg.content, ctx.botUserId);
    await handleTaskCreation(msg, ctx, mentions, ownTopic);
    return true;
  },

  async onReaction(
    event: ZulipReactionEvent,
    ctx: ServiceContext,
  ): Promise<void> {
    if (event.user_id === ctx.botUserId) return;

    // ── :check: reaction → complete/reopen task ──────────────────
    if (event.emoji_name === "check") {
      const task = getTaskByTaskMsgId(event.message_id);
      if (!task) return;

      // Look up reactor name
      const userRes = await ctx.client.callEndpoint(
        `/users/${event.user_id}`,
        "GET",
      );
      const user = userRes.user as
        | { full_name: string; user_id: number }
        | undefined;
      const reactorName = user?.full_name ?? "Unknown";

      if (event.op === "add") {
        completeTask(task.id, reactorName);
      } else {
        reopenTask(task.id);
      }

      const updatedTask = { ...task, status: (event.op === "add" ? "done" : "open") as "done" | "open", completed_by: event.op === "add" ? reactorName : null, completed_at: event.op === "add" ? new Date().toISOString() : null };
      const assignees = getAssignees(task.id);
      await syncTaskMessage(ctx.client, updatedTask, assignees, ctx.config);
      return;
    }

    // ── :clipboard: reaction → create task ───────────────────────
    if (event.op !== "add") return;
    if (event.emoji_name !== ctx.config.taskEmoji) return;

    const res = await ctx.client.callEndpoint(
      `/messages/${event.message_id}`,
      "GET",
    );
    const msg = res.message as ZulipMessage | undefined;
    if (!msg || msg.type !== "stream") return;

    // Duplicate check
    if (getTaskBySourceMsgId(msg.id)) return;

    const userRes = await ctx.client.callEndpoint(
      `/users/${event.user_id}`,
      "GET",
    );
    const user = userRes.user as
      | { full_name: string; user_id: number }
      | undefined;
    const reactorName = user?.full_name ?? "Unknown";

    const content = htmlToText(msg.content);
    const inTasksChannel = isTasksChannel(msg.display_recipient, ctx.config);
    const tasksChannel = inTasksChannel
      ? msg.display_recipient
      : await resolveTasksChannel(ctx, msg.display_recipient);

    const taskId = createTask({
      content,
      creatorName: reactorName,
      sourceChannel: msg.display_recipient,
      sourceTopic: msg.subject,
      sourceMsgId: msg.id,
      ownTopic: false,
    });

    addAssignees(taskId, [
      { userName: reactorName, userId: event.user_id },
    ]);

    const assignees = getAssignees(taskId);
    const taskTopic = inTasksChannel
      ? msg.subject
      : `${msg.display_recipient} / ${msg.subject}`;
    const task = getTaskBySourceMsgId(msg.id)!;

    const cardContent = renderTaskCard(
      { ...task, task_channel: tasksChannel, task_topic: taskTopic },
      assignees,
      ctx.config,
    );

    const sendRes = await ctx.client.messages.send({
      to: tasksChannel,
      type: "stream",
      subject: taskTopic,
      content: cardContent,
    });

    updateTaskMsgRef(taskId, tasksChannel, taskTopic, sendRes.id);

    const reactorMention = `@_**${reactorName}|${event.user_id}**`;
    await ctx.client.messages.send({
      to: msg.display_recipient,
      type: "stream",
      subject: msg.subject,
      content: `Task created by ${reactorName}, assigned to ${reactorMention} in #**${tasksChannel}>${taskTopic}**`,
    });
  },
};

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + "\u2026";
}

export default tasks;
