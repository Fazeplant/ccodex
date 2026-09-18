import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSubagents } from "../../../src/claude/native/subagents.js";

function transcript(agentId: string) {
  return [
    {
      type: "user", uuid: `${agentId}-prompt`, parentUuid: null, timestamp: "2026-09-18T00:00:00.000Z",
      sessionId: "root", agentId, isSidechain: true, cwd: "/workspace", message: { role: "user", content: "Task" },
    },
    {
      type: "assistant", uuid: `${agentId}-answer`, parentUuid: `${agentId}-prompt`, timestamp: "2026-09-18T00:00:01.000Z",
      sessionId: "root", agentId, isSidechain: true, cwd: "/workspace", effort: "low",
      message: {
        id: `${agentId}-message`, role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "Done" }], stop_reason: "end_turn",
      },
    },
  ];
}

describe("native Claude sub-agent projection", () => {
  it("projects the meta parent tree and descriptive current-style names", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "ccodex-native-subagents-"));
    const directory = join(sessionDirectory, "subagents");
    await mkdir(directory);
    const agents = [
      { id: "parent", meta: { agentType: "Explore", description: "Inspect code", toolUseId: "tool-parent", spawnDepth: 1 } },
      { id: "child", meta: { agentType: "Explore", description: "Inspect tests", toolUseId: "tool-child", spawnDepth: 2, parentAgentId: "parent" } },
    ];
    for (const agent of agents) {
      await writeFile(join(directory, `agent-${agent.id}.meta.json`), `${JSON.stringify(agent.meta)}\n`);
      await writeFile(join(directory, `agent-${agent.id}.jsonl`), `${transcript(agent.id).map((record) => JSON.stringify(record)).join("\n")}\n`);
    }
    try {
      const projected = await projectSubagents(sessionDirectory, "root-thread");
      const parent = projected.find((agent) => agent.agentId === "parent")!.projection.thread;
      const child = projected.find((agent) => agent.agentId === "child")!.projection.thread;
      expect(parent).toMatchObject({
        id: "agent-parent", parentThreadId: "root-thread", forkedFromId: "root-thread",
        name: "Inspect code [Sonnet 5]", agentNickname: "Inspect code [Sonnet 5]", threadSource: "subagent",
        source: { subAgent: { thread_spawn: { depth: 1, agent_path: null } } },
      });
      expect(child).toMatchObject({
        id: "agent-child", parentThreadId: "agent-parent", forkedFromId: "agent-parent",
        name: "Inspect tests [Sonnet 5]",
        source: { subAgent: { thread_spawn: { depth: 2, agent_path: null } } },
      });
      expect(child.turns[0]!.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
    } finally {
      await rm(sessionDirectory, { recursive: true });
    }
  });
});
