import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectHistory } from "../../../src/claude/native/history.js";
import {
  readTranscriptRecords,
  type AssistantRecord,
  type SystemRecord,
  type TranscriptRecord,
  type UserRecord,
} from "../../../src/claude/native/records.js";

const at = (second: number) => `2026-09-18T00:00:${String(second).padStart(2, "0")}.000Z`;

function user(uuid: string, parentUuid: string | null, text: string, second: number): UserRecord {
  return {
    type: "user", uuid, parentUuid, timestamp: at(second), sessionId: "session", isSidechain: false,
    origin: { kind: "human" }, message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  messageId: string,
  text: string,
  second: number,
): AssistantRecord {
  return {
    type: "assistant", uuid, parentUuid, timestamp: at(second), sessionId: "session", isSidechain: false,
    message: { id: messageId, model: "claude-test", role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("native Claude history selection", () => {
  it("uses last-wins UUIDs, the newest conversational branch, and response siblings", () => {
    const root = user("u1", null, "first", 1);
    const first = assistant("a1", "u1", "message-1", "old", 2);
    const replacement = assistant("a1", "u1", "message-1", "new", 3);
    const sibling = assistant("a2", "u1", "message-1", "sibling", 4);
    const { origin: _resultOrigin, ...resultEnvelope } = user("r1", "a2", "", 5);
    const toolResult: UserRecord = {
      ...resultEnvelope,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
    };
    const abandoned = user("u-old", "a1", "abandoned", 6);
    const current = user("u-new", "a1", "current", 7);

    const history = selectHistory([root, first, replacement, sibling, toolResult, abandoned, current]);
    expect(history.records.map((record) => record.uuid)).toEqual(["u1", "a1", "a2", "r1", "u-new"]);
    expect((history.records[1] as AssistantRecord).message.content).toEqual([{ type: "text", text: "new" }]);
  });

  it("walks through compact boundaries using logicalParentUuid", () => {
    const before = [user("u1", null, "first", 1), assistant("a1", "u1", "m1", "answer", 2)];
    const boundary: SystemRecord = {
      type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null,
      logicalParentUuid: "a1", timestamp: at(3), sessionId: "session", isSidechain: false,
      compactMetadata: {},
    };
    const { origin: _summaryOrigin, ...summaryEnvelope } = user("summary", "compact", "summary", 4);
    const summary: UserRecord = {
      ...summaryEnvelope, isCompactSummary: true,
    };
    const after = assistant("a2", "summary", "m2", "after", 5);

    const history = selectHistory([...before, boundary, summary, after]);
    expect(history.records.map((record) => record.uuid)).toEqual(["u1", "a1", "compact", "summary", "a2"]);
    expect(history.compactionBoundaries).toEqual(new Set(["compact"]));
  });
});

describe("native Claude record reader", () => {
  it("streams valid records and counts malformed or unsupported lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ccodex-native-records-"));
    const path = join(directory, "session.jsonl");
    const valid: TranscriptRecord = user("u1", null, "hello", 1);
    await writeFile(path, `${JSON.stringify(valid)}\n{broken\n{"type":"future-record"}\n`);
    try {
      const reader = readTranscriptRecords(path);
      const records: TranscriptRecord[] = [];
      for await (const record of reader) records.push(record);
      expect(records).toEqual([valid]);
      expect(reader.parsedLines).toBe(1);
      expect(reader.skippedLines).toBe(2);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
