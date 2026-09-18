import { describe, expect, it } from "vitest";
import { projectTranscript } from "../../../src/claude/native/projector.js";
import type {
  AssistantRecord,
  QueueOperationRecord,
  TitleRecord,
  TranscriptRecord,
  UserRecord,
} from "../../../src/claude/native/records.js";

const timestamp = (second: number) => `2026-09-18T01:00:${String(second).padStart(2, "0")}.000Z`;
const envelope = (uuid: string, parentUuid: string | null, second: number) => ({
  uuid, parentUuid, timestamp: timestamp(second), sessionId: "session", isSidechain: false,
  cwd: "/workspace", gitBranch: "main", version: "2.1.261",
});

function prompt(uuid: string, parentUuid: string | null, text: string, second: number): UserRecord {
  return {
    type: "user", ...envelope(uuid, parentUuid, second), origin: { kind: "human" },
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string,
  messageId: string,
  content: AssistantRecord["message"]["content"],
  second: number,
  stopReason: string | null = null,
): AssistantRecord {
  return {
    type: "assistant", ...envelope(uuid, parentUuid, second), effort: "high",
    message: { id: messageId, role: "assistant", model: "claude-sonnet-5", content, stop_reason: stopReason },
  };
}

function conversation(): TranscriptRecord[] {
  const user = prompt("prompt-1", null, "Build it", 1);
  const thinking = assistant("thinking-1", user.uuid, "message-1", [{
    type: "thinking", thinking: "Inspect first", signature: "secret-signature",
  }], 2);
  const text = assistant("text-1", thinking.uuid, "message-1", [{ type: "text", text: "Working" }], 3);
  const tool = assistant("tool-record", text.uuid, "message-1", [{
    type: "tool_use", id: "toolu-bash", name: "Bash", input: { command: "pwd" },
  }], 4, "tool_use");
  const result: UserRecord = {
    type: "user", ...envelope("result-1", tool.uuid, 5),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-bash", content: "/workspace\n" }] },
    toolUseResult: { stdout: "/workspace\n", stderr: "", interrupted: false },
  };
  const final = assistant("final-1", result.uuid, "message-2", [{ type: "text", text: "Done" }], 6, "end_turn");
  const aiTitle: TitleRecord = { type: "ai-title", aiTitle: "Generated title", sessionId: "session" };
  const customTitle: TitleRecord = { type: "custom-title", customTitle: "Chosen title", sessionId: "session" };
  return [user, thinking, text, tool, result, final, aiTitle, customTitle];
}

describe("native Claude transcript projector", () => {
  it("projects deterministic protocol ids and current tool shapes", async () => {
    const records = conversation();
    const first = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const second = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const turn = first.turns[0]!;

    expect(second).toEqual(first);
    expect(turn.id).toBe("prompt-1");
    expect(turn.status).toBe("completed");
    expect(turn.items.map((item) => [item.type, item.id])).toEqual([
      ["userMessage", "prompt-1"],
      ["reasoning", "thinking-1"],
      ["agentMessage", "text-1"],
      ["commandExecution", "toolu-bash"],
      ["agentMessage", "final-1"],
    ]);
    expect(turn.items[1]).toMatchObject({ type: "reasoning", summary: ["Inspect first"], content: [] });
    expect(JSON.stringify(turn.items)).not.toContain("secret-signature");
    expect(turn.items[3]).toMatchObject({
      type: "commandExecution", command: "pwd", cwd: "/workspace", status: "completed",
      aggregatedOutput: "/workspace\n", exitCode: 0,
    });
    expect(first.thread).toMatchObject({
      id: "session", preview: "Build it", name: "Chosen title", model: "claude:claude-sonnet-5",
      reasoningEffort: "high", modelProvider: "claude", source: "vscode", threadSource: "user",
      parentThreadId: null, createdAt: 1_789_693_201, updatedAt: 1_789_693_206,
    });
  });

  it("keeps existing ids stable when non-chain state is appended", async () => {
    const records = conversation();
    const before = await projectTranscript({ sessionId: "session", path: "/tmp/session.jsonl", records });
    const appended: QueueOperationRecord = {
      type: "queue-operation", operation: "enqueue", content: "later", sessionId: "session", timestamp: timestamp(7),
    };
    const after = await projectTranscript({
      sessionId: "session", path: "/tmp/session.jsonl", records: [...records, appended],
    });
    expect(after.turns.map((turn) => turn.id)).toEqual(before.turns.map((turn) => turn.id));
    expect(after.turns.flatMap((turn) => turn.items.map((item) => item.id)))
      .toEqual(before.turns.flatMap((turn) => turn.items.map((item) => item.id)));
    expect(after.thread.updatedAt).toBe(1_789_693_207);
  });

  it("suffixes block indexes only for multi-block assistant records", async () => {
    const user = prompt("prompt", null, "Question", 1);
    const multi = assistant("answer", user.uuid, "message", [
      { type: "thinking", thinking: "Reason", signature: "hidden" },
      { type: "text", text: "Answer" },
    ], 2, "end_turn");
    const projection = await projectTranscript({
      sessionId: "session", path: "/tmp/session.jsonl", records: [user, multi],
    });
    expect(projection.turns[0]!.items.map((item) => item.id)).toEqual(["prompt", "answer:0", "answer:1"]);
  });
});
