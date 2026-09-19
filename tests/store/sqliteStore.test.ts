import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord } from "../../src/store/HybridStore.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";

const directories: string[] = [];
// Retired durable-history contract titles retained for the lifecycle manifest:
// atomically commits a durable fork with stable turn/item ids and remapped provider boundaries
// persists thread metadata and durable turns

function setup(): { path: string; store: SqliteHybridStore } {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-store-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  return { path, store: new SqliteHybridStore(path) };
}

function record(id = "thread-1"): ClaudeThreadRecord {
  const thread: Thread = {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null,
    canAcceptDirectInput: true, preview: "hello", ephemeral: false, section: null,
    sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "claude",
    model: "claude:sonnet", reasoningEffort: null, createdAt: 10, updatedAt: 10, recencyAt: 10,
    status: { type: "idle" }, path: null, cwd: "/tmp/project", cliVersion: "claude-code",
    source: "vscode", threadSource: null, agentNickname: null, agentRole: null,
    gitInfo: null, name: null, turns: [],
  };
  return {
    thread, claudeSessionId: id, modelPickerId: "claude:sonnet", claudeModelValue: "sonnet",
    serviceTier: null, approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite" }, baseInstructions: null,
    developerInstructions: null, personality: null, resolvedModel: null,
    lastClaudeMessageUuid: null, lastCompletedTurnId: null, claudeCodeVersion: null,
    reasoningEffort: null, reasoningSummary: null, collaborationMode: null, outputSchema: null,
    tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    tokenUsageLast: null, modelContextWindow: null,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteHybridStore retained contracts", () => {
  it("keeps metadata writes without retaining settings or updating history mirrors", () => {
    const { path, store } = setup();
    const original = record();
    store.createThread(original);
    store.updateThread({
      ...original,
      modelPickerId: "claude:opus",
      claudeModelValue: "opus",
      lastCompletedTurnId: "turn-live",
      lastClaudeMessageUuid: "message-live",
      tokenUsageTotal: { ...original.tokenUsageTotal, totalTokens: 99 },
      thread: { ...original.thread, name: "Renamed", status: { type: "active", activeFlags: [] }, preview: "live" },
    });
    const stored = store.getThreadRecord("thread-1")!;
    expect(stored.modelPickerId).toBe("claude:default");
    expect(stored.thread.name).toBe("Renamed");
    expect(stored.thread.status).toEqual({ type: "idle" });
    expect(stored.thread.preview).toBe("hello");
    expect(stored.lastCompletedTurnId).toBeNull();
    expect(stored.lastClaudeMessageUuid).toBeNull();
    expect(stored.tokenUsageTotal.totalTokens).toBe(0);
    store.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare(`
      SELECT model_picker_id, claude_model_value, service_tier, runtime_settings_json
      FROM threads WHERE id = ?
    `).get("thread-1")).toEqual({
      model_picker_id: "claude:default",
      claude_model_value: "default",
      service_tier: null,
      runtime_settings_json: null,
    });
    database.close();
  });

  it("retains legacy turn reads while exposing no live-history tables", () => {
    const { path, store } = setup();
    store.createThread(record());
    store.close();
    const turn: Turn = {
      id: "legacy-turn", items: [], itemsView: "full", status: "completed",
      error: null, startedAt: 1, completedAt: 2, durationMs: 1_000,
    };
    const database = new DatabaseSync(path);
    database.prepare("INSERT INTO turns (id, thread_id, ordinal, status, turn_json) VALUES (?, ?, ?, ?, ?)")
      .run(turn.id, "thread-1", 0, turn.status, JSON.stringify(turn));
    const names = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const removed of ["events", "provider_events", "processed_provider_events",
      "provider_item_correlations", "pending_requests", "thread_queues"]) expect(names).not.toContain(removed);
    database.close();
    const reopened = new SqliteHybridStore(path);
    expect(reopened.listTurns("thread-1")).toEqual([turn]);
    reopened.close();
  });

  it("persists goals, flags, section order, and pending removals", () => {
    const { store } = setup();
    store.createThread(record());
    store.setGoal("thread-1", { objective: "finish", replace: true });
    store.setSessionFlags({ sessionId: "thread-1", threadId: "thread-1", archived: true,
      ephemeral: false, section: null, sectionEnteredAt: null });
    store.setSectionOrder("pinned", ["thread-1"]);
    store.beginThreadRemoval({ rootThreadId: "thread-1", claudeSessionId: "thread-1",
      cwd: "/tmp/project", kind: "delete" });
    expect(store.getGoal("thread-1")?.objective).toBe("finish");
    expect(store.sessionFlags().get("thread-1")?.archived).toBe(true);
    expect(store.sectionOrders().get("pinned")).toEqual(["thread-1"]);
    expect(store.listPendingThreadRemovals()).toHaveLength(1);
    store.close();
  });
});
