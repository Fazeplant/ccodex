import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { HybridConfig } from "../../../src/config/config.js";
import { ClaudeService } from "../../../src/claude/service.js";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import type {
  AssistantRecord,
  TranscriptRecord,
  UserRecord,
} from "../../../src/claude/native/records.js";
import { SubscriptionHub } from "../../../src/gateway/subscriptions.js";
import { Logger } from "../../../src/observability/logger.js";
import { MemoryHybridStore } from "../../../src/store/memoryStore.js";
import { FakeClaudeQuery } from "../../fixtures/fakeClaudeQuery.js";

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

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function stream(uuid: string, event: unknown): SDKMessage {
  return sdk({ type: "stream_event", event, parent_tool_use_id: null, uuid, session_id: "session" });
}

function assistant(uuid: string, messageId: string, content: unknown[], stopReason: string | null): SDKMessage {
  return sdk({
    type: "assistant",
    message: { id: messageId, role: "assistant", content, stop_reason: stopReason },
    parent_tool_use_id: null,
    uuid,
    session_id: "session",
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the scripted Claude turn.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("live and transcript item identity parity", () => {
  it("emits the same ordered ids and reasoning grouping for equivalent response blocks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-live-parity-"));
    const firstMessageId = "msg_live_first";
    const secondMessageId = "msg_live_second";
    const toolUseId = "toolu_live";
    const fake = new FakeClaudeQuery();
    fake.scriptedTurnMessages = [
      stream("stream-start-1", { type: "message_start", message: { id: firstMessageId } }),
      stream("stream-text-start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream("stream-text-delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } }),
      stream("stream-text-stop", { type: "content_block_stop", index: 0 }),
      assistant("assistant-text", firstMessageId, [{ type: "text", text: "Working" }], null),
      stream("stream-thinking-1-start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "scrubbed" } }),
      stream("stream-thinking-1-delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Inspect" } }),
      stream("stream-thinking-1-stop", { type: "content_block_stop", index: 1 }),
      assistant("assistant-thinking-1", firstMessageId, [{ type: "thinking", thinking: "Inspect", signature: "scrubbed" }], null),
      stream("stream-thinking-2-start", { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "", signature: "scrubbed" } }),
      stream("stream-thinking-2-delta", { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "Act" } }),
      stream("stream-thinking-2-stop", { type: "content_block_stop", index: 2 }),
      assistant("assistant-thinking-2", firstMessageId, [{ type: "thinking", thinking: "Act", signature: "scrubbed" }], null),
      stream("stream-tool-start", { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "printf ok" } } }),
      stream("stream-tool-stop", { type: "content_block_stop", index: 3 }),
      assistant("assistant-tool", firstMessageId, [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "printf ok" } }], "tool_use"),
      sdk({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
        parent_tool_use_id: null,
        uuid: "tool-result",
        session_id: "session",
      }),
      stream("stream-start-2", { type: "message_start", message: { id: secondMessageId } }),
      stream("stream-final-start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream("stream-final-delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }),
      stream("stream-final-stop", { type: "content_block_stop", index: 0 }),
      assistant("assistant-final", secondMessageId, [{ type: "text", text: "Done" }], "end_turn"),
      sdk({
        type: "result", subtype: "success", duration_ms: 10, duration_api_ms: 8,
        is_error: false, num_turns: 2, result: "Done", stop_reason: "end_turn", total_cost_usd: 0,
        usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {}, permission_denials: [], uuid: "result", session_id: "session",
      }),
    ];
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(directory), hub, new Logger("error"), new MemoryHybridStore(), fake.factory,
    );
    try {
      const started = await service.startThread({ model: "claude:haiku", cwd: directory });
      const liveIds: string[] = [];
      const seen = new Set<string>();
      let completed = false;
      hub.subscribe(started.thread.id, "parity", (method, params) => {
        if (method === "turn/completed") completed = true;
        if (!method.startsWith("item/")) return;
        const value = params as { item?: { id?: string }; itemId?: string };
        const id = value.item?.id ?? value.itemId;
        if (id && !seen.has(id)) {
          seen.add(id);
          liveIds.push(id);
        }
      });
      const prepared = await service.prepareTurn({
        threadId: started.thread.id,
        input: [{ type: "text", text: "Run parity", text_elements: [] }],
      });
      await prepared.announce();
      prepared.start();
      await waitFor(() => completed);

      const userUuid = fake.prompts[0]!.uuid!;
      expect(prepared.turn.id).toBe(userUuid);
      expect(prepared.turn.items[0]!.id).toBe(userUuid);
      const envelope = (uuid: string, parentUuid: string | null, timestamp: string) => ({
        uuid, parentUuid, timestamp, sessionId: started.thread.id, cwd: directory,
      });
      const prompt: UserRecord = {
        type: "user", ...envelope(userUuid, null, "2026-09-19T00:00:00.000Z"),
        origin: { kind: "human" }, message: { role: "user", content: "Run parity" },
      };
      const block = (
        uuid: string,
        parentUuid: string,
        messageId: string,
        apiBlockIndex: number,
        content: AssistantRecord["message"]["content"],
        stopReason: string | null,
      ): AssistantRecord => ({
        type: "assistant", ...envelope(uuid, parentUuid, `2026-09-19T00:00:0${apiBlockIndex + 1}.000Z`),
        apiBlockIndex,
        message: { id: messageId, role: "assistant", content, stop_reason: stopReason },
      });
      const text = block("record-text", userUuid, firstMessageId, 0, [{ type: "text", text: "Working" }], null);
      const thinking1 = block("record-thinking-1", text.uuid, firstMessageId, 1, [{ type: "thinking", thinking: "Inspect" }], null);
      const thinking2 = block("record-thinking-2", thinking1.uuid, firstMessageId, 2, [{ type: "thinking", thinking: "Act" }], null);
      const tool = block("record-tool", thinking2.uuid, firstMessageId, 3, [{
        type: "tool_use", id: toolUseId, name: "Bash", input: { command: "printf ok" },
      }], "tool_use");
      const toolResult: UserRecord = {
        type: "user", ...envelope("record-tool-result", tool.uuid, "2026-09-19T00:00:05.000Z"),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
        toolUseResult: { stdout: "ok", stderr: "" },
      };
      const final = block("record-final", toolResult.uuid, secondMessageId, 0, [{ type: "text", text: "Done" }], "end_turn");
      const records: TranscriptRecord[] = [prompt, text, thinking1, thinking2, tool, toolResult, final];
      const projection = await projectTranscript({
        sessionId: started.thread.id,
        path: "/tmp/scrubbed-live-parity.jsonl",
        records,
      });
      const projectedItems = projection.turns[0]!.items;

      expect(liveIds).toEqual(projectedItems.map((item) => item.id));
      expect(projectedItems.find((item) => item.type === "reasoning")).toMatchObject({
        id: `${firstMessageId}:1`,
        summary: ["Inspect", "Act"],
      });
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
