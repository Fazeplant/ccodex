import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import { NativeSessionCatalog } from "../../src/claude/native/catalog.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { TranscriptBrancher } from "../../src/claude/transcriptBrancher.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(directory: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/false",
    claudeProjectsDir: join(directory, "claude-projects"),
    dataDir: directory,
    publicSocket: join(directory, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function runTurn(service: ClaudeService, threadId: string, text: string): Promise<string> {
  const prepared = await service.prepareTurn({
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
  });
  await prepared.announce();
  await prepared.startAndWait();
  return prepared.response.turn.id;
}

function transcriptPath(directory: string, sessionId: string): string {
  return join(directory, "claude-projects", "-fake-project", `${sessionId}.jsonl`);
}

function transcriptRecords(directory: string, sessionId: string): Array<Record<string, unknown>> {
  return readFileSync(transcriptPath(directory, sessionId), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function brancher(forkWithProvenance = vi.fn<TranscriptBrancher["forkWithProvenance"]>()): TranscriptBrancher {
  return {
    forkWithProvenance,
    resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
    delete: async () => undefined,
  };
}

describe("Claude native rollback", () => {
  it("resumes the same session at the retained chain anchor and replaces the discarded branch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-native-rollback-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const fork = vi.fn<TranscriptBrancher["forkWithProvenance"]>();
    const removeNative = vi.fn(async () => undefined);
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, brancher(fork), { rename: async () => undefined, delete: removeNative },
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const originalIds = [
      await runTurn(service, started.thread.id, "first"),
      await runTurn(service, started.thread.id, "second"),
      await runTurn(service, started.thread.id, "discarded"),
    ];
    await service.prepareReadThread(started.thread.id, true);
    const catalog = new NativeSessionCatalog(config(directory).claudeProjectsDir);
    await catalog.refresh();
    const before = await catalog.projection(started.thread.id);
    const anchorUuid = before.turnBoundaries.find((entry) => entry.turnId === originalIds[1])!.messageUuid;

    const rolledBack = await service.rollbackThread({ threadId: started.thread.id, numTurns: 1 });

    expect(rolledBack.thread.turns.map((turn) => turn.id)).toEqual(originalIds.slice(0, 2));
    expect(service.readThread(started.thread.id, true).thread.turns.map((turn) => turn.id))
      .toEqual(originalIds.slice(0, 2));
    expect(fake.inputs.at(-1)?.options.resumeSessionAt).toBeUndefined();
    expect(fake.inputs).toHaveLength(1);

    const replacementId = await runTurn(service, started.thread.id, "replacement");
    expect(fake.inputs.at(-1)?.options).toMatchObject({
      resume: started.thread.id,
      resumeSessionAt: anchorUuid,
      resumeDropsTurn: originalIds[2],
    });
    expect(fake.inputs.at(-1)?.options.sessionId).toBeUndefined();
    expect(fork).not.toHaveBeenCalled();
    expect(removeNative).not.toHaveBeenCalled();

    await service.prepareReadThread(started.thread.id, true);
    const turns = service.readThread(started.thread.id, true).thread.turns;
    expect(turns.map((turn) => turn.id)).toEqual([...originalIds.slice(0, 2), replacementId]);
    expect(turns.map((turn) => turn.id)).not.toContain(originalIds[2]);
    const appendedPrompt = transcriptRecords(directory, started.thread.id)
      .findLast((record) => record.uuid === replacementId)!;
    expect(appendedPrompt.parentUuid).toBe(anchorUuid);
    await service.close();
  });

  it("deletes a zero-prefix session and creates the next query under the same native id", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-native-reset-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const deleted: string[] = [];
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, brancher(), {
        rename: async () => undefined,
        delete: async (sessionId) => {
          deleted.push(sessionId);
          rmSync(transcriptPath(directory, sessionId));
        },
      },
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const discarded = [
      await runTurn(service, started.thread.id, "first"),
      await runTurn(service, started.thread.id, "second"),
    ];
    const runtimeCount = fake.inputs.length;

    const reset = await service.rollbackThread({ threadId: started.thread.id, numTurns: 2 });

    expect(reset.thread.id).toBe(started.thread.id);
    expect(reset.thread.turns).toEqual([]);
    expect(service.readThread(started.thread.id, true).thread.turns).toEqual([]);
    expect(deleted).toEqual([started.thread.id]);
    expect(existsSync(transcriptPath(directory, started.thread.id))).toBe(false);
    expect(fake.inputs).toHaveLength(runtimeCount);

    const replacementId = await runTurn(service, started.thread.id, "fresh root");
    expect(fake.inputs.at(-1)?.options).toMatchObject({ sessionId: started.thread.id });
    expect(fake.inputs.at(-1)?.options.resume).toBeUndefined();
    expect(fake.inputs.at(-1)?.options.resumeSessionAt).toBeUndefined();
    await service.prepareReadThread(started.thread.id, true);
    expect(service.readThread(started.thread.id, true).thread.turns.map((turn) => turn.id))
      .toEqual([replacementId]);
    expect(discarded).not.toContain(replacementId);
    expect(transcriptRecords(directory, started.thread.id)[0]?.parentUuid).toBeNull();
    await service.close();
  });

  it("keeps public thread/fork on standalone transcript forking", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-native-fork-"));
    directories.push(directory);
    const fake = new FakeClaudeQuery();
    const fork = vi.fn<TranscriptBrancher["forkWithProvenance"]>(async (_source, _boundary, _cwd, expected) => ({
      sessionId: randomUUID(),
      uuidMap: new Map(expected.map((uuid) => [uuid, randomUUID()])),
    }));
    const service = new ClaudeService(
      config(directory), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, brancher(fork),
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    const turnId = await runTurn(service, started.thread.id, "fork source");
    await service.prepareReadThread(started.thread.id, true);

    const forked = await service.forkThread({ threadId: started.thread.id, lastTurnId: turnId });

    expect(fork).toHaveBeenCalledOnce();
    expect(forked.thread.turns.map((turn) => turn.id)).toEqual([turnId]);
    await service.close();
  });

  it("creates the manual compaction item only at the boundary and reprojects its uuid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-native-compact-"));
    directories.push(directory);
    const gate = deferred();
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactBoundaryWait = gate.promise;
    const hub = new SubscriptionHub();
    const itemIds: string[] = [];
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"),
      new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
      undefined, undefined, brancher(),
    );
    const started = await service.startThread({ model: "claude:haiku", cwd: directory });
    await service.resumeThread(started.thread.id);
    hub.subscribe(started.thread.id, "compaction", (method, params) => {
      if (method === "item/started" && (params as { item: { type: string } }).item.type === "contextCompaction") {
        itemIds.push((params as { item: { id: string } }).item.id);
      }
    });

    await service.compactThread(started.thread.id);
    await waitFor(() => fake.prompts.length === 1, "compact prompt");
    expect((await service.liveSnapshot(started.thread.id)).activeTurn?.items).toEqual([]);
    gate.resolve();
    await waitFor(() => itemIds.length === 1, "compact boundary item");
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status === "completed",
      "compact completion",
    );

    const catalog = new NativeSessionCatalog(config(directory).claudeProjectsDir);
    await catalog.refresh();
    const projection = await catalog.projection(started.thread.id);
    expect(projection.turns.at(-1)).toMatchObject({
      status: "completed",
      items: [{ type: "contextCompaction", id: itemIds[0] }],
    });
    await service.close();
  });
});
