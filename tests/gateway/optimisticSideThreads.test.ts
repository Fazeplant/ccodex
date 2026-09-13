import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadForkResponse } from "../../src/codex/generated/v2/ThreadForkResponse.js";
import { OptimisticSideThreads } from "../../src/gateway/optimisticSideThreads.js";
import { HandoffStore } from "../../src/handoff/store.js";

function response(id = "public-side"): ThreadForkResponse {
  return {
    thread: {
      id, extra: null, sessionId: "parent", forkedFromId: "parent", parentThreadId: null,
      canAcceptDirectInput: true,
      preview: "", ephemeral: true, section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "claude", model: null, reasoningEffort: null,
      createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: "idle" }, path: null,
      cwd: "/repo", cliVersion: "test", source: "appServer", threadSource: "user",
      agentNickname: null, agentRole: null, gitInfo: null, name: "Side", turns: [],
    },
    model: "claude:sonnet",
    modelProvider: "claude",
    serviceTier: null,
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo"],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  };
}

describe("optimistic side readiness", () => {
  it("opens immediately and serializes boundary before the first turn", async () => {
    let ready!: (target: { provider: "claude"; backendThreadId: string }) => void;
    const prepare = new Promise<{ provider: "claude"; backendThreadId: string }>((resolve) => { ready = resolve; });
    const sides = new OptimisticSideThreads();
    const opened = sides.open("app", response(), () => prepare, vi.fn(), vi.fn());
    const order: string[] = [];

    const boundary = sides.run(opened.thread.id, async () => {
      order.push("boundary:start");
      await Promise.resolve();
      order.push("boundary:end");
    });
    const turn = sides.run(opened.thread.id, async () => {
      order.push("turn");
    });

    expect(opened.thread).toMatchObject({ id: "public-side", ephemeral: true, turns: [] });
    expect(sides.phase(opened.thread.id)).toBe("preparing");
    expect(order).toEqual([]);
    ready({ provider: "claude", backendThreadId: "backend-side" });
    await Promise.all([boundary, turn]);
    expect(order).toEqual(["boundary:start", "boundary:end", "turn"]);
    expect(sides.target(opened.thread.id)).toEqual({
      provider: "claude",
      backendThreadId: "backend-side",
    });
    sides.close();
  });

  it("keeps preparation and active operations across more than 24 hours disconnected", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    const sides = new OptimisticSideThreads();
    sides.open("first", response(), async () => ({
      provider: "claude", backendThreadId: "backend-side",
    }), cleanup, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    sides.detachConnection("first");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 60_000);
    expect(cleanup).not.toHaveBeenCalled();
    sides.attach("public-side", "second");
    let finish!: () => void;
    const operation = sides.run("public-side", () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    sides.detach("public-side", "second");
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(sides.phase("public-side")).toBe("ready");
    finish();
    await operation;
    sides.close();
    vi.useRealTimers();
  });

  it.each(["claude", "stock"] as const)("restores the public %s side id after a gateway restart", async (provider) => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-side-persistence-"));
    try {
      const path = join(directory, "handoffs.sqlite");
      const firstStore = new HandoffStore(path);
      const first = new OptimisticSideThreads(firstStore);
      const target = { provider, backendThreadId: "backend-side" };
      first.open("app", response(), async () => target, vi.fn(), vi.fn());
      await first.run("public-side", async () => undefined);
      first.detachConnection("app");
      first.close();
      firstStore.close();

      const secondStore = new HandoffStore(path);
      const second = new OptimisticSideThreads(secondStore);
      const prepare = vi.fn();
      const restore = vi.fn();
      const cleanup = vi.fn(async () => undefined);
      second.recover(prepare, cleanup, restore, vi.fn());
      expect(await second.run("public-side", async (restored) => restored)).toEqual(target);
      expect(prepare).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledWith("public-side", target, response());
      expect(second.snapshot("public-side")?.thread).toMatchObject({ id: "public-side", ephemeral: true });
      expect(second.projectLoadedIds(["main", "backend-side"])).toEqual(["main", "public-side"]);
      await second.delete("public-side");
      expect(cleanup).toHaveBeenCalledWith("public-side", target);
      expect(secondStore.sideThreads()).toEqual([]);
      second.close();
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restarts interrupted preparation with the same public id and persisted fork parameters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-side-preparation-restart-"));
    try {
      const store = new HandoffStore(join(directory, "handoffs.sqlite"));
      const preparation = { provider: "claude" as const, params: { threadId: "parent", ephemeral: true, excludeTurns: true } };
      const first = new OptimisticSideThreads(store);
      first.open("app", response(), () => new Promise(() => undefined), vi.fn(), vi.fn(), preparation);
      const items = [{ type: "message", role: "user", content: [{ type: "input_text", text: "side boundary" }] }];
      void first.inject("public-side", items, vi.fn());
      first.close();
      const second = new OptimisticSideThreads(store);
      const target = { provider: "claude" as const, backendThreadId: "public-side" };
      const prepare = vi.fn(async () => target);
      const order: string[] = [];
      const inject = vi.fn(async () => { order.push("boundary"); });
      second.recover(prepare, vi.fn(), vi.fn(), vi.fn(), inject);
      expect(await second.run("public-side", async (restored) => { order.push("turn"); return restored; })).toEqual(target);
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ preparation, response: response() }));
      expect(inject).toHaveBeenCalledWith(target, items);
      expect(order).toEqual(["boundary", "turn"]);
      expect(store.sideThreads()[0]?.injections).toBeUndefined();
      second.close();
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans a backend that appears after delete and reports preparation failure once", async () => {
    let ready!: (target: { provider: "stock"; backendThreadId: string }) => void;
    const prepare = new Promise<{ provider: "stock"; backendThreadId: string }>((resolve) => { ready = resolve; });
    const cleanup = vi.fn(async () => undefined);
    const failed = vi.fn();
    const sides = new OptimisticSideThreads();
    sides.open("app", response(), () => prepare, cleanup, failed);
    await sides.delete("public-side");
    expect(sides.projectLoadedIds(["public-side", "main"])).toEqual(["main"]);
    ready({ provider: "stock", backendThreadId: "backend-side" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanup).toHaveBeenCalledWith({ provider: "stock", backendThreadId: "backend-side" });
    expect(sides.owns("public-side")).toBe(false);

    sides.open("app", response("failed-side"), async () => {
      throw new Error("provider fork exploded");
    }, cleanup, failed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).toHaveBeenCalledWith("failed-side", expect.objectContaining({
      message: "provider fork exploded",
    }));
    expect(sides.claimFailure("failed-side")?.message).toBe("provider fork exploded");
    expect(sides.claimFailure("failed-side")).toBeUndefined();
    sides.close();
  });
});
