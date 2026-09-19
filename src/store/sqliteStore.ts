import {
  chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";
import type {
  ClaudeSessionFlags, ClaudeThreadRecord, GoalPatch, GoalUsageInput, HybridStore, InternalGoal,
  PendingThreadRemoval,
} from "./HybridStore.js";
import { settingsGeneration, withSettingsFrom } from "./HybridStore.js";
import { filterSortThreads } from "./threadFilter.js";
import { withoutAppContext } from "../protocol/appContext.js";

interface ThreadRow {
  thread_json: string;
  claude_session_id: string;
  model_picker_id: string;
  claude_model_value: string;
  service_tier: string | null;
  approval_policy_json: string;
  sandbox_policy_json: string;
  base_instructions: string | null;
  developer_instructions: string | null;
  personality: string | null;
  resolved_model: string | null;
  last_claude_message_uuid: string | null;
  last_completed_turn_id: string | null;
  claude_code_version: string | null;
  runtime_settings_json: string | null;
}

interface TurnRow {
  turn_json: string;
  last_claude_message_uuid?: string | null;
}


function json(value: unknown): string {
  return JSON.stringify(value);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function openChecked(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    const rows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") throw new Error(rows.map((row) => row.quick_check).join("; "));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function recoverableDatabase(path: string): DatabaseSync {
  if (!existsSync(path)) return openChecked(path);
  try {
    return openChecked(path);
  } catch (error) {
    const backup = `${path}.bak`;
    if (!existsSync(backup)) throw new Error(`SQLite integrity check failed and no backup exists: ${String(error)}`);
    const suffix = `.corrupt-${Date.now()}`;
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) renameSync(candidate, `${candidate}${suffix}`);
    }
    copyFileSync(backup, path);
    return openChecked(path);
  }
}

function parseRecord(row: ThreadRow, turns: Turn[]): ClaudeThreadRecord {
  const thread = JSON.parse(row.thread_json) as Thread;
  const runtime = row.runtime_settings_json ? JSON.parse(row.runtime_settings_json) as Record<string, unknown> : {};
  const usage = (value: unknown): ClaudeThreadRecord["tokenUsageTotal"] => {
    const stored = value && typeof value === "object" ? value as Partial<ClaudeThreadRecord["tokenUsageTotal"]> : {};
    return {
      totalTokens: stored.totalTokens ?? 0,
      inputTokens: stored.inputTokens ?? 0,
      cachedInputTokens: stored.cachedInputTokens ?? 0,
      cacheWriteInputTokens: stored.cacheWriteInputTokens ?? 0,
      outputTokens: stored.outputTokens ?? 0,
      reasoningOutputTokens: stored.reasoningOutputTokens ?? 0,
    };
  };
  return {
    thread: {
      ...thread,
      section: thread.section ?? null,
      sectionEnteredAt: thread.sectionEnteredAt ?? null,
      projectId: thread.projectId ?? null,
      canAcceptDirectInput: thread.parentThreadId ? false : true,
      turns,
    },
    runtimeWorkspaceRoots: Array.isArray(runtime.runtimeWorkspaceRoots)
      ? runtime.runtimeWorkspaceRoots as string[]
      : [thread.cwd],
    claudeSessionId: row.claude_session_id,
    modelPickerId: row.model_picker_id,
    claudeModelValue: row.claude_model_value,
    serviceTier: row.service_tier,
    approvalPolicy: JSON.parse(row.approval_policy_json) as unknown,
    approvalsReviewer: (["user", "auto_review", "guardian_subagent"] as const).includes(
      runtime.approvalsReviewer as ApprovalsReviewer,
    ) ? runtime.approvalsReviewer as ApprovalsReviewer : "user",
    sandboxPolicy: JSON.parse(row.sandbox_policy_json) as unknown,
    baseInstructions: row.base_instructions,
    developerInstructions: row.developer_instructions,
    personality: row.personality,
    resolvedModel: row.resolved_model,
    lastClaudeMessageUuid: row.last_claude_message_uuid,
    lastCompletedTurnId: row.last_completed_turn_id,
    claudeCodeVersion: row.claude_code_version,
    reasoningEffort: typeof runtime.reasoningEffort === "string" ? runtime.reasoningEffort : null,
    reasoningSummary: typeof runtime.reasoningSummary === "string" ? runtime.reasoningSummary : null,
    collaborationMode: runtime.collaborationMode ?? null,
    outputSchema: runtime.outputSchema ?? null,
    tokenUsageTotal: usage(runtime.tokenUsageTotal),
    tokenUsageLast: runtime.tokenUsageLast && typeof runtime.tokenUsageLast === "object"
      ? usage(runtime.tokenUsageLast)
      : null,
    modelContextWindow: typeof runtime.modelContextWindow === "number" ? runtime.modelContextWindow : null,
    providerCostUsdTotal: typeof runtime.providerCostUsdTotal === "number" ? runtime.providerCostUsdTotal : 0,
    settingsGeneration: typeof runtime.settingsGeneration === "number" ? runtime.settingsGeneration : 0,
  };
}

export class SqliteHybridStore implements HybridStore {
  private readonly database: DatabaseSync;
  private readonly path: string;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    const existed = existsSync(path);
    this.database = recoverableDatabase(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if (existed) this.backup();
    this.migrate();
    chmodSync(path, 0o600);
  }

  public createThread(record: ClaudeThreadRecord): void {
    this.database.prepare(`
      INSERT INTO threads (
        id, session_id, claude_session_id, model_picker_id, claude_model_value,
        service_tier, cwd, archived, ephemeral, created_at, updated_at,
        thread_json, approval_policy_json, sandbox_policy_json,
        base_instructions, developer_instructions, personality, resolved_model,
        last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.thread.id,
      record.thread.sessionId,
      record.claudeSessionId,
      record.modelPickerId,
      record.claudeModelValue,
      record.serviceTier,
      record.thread.cwd,
      0,
      record.thread.ephemeral ? 1 : 0,
      record.thread.createdAt,
      record.thread.updatedAt,
      json({ ...record.thread, turns: [] }),
      json(record.approvalPolicy),
      json(record.sandboxPolicy),
      record.baseInstructions,
      record.developerInstructions,
      record.personality,
      record.resolvedModel,
      record.lastClaudeMessageUuid,
      record.lastCompletedTurnId,
      record.claudeCodeVersion,
      json({
        runtimeWorkspaceRoots: record.runtimeWorkspaceRoots ?? [record.thread.cwd],
        approvalsReviewer: record.approvalsReviewer,
        reasoningEffort: record.reasoningEffort,
        reasoningSummary: record.reasoningSummary,
        collaborationMode: record.collaborationMode,
        outputSchema: record.outputSchema,
        tokenUsageTotal: record.tokenUsageTotal,
        tokenUsageLast: record.tokenUsageLast,
        modelContextWindow: record.modelContextWindow,
        providerCostUsdTotal: record.providerCostUsdTotal ?? 0,
        settingsGeneration: settingsGeneration(record),
      }),
    );
  }

  public hasThread(threadId: string): boolean {
    return this.database.prepare("SELECT 1 AS found FROM threads WHERE id = ?").get(threadId) !== undefined;
  }

  public getThreadRecord(threadId: string, includeTurns = false): ClaudeThreadRecord | undefined {
    const row = this.database.prepare(`
      SELECT thread_json, claude_session_id, model_picker_id, claude_model_value,
             service_tier, approval_policy_json, sandbox_policy_json,
             base_instructions, developer_instructions, personality, resolved_model,
             last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      FROM threads WHERE id = ?
    `).get(threadId) as unknown as ThreadRow | undefined;
    if (!row) return undefined;
    return parseRecord(row, includeTurns ? this.listTurns(threadId) : []);
  }

  public allThreadRecords(): ClaudeThreadRecord[] {
    const rows = this.database.prepare(`
      SELECT thread_json, claude_session_id, model_picker_id, claude_model_value,
             service_tier, approval_policy_json, sandbox_policy_json,
             base_instructions, developer_instructions, personality, resolved_model,
             last_claude_message_uuid, last_completed_turn_id, claude_code_version, runtime_settings_json
      FROM threads ORDER BY created_at ASC
    `).all() as unknown as ThreadRow[];
    return rows.map((row) => {
      const thread = JSON.parse(row.thread_json) as Thread;
      return parseRecord(row, this.listTurns(thread.id));
    });
  }

  public listThreads(params: ThreadListParams): Thread[] {
    const archived = params.archived === true ? 1 : 0;
    const rows = this.database.prepare("SELECT thread_json FROM threads WHERE archived = ?").all(archived) as unknown as Array<{ thread_json: string }>;
    return filterSortThreads(rows.map((row) => JSON.parse(row.thread_json) as Thread), params);
  }

  public sessionFlags(): ReadonlyMap<string, ClaudeSessionFlags> {
    const rows = this.database.prepare(`
      SELECT session_id, thread_id, archived, ephemeral, section_json, section_entered_at
      FROM claude_session_flags
    `).all() as unknown as Array<{
      session_id: string;
      thread_id: string;
      archived: number;
      ephemeral: number;
      section_json: string | null;
      section_entered_at: number | null;
    }>;
    return new Map(rows.map((row) => [row.session_id, {
      sessionId: row.session_id,
      threadId: row.thread_id,
      archived: row.archived === 1,
      ephemeral: row.ephemeral === 1,
      section: row.section_json === null ? null : JSON.parse(row.section_json),
      sectionEnteredAt: row.section_entered_at,
    }]));
  }

  public setSessionFlags(flags: ClaudeSessionFlags): void {
    if (flags.threadId === flags.sessionId && !flags.archived && !flags.ephemeral
      && flags.section === null && flags.sectionEnteredAt === null) {
      this.database.prepare("DELETE FROM claude_session_flags WHERE session_id = ?").run(flags.sessionId);
      return;
    }
    this.database.prepare(`
      INSERT INTO claude_session_flags (
        session_id, thread_id, archived, ephemeral, section_json, section_entered_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        archived = excluded.archived,
        ephemeral = excluded.ephemeral,
        section_json = excluded.section_json,
        section_entered_at = excluded.section_entered_at
    `).run(
      flags.sessionId,
      flags.threadId,
      flags.archived ? 1 : 0,
      flags.ephemeral ? 1 : 0,
      flags.section === null ? null : json(flags.section),
      flags.sectionEnteredAt,
    );
  }

  public adoptTransient(_record: ClaudeThreadRecord): void {
    throw new Error("SqliteHybridStore cannot adopt transient Claude sessions");
  }

  public updateThread(record: ClaudeThreadRecord): void {
    const current = this.getThreadRecord(record.thread.id, false);
    const merged = current && settingsGeneration(current) > settingsGeneration(record)
      ? withSettingsFrom(record, current)
      : record;
    const persistedThread = {
      ...merged.thread,
      status: current?.thread.status ?? merged.thread.status,
      preview: current?.thread.preview ?? merged.thread.preview,
      recencyAt: current?.thread.recencyAt ?? merged.thread.recencyAt,
      cliVersion: current?.thread.cliVersion ?? merged.thread.cliVersion,
      turns: [],
    };
    this.database.prepare(`
      UPDATE threads SET
        claude_session_id = ?, model_picker_id = ?, claude_model_value = ?,
        service_tier = ?, cwd = ?, updated_at = ?, thread_json = ?,
        approval_policy_json = ?, sandbox_policy_json = ?, base_instructions = ?,
        developer_instructions = ?, personality = ?, runtime_settings_json = ?
      WHERE id = ?
    `).run(
      merged.claudeSessionId,
      merged.modelPickerId,
      merged.claudeModelValue,
      merged.serviceTier,
      merged.thread.cwd,
      merged.thread.updatedAt,
      json(persistedThread),
      json(merged.approvalPolicy),
      json(merged.sandboxPolicy),
      merged.baseInstructions,
      merged.developerInstructions,
      merged.personality,
      json({
        runtimeWorkspaceRoots: merged.runtimeWorkspaceRoots ?? [merged.thread.cwd],
        approvalsReviewer: merged.approvalsReviewer,
        reasoningEffort: merged.reasoningEffort,
        reasoningSummary: merged.reasoningSummary,
        collaborationMode: merged.collaborationMode,
        outputSchema: merged.outputSchema,
        tokenUsageTotal: current?.tokenUsageTotal ?? merged.tokenUsageTotal,
        tokenUsageLast: current?.tokenUsageLast ?? merged.tokenUsageLast,
        modelContextWindow: current?.modelContextWindow ?? merged.modelContextWindow,
        providerCostUsdTotal: current?.providerCostUsdTotal ?? merged.providerCostUsdTotal ?? 0,
        settingsGeneration: settingsGeneration(merged),
      }),
      merged.thread.id,
    );
  }

  public isThreadArchived(threadId: string): boolean {
    const row = this.database.prepare("SELECT archived FROM threads WHERE id = ?").get(threadId) as unknown as {
      archived: number;
    } | undefined;
    return row?.archived === 1;
  }

  public setThreadArchived(threadId: string, archived: boolean): void {
    this.database.prepare("UPDATE threads SET archived = ? WHERE id = ?").run(archived ? 1 : 0, threadId);
  }

  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    this.transaction(() => {
      for (const threadId of threadIds) this.setThreadArchived(threadId, archived);
    });
  }

  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.database.prepare(`
      INSERT INTO pending_thread_removals (root_thread_id, claude_session_id, cwd, kind)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(root_thread_id) DO UPDATE SET
        claude_session_id = excluded.claude_session_id,
        cwd = excluded.cwd,
        kind = excluded.kind
    `).run(removal.rootThreadId, removal.claudeSessionId, removal.cwd, removal.kind);
  }

  public cancelThreadRemoval(rootThreadId: string): void {
    this.database.prepare("DELETE FROM pending_thread_removals WHERE root_thread_id = ?").run(rootThreadId);
  }

  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return (this.database.prepare(`
      SELECT root_thread_id, claude_session_id, cwd, kind
      FROM pending_thread_removals ORDER BY root_thread_id
    `).all() as unknown as Array<{
      root_thread_id: string;
      claude_session_id: string;
      cwd: string;
      kind: PendingThreadRemoval["kind"];
    }>).map((row) => ({
      rootThreadId: row.root_thread_id,
      claudeSessionId: row.claude_session_id,
      cwd: row.cwd,
      kind: row.kind,
    }));
  }

  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    this.transaction(() => {
      for (const threadId of [...threadIds].reverse()) this.deleteThreadRows(threadId);
      this.database.prepare("DELETE FROM pending_thread_removals WHERE root_thread_id = ?").run(rootThreadId);
    });
  }

  public deleteThread(threadId: string): void {
    this.transaction(() => this.deleteThreadRows(threadId));
  }

  public getTurn(threadId: string, turnId: string): Turn | undefined {
    const row = this.database.prepare("SELECT turn_json FROM turns WHERE id = ? AND thread_id = ?")
      .get(turnId, threadId) as unknown as TurnRow | undefined;
    return row ? JSON.parse(row.turn_json) as Turn : undefined;
  }

  public listTurns(threadId: string): Turn[] {
    const rows = this.database.prepare("SELECT turn_json FROM turns WHERE thread_id = ? ORDER BY ordinal ASC")
      .all(threadId) as unknown as TurnRow[];
    return rows.map((row) => JSON.parse(row.turn_json) as Turn);
  }

  public commitForkedThread(
    record: ClaudeThreadRecord,
    inheritedGoal?: InternalGoal,
  ): void {
    this.transaction(() => {
      this.createThread(record);
      if (inheritedGoal) {
        this.database.prepare("INSERT INTO goals (thread_id, goal_json) VALUES (?, ?)")
          .run(record.thread.id, json(inheritedGoal));
      }
    });
  }

  public getGoal(threadId: string): InternalGoal | undefined {
    const row = this.database.prepare("SELECT goal_json FROM goals WHERE thread_id = ?").get(threadId) as unknown as { goal_json: string } | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(row.goal_json) as InternalGoal;
    if (stored.goalId) return stored;
    const migrated = { ...stored, goalId: uuidv7() };
    this.database.prepare("UPDATE goals SET goal_json = ? WHERE thread_id = ?").run(json(migrated), threadId);
    return migrated;
  }

  public setGoal(threadId: string, patch: GoalPatch): InternalGoal {
    return this.transaction(() => {
      const previous = this.getGoal(threadId);
      const now = patch.now ?? Math.floor(Date.now() / 1_000);
      const replace = patch.replace === true || !previous;
      if (replace && patch.objective === undefined) throw new Error(`cannot create goal for thread ${threadId} without an objective`);
      const goal: InternalGoal = {
        threadId,
        goalId: replace ? uuidv7() : previous.goalId,
        objective: patch.objective ?? previous?.objective ?? "",
        status: patch.status ?? (replace ? "active" : previous.status),
        tokenBudget: patch.tokenBudget === undefined ? (replace ? null : previous.tokenBudget) : patch.tokenBudget,
        tokensUsed: replace ? 0 : previous.tokensUsed,
        timeUsedSeconds: replace ? 0 : previous.timeUsedSeconds,
        createdAt: replace ? now : previous.createdAt,
        updatedAt: now,
        ...(patch.continuationDeferred !== undefined
          ? { continuationDeferred: patch.continuationDeferred }
          : previous?.continuationDeferred !== undefined
            ? { continuationDeferred: previous.continuationDeferred }
            : {}),
      };
      if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
      this.database.prepare(`
        INSERT INTO goals (thread_id, goal_json) VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET goal_json = excluded.goal_json
      `).run(threadId, json(goal));
      return goal;
    });
  }

  public clearGoal(threadId: string): boolean {
    return Number(this.database.prepare("DELETE FROM goals WHERE thread_id = ?").run(threadId).changes) > 0;
  }

  public sectionOrders(): Map<string, string[]> {
    const rows = this.database.prepare("SELECT section_id, order_json FROM section_orders").all() as unknown as
      Array<{ section_id: string; order_json: string }>;
    return new Map(rows.map((row) => [row.section_id, JSON.parse(row.order_json) as string[]]));
  }

  public setSectionOrder(sectionId: string, threadIds: readonly string[]): void {
    if (threadIds.length === 0) {
      this.database.prepare("DELETE FROM section_orders WHERE section_id = ?").run(sectionId);
      return;
    }
    this.database.prepare(`
      INSERT INTO section_orders (section_id, order_json) VALUES (?, ?)
      ON CONFLICT(section_id) DO UPDATE SET order_json = excluded.order_json
    `).run(sectionId, json(threadIds));
  }

  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined {
    return this.transaction(() => {
      if (input.checkpointKey) {
        const inserted = this.database.prepare(`
          INSERT OR IGNORE INTO goal_checkpoints (thread_id, goal_id, checkpoint_key)
          VALUES (?, ?, ?)
        `).run(input.threadId, input.expectedGoalId, input.checkpointKey);
        if (Number(inserted.changes) === 0) return this.getGoal(input.threadId);
      }
      const previous = this.getGoal(input.threadId);
      if (!previous || previous.goalId !== input.expectedGoalId) return previous;
      if (previous.status !== "active" && previous.status !== "budgetLimited") return previous;
      const goal: InternalGoal = {
        ...previous,
        tokensUsed: previous.tokensUsed + Math.max(0, input.tokenDelta),
        timeUsedSeconds: previous.timeUsedSeconds + Math.max(0, input.timeDeltaSeconds),
        updatedAt: Math.floor(Date.now() / 1_000),
      };
      if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
      this.database.prepare("UPDATE goals SET goal_json = ? WHERE thread_id = ?").run(json(goal), input.threadId);
      return goal;
    });
  }

  public close(): void {
    try {
      this.backup();
    } finally {
      this.database.close();
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteThreadRows(threadId: string): void {
    this.database.prepare("DELETE FROM goals WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM turns WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  private backup(): void {
    const backup = `${this.path}.bak`;
    if (existsSync(backup)) unlinkSync(backup);
    this.database.exec(`VACUUM INTO ${sqlString(backup)}`);
    chmodSync(backup, 0o600);
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        model_picker_id TEXT NOT NULL,
        claude_model_value TEXT NOT NULL,
        service_tier TEXT,
        cwd TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        thread_json TEXT NOT NULL,
        approval_policy_json TEXT NOT NULL,
        sandbox_policy_json TEXT NOT NULL,
        base_instructions TEXT,
        developer_instructions TEXT,
        personality TEXT
        ,resolved_model TEXT
        ,last_claude_message_uuid TEXT
        ,last_completed_turn_id TEXT
        ,claude_code_version TEXT
        ,runtime_settings_json TEXT
        ,deletion_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        last_claude_message_uuid TEXT,
        UNIQUE(thread_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        provider_event_type TEXT,
        provider_event_id TEXT,
        dedup_key TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        payload_json TEXT NOT NULL,
        provider_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(turn_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS pending_requests (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        claude_request_id TEXT,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pending_requests_claude_id
        ON pending_requests(thread_id, claude_request_id, status);
      CREATE TABLE IF NOT EXISTS goals (
        thread_id TEXT PRIMARY KEY,
        goal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_queues (
        thread_id TEXT PRIMARY KEY,
        queue_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS section_orders (
        section_id TEXT PRIMARY KEY,
        order_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_checkpoints (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        goal_id TEXT NOT NULL,
        checkpoint_key TEXT NOT NULL,
        PRIMARY KEY(thread_id, goal_id, checkpoint_key)
      );
      CREATE TABLE IF NOT EXISTS provider_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        process_epoch TEXT NOT NULL,
        provider_sequence INTEGER NOT NULL,
        provider_event_type TEXT NOT NULL,
        provider_event_id TEXT,
        payload_json TEXT NOT NULL,
        disposition TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        projected_at INTEGER,
        UNIQUE(thread_id, process_epoch, provider_sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_events_thread_event_id
        ON provider_events(thread_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS provider_item_correlations (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider_message_id TEXT NOT NULL,
        owner_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY(thread_id, provider_message_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS provider_item_correlations_owner
        ON provider_item_correlations(owner_thread_id, turn_id);
      CREATE TABLE IF NOT EXISTS pending_thread_removals (
        root_thread_id TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_provider_events (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        provider_event_id TEXT NOT NULL,
        provider_event_type TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, provider_event_id)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
      this.ensureColumn("threads", "resolved_model", "TEXT");
      this.ensureColumn("threads", "last_claude_message_uuid", "TEXT");
      this.ensureColumn("threads", "last_completed_turn_id", "TEXT");
      this.ensureColumn("threads", "claude_code_version", "TEXT");
      this.ensureColumn("threads", "runtime_settings_json", "TEXT");
      this.ensureColumn("threads", "deletion_pending", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("threads", "developer_instructions", "TEXT");
      const threadColumns = new Set((this.database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>)
        .map((column) => column.name));
      if (threadColumns.has("claude_session_id") && threadColumns.has("cwd")) {
        this.database.exec(`
          INSERT OR IGNORE INTO pending_thread_removals (root_thread_id, claude_session_id, cwd, kind)
          SELECT id, claude_session_id, cwd, 'delete' FROM threads WHERE deletion_pending = 1
        `);
      }
      const nativeHistoryApplied = this.database.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = 14",
      ).get();
      if (!nativeHistoryApplied) this.ensureColumn("turns", "last_claude_message_uuid", "TEXT");
      this.ensureColumn("events", "event_id", "TEXT");
      this.ensureColumn("events", "provider_event_type", "TEXT");
      this.ensureColumn("events", "provider_event_id", "TEXT");
      this.ensureColumn("events", "dedup_key", "TEXT");
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS events_thread_dedup
          ON events(thread_id, dedup_key) WHERE dedup_key IS NOT NULL;
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
      `);
      const threadScopedIds = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
      if (!threadScopedIds) this.migrateThreadScopedIds();
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (4)");
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (5)");
      this.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (6)");
      const compactProjection = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
      if (!compactProjection) {
        this.database.exec(`
          INSERT OR IGNORE INTO processed_provider_events(
            thread_id, provider_event_id, provider_event_type, processed_at
          )
          SELECT thread_id, provider_event_id, COALESCE(provider_event_type, 'unknown'), created_at
          FROM events
          WHERE method = 'hybrid/providerMessage/processed' AND provider_event_id IS NOT NULL;
          DROP TABLE IF EXISTS items;
          INSERT INTO schema_migrations(version) VALUES (7);
        `);
      }
      const uniqueCatalogIdentity = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
      if (!uniqueCatalogIdentity) {
        if (threadColumns.has("session_id") && threadColumns.has("thread_json")) {
          this.database.exec(`
            UPDATE threads
            SET session_id = id,
                thread_json = json_set(thread_json, '$.sessionId', id)
            WHERE json_extract(thread_json, '$.parentThreadId') IS NULL
              AND session_id != id;
          `);
        }
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (8)");
      }
      const cleanDeveloperInstructions = this.database.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = 9",
      ).get();
      if (!cleanDeveloperInstructions) {
        const rows = this.database.prepare(`
          SELECT id, developer_instructions
          FROM threads
          WHERE developer_instructions LIKE '%<app-context>%</app-context>%'
        `).all() as unknown as Array<{ id: string; developer_instructions: string }>;
        const update = this.database.prepare(
          "UPDATE threads SET developer_instructions = ? WHERE id = ?",
        );
        for (const row of rows) {
          update.run(withoutAppContext(row.developer_instructions), row.id);
        }
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (9)");
      }
      const textElements = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get();
      if (!textElements) {
        // User input from the iOS client was stored without text_elements; the Desktop app crashes on it.
        const rows = this.database.prepare("SELECT thread_id, id, turn_json FROM turns WHERE turn_json LIKE '%\"userMessage\"%'")
          .all() as unknown as Array<{ thread_id: string; id: string; turn_json: string }>;
        const update = this.database.prepare("UPDATE turns SET turn_json = ? WHERE thread_id = ? AND id = ?");
        for (const row of rows) {
          const turn = JSON.parse(row.turn_json) as Turn;
          let changed = false;
          for (const item of turn.items) {
            if (item.type !== "userMessage") continue;
            for (const entry of item.content) {
              if (entry.type === "text" && entry.text_elements === undefined) { entry.text_elements = []; changed = true; }
            }
          }
          if (changed) update.run(JSON.stringify(turn), row.thread_id, row.id);
        }
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (10)");
      }
      const threadModel = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get();
      if (!threadModel) {
        // Codex 0.153 made Thread.model / Thread.reasoningEffort required.
        if (["thread_json", "model_picker_id", "runtime_settings_json"].every((column) => threadColumns.has(column))) this.database.exec(`
          UPDATE threads
          SET thread_json = json_set(
            thread_json,
            '$.model', model_picker_id,
            '$.reasoningEffort', json_extract(coalesce(runtime_settings_json, '{}'), '$.reasoningEffort')
          );
        `);
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (11)");
      }
      const interactiveSource = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 12").get();
      if (!interactiveSource) {
        // Claude threads are listed like stock's own app-server threads (vscode), which
        // stock's default thread/list source filter keeps; appServer it drops.
        if (threadColumns.has("thread_json")) this.database.exec(`
          UPDATE threads
          SET thread_json = json_set(thread_json, '$.source', 'vscode')
          WHERE json_extract(thread_json, '$.source') = 'appServer';
        `);
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (12)");
      }
      const claudeSessionFlags = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get();
      if (!claudeSessionFlags) {
        this.database.exec(`
          CREATE TABLE claude_session_flags (
            session_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL UNIQUE,
            archived INTEGER NOT NULL DEFAULT 0,
            ephemeral INTEGER NOT NULL DEFAULT 0,
            section_json TEXT,
            section_entered_at INTEGER
          );
        `);
        if (["claude_session_id", "archived", "ephemeral", "thread_json"].every((column) => threadColumns.has(column))) {
          this.database.exec(`
          INSERT INTO claude_session_flags (
            session_id, thread_id, archived, ephemeral, section_json, section_entered_at
          )
          SELECT
            claude_session_id,
            id,
            archived,
            ephemeral,
            json_extract(thread_json, '$.section'),
            json_extract(thread_json, '$.sectionEnteredAt')
          FROM (
            SELECT *, row_number() OVER (
              PARTITION BY claude_session_id
              ORDER BY ephemeral ASC, updated_at DESC, created_at DESC, id DESC
            ) AS session_rank
            FROM threads
            WHERE json_extract(thread_json, '$.parentThreadId') IS NULL
          )
          WHERE session_rank = 1
            AND (
              id != claude_session_id
              OR archived != 0
              OR ephemeral != 0
              OR json_type(thread_json, '$.section') NOT IN ('null')
            );
          `);
        }
        this.database.exec("INSERT INTO schema_migrations(version) VALUES (13)");
      }
      const nativeHistory = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 14").get();
      if (!nativeHistory) {
        this.database.exec(`
          DROP TABLE IF EXISTS provider_item_correlations;
          DROP TABLE IF EXISTS provider_events;
          DROP TABLE IF EXISTS processed_provider_events;
          DROP TABLE IF EXISTS events;
          DROP TABLE IF EXISTS pending_requests;
          DROP TABLE IF EXISTS thread_queues;
          DROP INDEX IF EXISTS turns_last_claude_message_uuid;
          INSERT INTO schema_migrations(version) VALUES (14);
        `);
      }
      this.database.exec(`
        DROP TABLE IF EXISTS items;
        DROP TABLE IF EXISTS provider_item_correlations;
        DROP TABLE IF EXISTS provider_events;
        DROP TABLE IF EXISTS processed_provider_events;
        DROP TABLE IF EXISTS events;
        DROP TABLE IF EXISTS pending_requests;
        DROP TABLE IF EXISTS thread_queues;
      `);
    });
  }

  private migrateThreadScopedIds(): void {
    this.database.exec(`
      CREATE TABLE turns_v3 (
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        last_claude_message_uuid TEXT,
        PRIMARY KEY(thread_id, id),
        UNIQUE(thread_id, ordinal)
      );
      INSERT INTO turns_v3 (
        id, thread_id, ordinal, status, turn_json, last_claude_message_uuid
      ) SELECT id, thread_id, ordinal, status, turn_json, last_claude_message_uuid FROM turns;

      CREATE TABLE items_v3 (
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        payload_json TEXT NOT NULL,
        provider_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, id),
        FOREIGN KEY(thread_id, turn_id) REFERENCES turns_v3(thread_id, id) ON DELETE CASCADE,
        UNIQUE(thread_id, turn_id, ordinal)
      );
      INSERT INTO items_v3 (
        id, thread_id, turn_id, ordinal, type, status, payload_json,
        provider_item_id, created_at, updated_at
      ) SELECT
        id, thread_id, turn_id, ordinal, type, status, payload_json,
        provider_item_id, created_at, updated_at
      FROM items;

      DROP TABLE items;
      DROP TABLE turns;
      ALTER TABLE turns_v3 RENAME TO turns;
      ALTER TABLE items_v3 RENAME TO items;
      INSERT INTO schema_migrations(version) VALUES (3);
    `);
    const violations = this.database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("SQLite migration 3 violated foreign-key integrity");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
