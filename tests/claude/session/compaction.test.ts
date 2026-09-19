import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../../../src/codex/generated/v2/Thread.js";
import type { Turn } from "../../../src/codex/generated/v2/Turn.js";
import type { ClaudeThreadRecord, HybridStore } from "../../../src/store/HybridStore.js";
import { MemoryHybridStore } from "../../../src/store/memoryStore.js";
import { SubscriptionHub } from "../../../src/gateway/subscriptions.js";
import type {
  ClaudeSessionCommand,
  CompactionProjection,
  SessionLifecycleUpdate,
  StartedCompaction,
} from "../../../src/claude/session/commands.js";
import { ClaudeOutputAdapter } from "../../../src/claude/session/outputAdapter.js";
import { ClaudeSessionRepository } from "../../../src/claude/session/repository.js";
import { ClaudeSession } from "../../../src/claude/session/session.js";
import { ClaudeSessionRegistry } from "../../../src/claude/sessionRegistry.js";

const source = { providerEventId: "provider-event", providerEventType: "compact_boundary" };
afterEach(() => {
  vi.useRealTimers();
});

function record(threadId: string): ClaudeThreadRecord {
  const thread: Thread = {
    id: threadId,
    extra: null,
    sessionId: `session-${threadId}`,
    forkedFromId: null,
    parentThreadId: null,
    canAcceptDirectInput: true,
    preview: "",
    ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null,
    historyMode: "legacy",
    modelProvider: "claude", model: null, reasoningEffort: null,
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "claude-code",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
  return {
    thread,
    claudeSessionId: `claude-${threadId}`,
    modelPickerId: "claude:sonnet",
    claudeModelValue: "sonnet",
    serviceTier: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    resolvedModel: null,
    lastClaudeMessageUuid: null,
    lastCompletedTurnId: null,
    claudeCodeVersion: null,
    reasoningEffort: null,
    reasoningSummary: null,
    collaborationMode: null,
    outputSchema: null,
    tokenUsageTotal: {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    tokenUsageLast: null,
    modelContextWindow: null,
  };
}

function harness(
  threadId = "thread-1",
  onLifecycle: (update: SessionLifecycleUpdate) => void = () => undefined,
  store: HybridStore = new MemoryHybridStore(),
) {
  const hub = new SubscriptionHub();
  const registry = new ClaudeSessionRegistry<ClaudeSessionCommand, ClaudeSession>(
    (owner) => new ClaudeSession(
      owner,
      new ClaudeSessionRepository(store),
      new ClaudeOutputAdapter(hub),
      undefined, undefined, onLifecycle,
    ),
  );
  const events: string[] = [];
  hub.subscribe(threadId, "test", (method) => events.push(method));
  return { store, registry, events, threadId };
}

function liveTurn(state: ReturnType<typeof harness>): Turn | undefined {
  return state.registry.resolvedSession(state.threadId)?.liveSnapshot().activeTurn;
}

function notifications(state: ReturnType<typeof harness>): string[] {
  return state.registry.resolvedSession(state.threadId)?.notificationsAfter(0)
    .map((notification) => notification.method) ?? [];
}

async function startCompact(
  state: ReturnType<typeof harness>,
  generation = 1,
): Promise<StartedCompaction> {
  await state.registry.submit(state.threadId, {
    type: "createThread",
    record: record(state.threadId),
  });
  await state.registry.submit(state.threadId, {
    type: "attachRuntime",
    runtimeGeneration: generation,
  });
  return state.registry.submit<StartedCompaction>(state.threadId, { type: "startCompact" });
}

async function boundary(
  state: ReturnType<typeof harness>,
  generation = 1,
): Promise<CompactionProjection | undefined> {
  return state.registry.submit(state.threadId, {
    type: "compactBoundary",
    runtimeGeneration: generation,
    trigger: "manual",
    boundary: "summary-boundary",
    source,
  });
}

describe("ClaudeSession manual compaction", () => {
  it("starts one live lifecycle and acknowledges before any provider fact", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const state = harness("thread-1", (update) => lifecycle.push(update));
    const started = await startCompact(state);
    const turn = liveTurn(state);

    expect(turn).toMatchObject({
      status: "inProgress",
      items: [],
    });
    expect(state.registry.resolvedSession(state.threadId)?.liveSnapshot().status.type).toBe("active");
    expect(state.events).toEqual([
      "thread/status/changed",
      "turn/started",
    ]);
    expect(notifications(state)).toEqual(state.events);
    expect(lifecycle.at(-1)?.quiescent).toBe(false);
    expect(lifecycle.flatMap((update) => update.compactionActions ?? [])).toEqual([
      expect.objectContaining({
        kind: "send",
        input: "/compact",
        operationId: started.operationId,
        runtimeGeneration: 1,
      }),
    ]);

    await boundary(state);
    expect(state.registry.resolvedSession(state.threadId)?.liveSnapshot().lastClaudeMessageUuid)
      .toBe("summary-boundary");
    expect(liveTurn(state)?.status).toBe("completed");
    expect(state.events).toEqual([
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "thread/compacted",
      "thread/status/changed",
      "turn/completed",
    ]);
    expect(lifecycle.at(-1)?.quiescent).toBe(true);
    await state.registry.close();
  });

  it("defers prompted Compact until App acknowledgement and fences steer", async () => {
    const lifecycle: SessionLifecycleUpdate[] = [];
    const state = harness("prompted", (update) => lifecycle.push(update));
    await state.registry.submit(state.threadId, {
      type: "createThread",
      record: record(state.threadId),
    });
    await state.registry.submit(state.threadId, {
      type: "attachRuntime",
      runtimeGeneration: 1,
    });

    const started = await state.registry.submit<StartedCompaction>(state.threadId, {
      type: "startCompact",
      input: "/compact запомни только первое сообщение",
      deferred: true,
    });
    expect(started.turn).toMatchObject({
      id: started.turnId,
      status: "inProgress",
      items: [],
    });
    expect(state.events).toEqual(["thread/status/changed"]);
    expect(lifecycle.flatMap((update) => update.compactionActions ?? [])).toEqual([]);

    await expect(state.registry.submit(state.threadId, {
      type: "steer",
      runtimeGeneration: 1,
      messageUuid: "late-message",
      expectedTurnId: started.turnId,
      input: [{ type: "text", text: "жив?", text_elements: [] }],
    })).rejects.toThrow("does not match the Claude thread");

    await state.registry.submit(state.threadId, {
      type: "announceCompaction",
      operationId: started.operationId,
    });
    expect(state.events).toEqual([
      "thread/status/changed",
      "turn/started",
    ]);
    expect(lifecycle.flatMap((update) => update.compactionActions ?? [])).toEqual([
      expect.objectContaining({
        kind: "send",
        input: "/compact запомни только первое сообщение",
        operationId: started.operationId,
      }),
    ]);

    await boundary(state);
    expect(liveTurn(state)).toMatchObject({
      status: "completed",
      items: [{ type: "contextCompaction" }],
    });
    expect(state.events).toContain("thread/compacted");
    await state.registry.close();
  });

  it("owns the concrete watchdog callback and publishes one transport cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const actions: NonNullable<SessionLifecycleUpdate["compactionActions"]>[number][] = [];
    const state = harness("watchdog-callback", (update) => actions.push(...update.compactionActions ?? []));
    const started = await startCompact(state, 3);
    const send = actions[0]!;

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const cancel = actions.find((action) => action.kind === "cancel");
    expect(cancel).toEqual({
      kind: "cancel",
      operationId: started.operationId,
      messageUuid: send.messageUuid,
      runtimeGeneration: 3,
    });
    expect(actions.filter((action) => action.kind === "cancel")).toHaveLength(1);

    await state.registry.submit(state.threadId, {
      type: "compactTransportCancelled",
      operationId: cancel!.operationId,
      messageUuid: cancel!.messageUuid,
      runtimeGeneration: cancel!.runtimeGeneration,
    });
    expect(liveTurn(state)).toMatchObject({
      status: "failed",
      error: { message: "Claude compaction did not reach a terminal provider boundary within 15 minutes." },
    });
    await state.registry.close();
  });

  it("lets an accepted boundary win before Stop and ignores every late terminal fact", async () => {
    const state = harness();
    const started = await startCompact(state);
    await boundary(state);

    await expect(state.registry.submit<CompactionProjection | undefined>(state.threadId, {
      type: "interruptCompaction",
      turnId: started.turnId,
    })).resolves.toEqual({ turnId: started.turnId, terminal: true });
    await state.registry.submit(state.threadId, {
      type: "compactFailed",
      runtimeGeneration: 1,
      message: "late failure",
      codexErrorInfo: "other",
      source,
    });
    await state.registry.submit(state.threadId, {
      type: "compactRuntimeExited",
      runtimeGeneration: 1,
      message: "late exit",
    });

    expect(liveTurn(state)?.status).toBe("completed");
    expect(state.events.filter((event) => event === "turn/completed")).toHaveLength(1);
    await state.registry.close();
  });

  it("lets Stop fence boundary and failure until cancellation terminalizes once", async () => {
    const state = harness();
    const started = await startCompact(state);
    const interrupted = await state.registry.submit<CompactionProjection>(state.threadId, {
      type: "interruptCompaction",
      turnId: started.turnId,
    });
    expect(interrupted.cancelOperationId).toBe(started.operationId);

    await expect(boundary(state)).resolves.toMatchObject({ turnId: started.turnId, terminal: false });
    await state.registry.submit(state.threadId, {
      type: "compactFailed",
      runtimeGeneration: 1,
      message: "raced failure",
      codexErrorInfo: "other",
      source,
    });
    await state.registry.submit(state.threadId, {
      type: "compactTransportCancelled",
      operationId: interrupted.cancelOperationId!,
      messageUuid: interrupted.transportAction!.messageUuid,
      runtimeGeneration: 1,
    });
    await state.registry.submit(state.threadId, {
      type: "compactTransportCancelled",
      operationId: interrupted.cancelOperationId!,
      messageUuid: interrupted.transportAction!.messageUuid,
      runtimeGeneration: 1,
    });
    await boundary(state);

    expect(liveTurn(state)?.status).toBe("interrupted");
    expect(state.registry.resolvedSession(state.threadId)?.liveSnapshot().status.type).toBe("idle");
    expect(state.events.filter((event) => event === "turn/completed")).toHaveLength(1);
    expect(state.events).not.toContain("thread/compacted");
    expect(state.events).not.toContain("error");
    await state.registry.close();
  });

  it("makes runtime exit and watchdog first-writer deterministic in both orders", async () => {
    const exited = harness("exit-first");
    const exitStarted = await startCompact(exited, 4);
    await exited.registry.submit(exited.threadId, {
      type: "compactRuntimeExited",
      runtimeGeneration: 4,
      message: "runtime exited",
    });
    await expect(exited.registry.submit(exited.threadId, {
      type: "compactWatchdogFired",
      operationId: exitStarted.operationId,
    })).resolves.toBeUndefined();
    expect(liveTurn(exited)).toMatchObject({
      status: "failed",
      error: { message: "runtime exited" },
    });
    expect(exited.events.filter((event) => event === "turn/completed")).toHaveLength(1);
    await exited.registry.close();

    const watchdog = harness("watchdog-first");
    const watched = await startCompact(watchdog, 7);
    const cancellation = await watchdog.registry.submit<CompactionProjection>(
      watchdog.threadId,
      { type: "compactWatchdogFired", operationId: watched.operationId },
    );
    await watchdog.registry.submit(watchdog.threadId, {
      type: "compactRuntimeExited",
      runtimeGeneration: 7,
      message: "runtime exited after watchdog",
    });
    await watchdog.registry.submit(watchdog.threadId, {
      type: "compactTransportCancelled",
      operationId: cancellation.cancelOperationId!,
      messageUuid: cancellation.transportAction!.messageUuid,
      runtimeGeneration: 7,
    });
    expect(liveTurn(watchdog)).toMatchObject({
      status: "failed",
      error: { message: "Claude compaction did not reach a terminal provider boundary within 15 minutes." },
    });
    expect(watchdog.events.filter((event) => event === "turn/completed")).toHaveLength(1);
    await watchdog.registry.close();
  });

  it("shows automatic compaction on the normal turn until its provider boundary", async () => {
    const state = harness();
    await state.registry.submit(state.threadId, {
      type: "createThread",
      record: record(state.threadId),
    });
    await state.registry.submit(state.threadId, {
      type: "attachRuntime",
      runtimeGeneration: 2,
    });
    const prepared = await state.registry.submit<{ turn: Turn }>(state.threadId, {
      type: "prepareTurn",
      params: {
        threadId: state.threadId,
        input: [{ type: "text", text: "work", text_elements: [] }],
      },
    });
    await state.registry.submit(state.threadId, {
      type: "autoCompactStarted",
      runtimeGeneration: 2,
      source: { providerEventId: "compact-status", providerEventType: "system/status" },
    });
    await state.registry.submit(state.threadId, {
      type: "autoCompactStarted",
      runtimeGeneration: 2,
      source: { providerEventId: "compact-status-duplicate", providerEventType: "system/status" },
    });

    expect(liveTurn(state)?.items).not
      .toContainEqual(expect.objectContaining({ type: "contextCompaction" }));
    expect(state.events.filter((event) => event === "item/started")).toHaveLength(0);

    await expect(state.registry.submit<CompactionProjection | undefined>(state.threadId, {
      type: "compactBoundary",
      runtimeGeneration: 2,
      trigger: "auto",
      boundary: "auto-boundary",
      source,
    })).resolves.toMatchObject({
      turnId: prepared.turn.id,
      terminal: false,
    });
    expect(state.registry.resolvedSession(state.threadId)?.liveSnapshot().lastClaudeMessageUuid)
      .toBe("auto-boundary");
    expect(liveTurn(state)?.items)
      .toContainEqual(expect.objectContaining({ type: "contextCompaction" }));
    expect(state.events.filter((event) => event === "item/started")).toHaveLength(1);
    expect(state.events.filter((event) => event === "item/completed")).toHaveLength(1);
    expect(state.events.filter((event) => event === "thread/compacted")).toHaveLength(1);
    await state.registry.submit(state.threadId, {
      type: "lifecycle",
      runtimeGeneration: 2,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
      source,
    });
    await state.registry.close();
  });

  it("closes an unfinished automatic-compaction item when the turn terminates", async () => {
    const state = harness("auto-terminal");
    await state.registry.submit(state.threadId, {
      type: "createThread",
      record: record(state.threadId),
    });
    await state.registry.submit(state.threadId, {
      type: "attachRuntime",
      runtimeGeneration: 3,
    });
    await state.registry.submit(state.threadId, {
      type: "prepareTurn",
      params: {
        threadId: state.threadId,
        input: [{ type: "text", text: "work", text_elements: [] }],
      },
    });
    await state.registry.submit(state.threadId, {
      type: "autoCompactStarted",
      runtimeGeneration: 3,
      source: { providerEventId: "compact-status", providerEventType: "system/status" },
    });
    await state.registry.submit(state.threadId, {
      type: "lifecycle",
      runtimeGeneration: 3,
      fact: { type: "result", status: "completed", codexErrorInfo: null, origin: null },
      source,
    });

    const methods = notifications(state);
    expect(methods.filter((method) => method === "item/started")).toHaveLength(0);
    expect(methods.filter((method) => method === "item/completed")).toHaveLength(0);
    expect(methods).not.toContain("thread/compacted");
    await state.registry.close();
  });

  it("closes automatic-compaction UI on provider failure without completing the active turn", async () => {
    const state = harness("auto-failure");
    await state.registry.submit(state.threadId, { type: "createThread", record: record(state.threadId) });
    await state.registry.submit(state.threadId, { type: "attachRuntime", runtimeGeneration: 4 });
    const prepared = await state.registry.submit<{ turn: Turn }>(state.threadId, {
      type: "prepareTurn",
      params: {
        threadId: state.threadId,
        input: [{ type: "text", text: "work", text_elements: [] }],
      },
    });
    await state.registry.submit(state.threadId, {
      type: "autoCompactStarted",
      runtimeGeneration: 4,
      source: { providerEventId: "compact-status", providerEventType: "system/status" },
    });
    await state.registry.submit(state.threadId, {
      type: "compactFailed",
      runtimeGeneration: 4,
      message: "provider compact failed",
      codexErrorInfo: "other",
      source: { providerEventId: "compact-failed", providerEventType: "system/status" },
    });

    expect(liveTurn(state)?.status).toBe("inProgress");
    expect(state.events.filter((method) => method === "item/completed")).toHaveLength(0);
    expect(state.events).not.toContain("thread/compacted");
    await state.registry.close();
  });

  it("admits only session-owned live idle state", async () => {
    const active = harness("active");
    await active.registry.submit(active.threadId, {
      type: "createThread",
      record: record(active.threadId),
    });
    await active.registry.submit(active.threadId, {
      type: "attachRuntime",
      runtimeGeneration: 1,
    });
    await active.registry.submit(active.threadId, {
      type: "prepareTurn",
      params: {
        threadId: active.threadId,
        input: [{ type: "text", text: "busy", text_elements: [] }],
      },
    });
    await expect(active.registry.submit(active.threadId, { type: "startCompact" }))
      .rejects.toThrow("another lifecycle is active");

    const pending = harness("pending");
    await pending.registry.submit(pending.threadId, {
      type: "createThread",
      record: record(pending.threadId),
    });
    await pending.registry.submit(pending.threadId, {
      type: "attachRuntime",
      runtimeGeneration: 1,
    });
    await pending.registry.submit(pending.threadId, {
      type: "openInteraction",
      runtimeGeneration: 1,
      request: {
        threadId: pending.threadId,
        turnId: null,
        claudeRequestId: "pending-request",
        method: "item/tool/requestUserInput",
        params: {},
      },
    });
    await expect(pending.registry.submit(pending.threadId, { type: "startCompact" }))
      .rejects.toThrow("another lifecycle is active");

    await active.registry.close();
    await pending.registry.close();
  });
});
