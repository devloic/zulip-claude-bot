import Database from "better-sqlite3";

export interface TaskRow {
  id: number;
  content: string;
  creator_name: string;
  creator_user_id: number | null;
  status: "open" | "done";
  source_channel: string;
  source_topic: string;
  source_msg_id: number;
  task_channel: string | null;
  task_topic: string | null;
  task_msg_id: number | null;
  own_topic: number; // 0 | 1
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

export interface AssigneeRow {
  id: number;
  task_id: number;
  user_name: string;
  user_id: number | null;
  assigned_at: string;
}

export interface DashboardRow {
  id: number;
  name: string;
  channel: string;
  topic: string;
  msg_id: number;
  interval_ms: number;
  params: string;
  bootstrapped: number;
  created_at: string;
}

let db: Database.Database;

export function initDatabase(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      content         TEXT    NOT NULL,
      creator_name    TEXT    NOT NULL,
      creator_user_id INTEGER,
      status          TEXT    NOT NULL DEFAULT 'open',
      source_channel  TEXT    NOT NULL,
      source_topic    TEXT    NOT NULL,
      source_msg_id   INTEGER NOT NULL UNIQUE,
      task_channel    TEXT,
      task_topic      TEXT,
      task_msg_id     INTEGER,
      own_topic       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT,
      completed_by    TEXT
    );

    CREATE TABLE IF NOT EXISTS task_assignees (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_name   TEXT    NOT NULL,
      user_id     INTEGER,
      assigned_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      channel     TEXT    NOT NULL,
      topic       TEXT    NOT NULL,
      msg_id      INTEGER NOT NULL,
      interval_ms INTEGER NOT NULL DEFAULT 60000,
      params      TEXT    NOT NULL DEFAULT '',
      bootstrapped INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, channel, topic)
    );

    CREATE TABLE IF NOT EXISTS feed_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      item_guid    TEXT    NOT NULL,
      seen_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dashboard_id, item_guid)
    );
  `);

  // ── Idempotent migrations for existing databases ───────────────
  const migrations = [
    "ALTER TABLE dashboards ADD COLUMN params TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE dashboards ADD COLUMN bootstrapped INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

export function createTask(params: {
  content: string;
  creatorName: string;
  creatorUserId?: number;
  sourceChannel: string;
  sourceTopic: string;
  sourceMsgId: number;
  ownTopic: boolean;
}): number {
  const stmt = db.prepare(`
    INSERT INTO tasks (content, creator_name, creator_user_id, source_channel, source_topic, source_msg_id, own_topic)
    VALUES (@content, @creatorName, @creatorUserId, @sourceChannel, @sourceTopic, @sourceMsgId, @ownTopic)
  `);
  const result = stmt.run({
    content: params.content,
    creatorName: params.creatorName,
    creatorUserId: params.creatorUserId ?? null,
    sourceChannel: params.sourceChannel,
    sourceTopic: params.sourceTopic,
    sourceMsgId: params.sourceMsgId,
    ownTopic: params.ownTopic ? 1 : 0,
  });
  return result.lastInsertRowid as number;
}

export function getTaskById(id: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
}

export function getTaskBySourceMsgId(msgId: number): TaskRow | undefined {
  return db
    .prepare("SELECT * FROM tasks WHERE source_msg_id = ?")
    .get(msgId) as TaskRow | undefined;
}

export function getTaskByTaskMsgId(msgId: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE task_msg_id = ?").get(msgId) as
    | TaskRow
    | undefined;
}

export function updateTaskMsgRef(
  taskId: number,
  channel: string,
  topic: string,
  msgId: number,
): void {
  db.prepare(
    "UPDATE tasks SET task_channel = ?, task_topic = ?, task_msg_id = ? WHERE id = ?",
  ).run(channel, topic, msgId, taskId);
}

export function completeTask(taskId: number, completedBy: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'done', completed_at = datetime('now'), completed_by = ? WHERE id = ?",
  ).run(completedBy, taskId);
}

export function reopenTask(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL WHERE id = ?",
  ).run(taskId);
}

export function addAssignees(
  taskId: number,
  users: Array<{ userName: string; userId?: number }>,
): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO task_assignees (task_id, user_name, user_id) VALUES (?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const u of users) {
      stmt.run(taskId, u.userName, u.userId ?? null);
    }
  });
  tx();
}

export function removeAssignees(taskId: number, userIds: number[]): void {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM task_assignees WHERE task_id = ? AND user_id IN (${placeholders})`,
  ).run(taskId, ...userIds);
}

export function getAssignees(taskId: number): AssigneeRow[] {
  return db
    .prepare("SELECT * FROM task_assignees WHERE task_id = ?")
    .all(taskId) as AssigneeRow[];
}

// ── Dashboard CRUD ────────────────────────────────────────────────

export function createDashboard(p: {
  name: string;
  channel: string;
  topic: string;
  msgId: number;
  intervalMs: number;
  params?: string;
}): number {
  const stmt = db.prepare(`
    INSERT INTO dashboards (name, channel, topic, msg_id, interval_ms, params)
    VALUES (@name, @channel, @topic, @msgId, @intervalMs, @params)
  `);
  const result = stmt.run({
    name: p.name,
    channel: p.channel,
    topic: p.topic,
    msgId: p.msgId,
    intervalMs: p.intervalMs,
    params: p.params ?? "",
  });
  return result.lastInsertRowid as number;
}

export function markFeedItemSeen(dashboardId: number, guid: string): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO feed_items (dashboard_id, item_guid) VALUES (?, ?)",
    )
    .run(dashboardId, guid);
  return result.changes > 0;
}

export function setDashboardBootstrapped(id: number): void {
  db.prepare("UPDATE dashboards SET bootstrapped = 1 WHERE id = ?").run(id);
}

export function getActiveDashboards(): DashboardRow[] {
  return db.prepare("SELECT * FROM dashboards ORDER BY created_at").all() as DashboardRow[];
}

export function getDashboardsByChannelTopic(
  channel: string,
  topic: string,
): DashboardRow[] {
  return db
    .prepare("SELECT * FROM dashboards WHERE channel = ? AND topic = ?")
    .all(channel, topic) as DashboardRow[];
}

export function getDashboardByNameAndLocation(
  name: string,
  channel: string,
  topic: string,
): DashboardRow | undefined {
  return db
    .prepare("SELECT * FROM dashboards WHERE name = ? AND channel = ? AND topic = ?")
    .get(name, channel, topic) as DashboardRow | undefined;
}

export function getDashboardByMsgId(msgId: number): DashboardRow | undefined {
  return db
    .prepare("SELECT * FROM dashboards WHERE msg_id = ?")
    .get(msgId) as DashboardRow | undefined;
}

export function deleteDashboard(id: number): void {
  db.prepare("DELETE FROM dashboards WHERE id = ?").run(id);
}

export function getTasksForUser(userName: string): Array<{
  task: TaskRow;
  assignees: AssigneeRow[];
  role: "assigned" | "created";
}> {
  const nameLower = userName.toLowerCase();

  // Tasks where user is assigned
  const assignedTasks = db
    .prepare(
      `SELECT DISTINCT t.* FROM tasks t
       JOIN task_assignees a ON a.task_id = t.id
       WHERE LOWER(a.user_name) = ?
       ORDER BY t.created_at DESC`,
    )
    .all(nameLower) as TaskRow[];

  // Tasks where user is creator (but not already in assigned list)
  const assignedIds = new Set(assignedTasks.map((t) => t.id));
  const createdTasks = (
    db
      .prepare(
        "SELECT * FROM tasks WHERE LOWER(creator_name) = ? ORDER BY created_at DESC",
      )
      .all(nameLower) as TaskRow[]
  ).filter((t) => !assignedIds.has(t.id));

  const results: Array<{
    task: TaskRow;
    assignees: AssigneeRow[];
    role: "assigned" | "created";
  }> = [];

  for (const task of assignedTasks) {
    results.push({
      task,
      assignees: getAssignees(task.id),
      role: "assigned",
    });
  }
  for (const task of createdTasks) {
    results.push({
      task,
      assignees: getAssignees(task.id),
      role: "created",
    });
  }

  return results;
}
