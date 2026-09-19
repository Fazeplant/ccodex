import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { ClaudeThreadRecord } from "../../src/store/HybridStore.js";
import { LayeredHybridStore, MemoryHybridStore } from "../../src/store/memoryStore.js";

function record(id = "thread-1"): ClaudeThreadRecord {
  const thread: Thread = {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null,
    canAcceptDirectInput: true, preview: "", ephemeral: false, section: null,
    sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "claude",
    model: "claude:sonnet", reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: 1,
    status: { type: "idle" }, path: null, cwd: "/workspace", cliVersion: "claude-code",
    source: "vscode", threadSource: null, agentNickname: null, agentRole: null,
    gitInfo: null, name: null, turns: [],
  };
  return {
    thread, claudeSessionId: id, modelPickerId: "claude:sonnet", claudeModelValue: "sonnet",
    serviceTier: null, approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false }, baseInstructions: null,
    developerInstructions: null, personality: null, resolvedModel: null,
    lastClaudeMessageUuid: null, lastCompletedTurnId: null, claudeCodeVersion: null,
    reasoningEffort: null, reasoningSummary: null, collaborationMode: null, outputSchema: null,
    tokenUsageTotal: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    tokenUsageLast: null, modelContextWindow: null,
  };
}

describe("MemoryHybridStore retained contracts", () => {
  it("keeps an adopted native session entirely in the transient layer", () => {
    const durable = new MemoryHybridStore();
    const writes = [vi.spyOn(durable, "createThread"), vi.spyOn(durable, "updateThread")];
    const store = new LayeredHybridStore(durable);
    store.adoptTransient(record());
    store.updateThread({ ...record(), modelPickerId: "claude:opus" });
    expect(store.getThreadRecord("thread-1")?.modelPickerId).toBe("claude:opus");
    expect(writes.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("persists user-created side roots but keeps internal ephemeral work process-local", () => {
    const durable = new MemoryHybridStore();
    const store = new LayeredHybridStore(durable);
    const side = record("side");
    const internal = record("internal");
    store.createThread({ ...side, thread: { ...side.thread, ephemeral: true, threadSource: "user" } });
    store.createThread({ ...internal, thread: { ...internal.thread, ephemeral: true, threadSource: "system" } });
    expect(durable.hasThread("side")).toBe(true);
    expect(durable.hasThread("internal")).toBe(false);
  });

  it("retains goals, flags, section order, and pending-removal metadata", () => {
    const store = new MemoryHybridStore();
    store.createThread(record());
    expect(store.setGoal("thread-1", { objective: "finish", replace: true }).objective).toBe("finish");
    store.setSessionFlags({ sessionId: "thread-1", threadId: "thread-1", archived: true,
      ephemeral: false, section: null, sectionEnteredAt: null });
    store.setSectionOrder("pinned", ["thread-1"]);
    store.beginThreadRemoval({ rootThreadId: "thread-1", claudeSessionId: "thread-1",
      cwd: "/workspace", kind: "delete" });
    expect(store.sessionFlags().get("thread-1")?.archived).toBe(true);
    expect(store.sectionOrders().get("pinned")).toEqual(["thread-1"]);
    expect(store.listPendingThreadRemovals()).toHaveLength(1);
  });
});
