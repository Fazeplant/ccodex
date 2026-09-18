/** Owns pure projection of selected Claude transcript history into Codex protocol objects. */
import { isAbsolute, resolve } from "node:path";
import type { Thread } from "../../codex/generated/v2/Thread.js";
import type { ThreadItem } from "../../codex/generated/v2/ThreadItem.js";
import type { Turn } from "../../codex/generated/v2/Turn.js";
import type { UserInput } from "../../codex/generated/v2/UserInput.js";
import { normalizeClaudeModelIdentifier } from "../modelSelection.js";
import {
  projectToolCompletion,
  startTool,
  type ActiveTool,
} from "../toolMapper.js";
import { selectHistory, type SelectedHistory } from "./history.js";
import {
  isCompactBoundary,
  readTranscriptRecords,
  type AssistantRecord,
  type SystemRecord,
  type ToolResultBlock,
  type ToolUseBlock,
  type TranscriptChainRecord,
  type TranscriptRecord,
  type UserRecord,
} from "./records.js";

export interface ProjectTranscriptInput {
  readonly sessionId: string;
  readonly path: string;
  readonly records?: readonly TranscriptRecord[];
  readonly history?: SelectedHistory;
  readonly parentThreadId?: string | null;
  readonly subagent?: {
    readonly promptRecordUuid: string;
    readonly nickname: string;
    readonly depth: number;
  };
}

export interface TranscriptProjection {
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly skippedLines: number;
  readonly compactionBoundaries: ReadonlySet<string>;
}

interface ToolCompletion {
  readonly record: UserRecord;
  readonly block: ToolResultBlock;
}

interface ReasoningProjectionState {
  open: Extract<ThreadItem, { type: "reasoning" }> | undefined;
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const NON_TERMINAL_STOPS = new Set(["tool_use", "pause_turn"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function seconds(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1_000);
}

function textContent(record: UserRecord): string {
  if (typeof record.message.content === "string") return record.message.content;
  return record.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function hasToolResult(record: UserRecord): boolean {
  return Array.isArray(record.message.content)
    && record.message.content.some((block) => block.type === "tool_result");
}

function startsTurn(record: UserRecord, subagentPromptUuid: string | undefined): boolean {
  if (record.uuid === subagentPromptUuid) return true;
  if (record.isMeta === true || record.isCompactSummary === true || hasToolResult(record)) return false;
  if (record.origin?.kind === "human") return true;
  if (record.origin !== undefined || !textContent(record)) return false;
  const text = textContent(record);
  return !/<command-name>|<command-message>|<command-args>|<local-command-[^>]*>|<task-notification>/u.test(text)
    && !text.startsWith("[Injected model-visible history]")
    && !/^\[Request interrupted by user(?: for tool use)?\]$/u.test(text);
}

function imageInput(source: unknown): UserInput | undefined {
  const fields = object(source);
  if (!fields) return undefined;
  const data = string(fields.data);
  const mediaType = string(fields.media_type) ?? string(fields.mediaType);
  if (fields.type === "base64" && data && mediaType) return { type: "image", url: `data:${mediaType};base64,${data}` };
  const url = string(fields.url);
  return url ? { type: "image", url } : undefined;
}

function userInputs(record: UserRecord): UserInput[] {
  if (typeof record.message.content === "string") {
    return [{ type: "text", text: record.message.content, text_elements: [] }];
  }
  return record.message.content.flatMap((block): UserInput[] => {
    if (block.type === "text") return [{ type: "text", text: block.text, text_elements: [] }];
    if (block.type === "image") {
      const image = imageInput(block.source);
      return image ? [image] : [];
    }
    return [];
  });
}

function assistantBlocks(record: AssistantRecord): readonly Record<string, unknown>[] {
  if (!Array.isArray(record.message.content)) return [];
  return record.message.content.filter((block): block is Record<string, unknown> =>
    block !== null && typeof block === "object");
}

function itemId(record: AssistantRecord, blockIndex: number, blockCount: number): string {
  return blockCount === 1 ? record.uuid : `${record.uuid}:${blockIndex}`;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    const fields = object(block);
    return typeof fields?.text === "string" ? [fields.text] : [];
  }).join("\n");
}

function toolCompletions(records: readonly TranscriptChainRecord[]): ReadonlyMap<string, ToolCompletion> {
  const results = new Map<string, ToolCompletion>();
  for (const record of records) {
    if (record.type !== "user" || !Array.isArray(record.message.content)) continue;
    for (const block of record.message.content) {
      if (block.type === "tool_result") results.set(block.tool_use_id, { record, block });
    }
  }
  return results;
}

function structuredOutput(completion: ToolCompletion): string {
  const blockOutput = outputText(completion.block.content);
  if (blockOutput) return blockOutput;
  const result = completion.record.toolUseResult;
  if (!result) return "";
  const stdout = string(result.stdout) ?? "";
  const stderr = string(result.stderr) ?? "";
  return `${stdout}${stderr}`;
}

function filePath(name: string, input: Record<string, unknown>, result: Record<string, unknown> | undefined): string | undefined {
  return string(result?.filePath) ?? string(result?.file_path)
    ?? string(input[name === "NotebookEdit" ? "notebook_path" : "file_path"])
    ?? string(input.path);
}

function structuredDiff(result: Record<string, unknown> | undefined): string {
  if (!Array.isArray(result?.structuredPatch)) return string(result?.diff) ?? string(result?.patch) ?? "";
  return result.structuredPatch.flatMap((value) => {
    const hunk = object(value);
    if (!hunk || !Array.isArray(hunk.lines)) return [];
    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 0;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 0;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : 0;
    return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${hunk.lines.join("\n")}`];
  }).join("\n");
}

function completeFileItem(
  item: Extract<ThreadItem, { type: "fileChange" }>,
  name: string,
  input: Record<string, unknown>,
  completion: ToolCompletion | undefined,
  cwd: string,
): ThreadItem {
  if (!completion) return item;
  const result = completion.record.toolUseResult;
  const candidate = filePath(name, input, result);
  const path = candidate ? (isAbsolute(candidate) ? candidate : resolve(cwd, candidate)) : undefined;
  const diff = structuredDiff(result);
  const kind = result?.type === "create" ? { type: "add" as const }
    : result?.type === "delete" ? { type: "delete" as const }
      : { type: "update" as const, move_path: null };
  return {
    ...item,
    status: completion.block.is_error === true ? "failed" : completion.record.toolDenialKind ? "declined" : "completed",
    changes: path ? [{ path, kind, diff }] : [],
  };
}

function activeTool(
  index: number,
  block: ToolUseBlock,
  cwd: string,
  threadId: string,
  timestamp: string,
): { state: ActiveTool; item: ThreadItem } {
  if (block.name === "MultiEdit") {
    const input = object(block.input) ?? {};
    return {
      state: {
        index, providerId: block.id, itemId: block.id, name: block.name, cwd, input,
        partialInput: "", started: true, startedAtMs: Date.parse(timestamp),
      },
      item: { type: "fileChange", id: block.id, changes: [], status: "inProgress" },
    };
  }
  return startTool(index, block as unknown as Record<string, unknown>, cwd, threadId);
}

function projectTool(
  block: ToolUseBlock,
  blockIndex: number,
  record: AssistantRecord,
  cwd: string,
  threadId: string,
  completions: ReadonlyMap<string, ToolCompletion>,
): ThreadItem | undefined {
  if (block.name.startsWith("mcp__ccodex_goal__")) return undefined;
  const input = object(block.input) ?? {};
  const started = activeTool(blockIndex, block, cwd, threadId, record.timestamp);
  const completion = completions.get(block.id);
  if (started.item.type === "fileChange" && FILE_TOOLS.has(block.name)) {
    return completeFileItem(started.item, block.name, input, completion, cwd);
  }
  if (!completion) return started.item;
  const result = completion.record.toolUseResult;
  const deterministicResult = { ...result, duration_ms: typeof result?.duration_ms === "number" ? result.duration_ms : 0 };
  let item = projectToolCompletion(
    started.item,
    { ...started.state, startedAtMs: Date.parse(record.timestamp) },
    structuredOutput(completion),
    completion.block.is_error === true,
    deterministicResult,
    cwd,
    completion.record.toolDenialKind,
  ).completed;
  if (item.type === "collabAgentToolCall") {
    const agentId = string(result?.agentId);
    const childId = agentId ? `agent-${agentId}` : undefined;
    const status = string(result?.status);
    item = {
      ...item,
      receiverThreadIds: childId ? [childId] : [],
      agentsStates: childId ? {
        [childId]: {
          status: status === "stopped" ? "interrupted" : completion.block.is_error ? "errored" : "completed",
          message: string(result?.description) ?? null,
        },
      } : {},
    };
  }
  return item;
}

function responseHasTools(records: readonly TranscriptChainRecord[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const record of records) {
    if (record.type !== "assistant" || !record.message.id) continue;
    if (assistantBlocks(record).some((block) => ["tool_use", "server_tool_use", "mcp_tool_use"].includes(String(block.type)))) {
      result.add(record.message.id);
    }
  }
  return result;
}

function assistantItems(
  record: AssistantRecord,
  cwd: string,
  threadId: string,
  completions: ReadonlyMap<string, ToolCompletion>,
  toolResponses: ReadonlySet<string>,
  reasoning: ReasoningProjectionState,
): ThreadItem[] {
  const blocks = assistantBlocks(record);
  return blocks.flatMap((block, index): ThreadItem[] => {
    if (block.type === "text" && typeof block.text === "string") return [{
      type: "agentMessage", id: itemId(record, index, blocks.length), text: block.text,
      phase: record.message.id && toolResponses.has(record.message.id) ? "commentary" : "final_answer",
      memoryCitation: null, delivery: null, questions: null,
    }];
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const apiBlockIndex = record.apiBlockIndex ?? index;
      if (reasoning.open) {
        reasoning.open.summary.push(block.thinking);
        if (apiBlockIndex === 0) reasoning.open = undefined;
        return [];
      }
      const item: Extract<ThreadItem, { type: "reasoning" }> = {
        type: "reasoning", id: itemId(record, index, blocks.length), summary: [block.thinking], content: [],
      };
      if (apiBlockIndex > 0) reasoning.open = item;
      return [item];
    }
    if (["tool_use", "server_tool_use", "mcp_tool_use"].includes(String(block.type))
      && typeof block.id === "string" && typeof block.name === "string") {
      const item = projectTool(block as unknown as ToolUseBlock, index, record, cwd, threadId, completions);
      return item ? [item] : [];
    }
    return [];
  });
}

function turnStatus(records: readonly TranscriptChainRecord[], hasFollowingTurn: boolean): Turn["status"] {
  const failed = records.some((record) => record.type === "system" && record.subtype === "api_error"
    || record.type === "assistant" && (record.isApiErrorMessage === true || Boolean(record.error)));
  const interrupted = records.some((record) => record.type === "user" && (record.interruptedByShutdown === true
    || record.toolUseResult?.interrupted === true));
  if (interrupted) return "interrupted";
  if (failed) return "failed";
  const lastAssistant = records.findLast((record): record is AssistantRecord => record.type === "assistant");
  const stopReason = lastAssistant?.message.stop_reason;
  const terminal = stopReason !== null && stopReason !== undefined && !NON_TERMINAL_STOPS.has(stopReason);
  return terminal || hasFollowingTurn ? "completed" : "inProgress";
}

function errorMessage(records: readonly TranscriptChainRecord[]): string {
  const error = records.find((record): record is AssistantRecord | SystemRecord =>
    record.type === "assistant" && (record.isApiErrorMessage === true || Boolean(record.error))
      || record.type === "system" && record.subtype === "api_error");
  return error?.error ?? "Claude turn failed.";
}

function projectTurns(
  records: readonly TranscriptChainRecord[],
  cwd: string,
  threadId: string,
  subagentPromptUuid: string | undefined,
): Turn[] {
  const starts = records.flatMap((record, index) =>
    record.type === "user" && startsTurn(record, subagentPromptUuid) ? [index] : []);
  const completions = toolCompletions(records);
  const toolResponses = responseHasTools(records);
  return starts.map((start, turnIndex) => {
    const end = starts[turnIndex + 1] ?? records.length;
    const prompt = records[start] as UserRecord;
    const turnRecords = records.slice(start, end);
    const items: ThreadItem[] = [{ type: "userMessage", id: prompt.uuid, clientId: null, content: userInputs(prompt) }];
    const reasoning: ReasoningProjectionState = { open: undefined };
    for (const record of turnRecords.slice(1)) {
      if (record.type === "assistant") {
        items.push(...assistantItems(record, cwd, threadId, completions, toolResponses, reasoning));
      }
      else if (isCompactBoundary(record)) items.push({ type: "contextCompaction", id: record.uuid });
    }
    const status = turnStatus(turnRecords, turnIndex + 1 < starts.length);
    const startedAt = seconds(prompt.timestamp);
    const completedAt = status === "inProgress" ? null : seconds(turnRecords.at(-1)?.timestamp);
    return {
      id: prompt.uuid,
      items,
      itemsView: "full",
      status,
      error: status === "failed"
        ? { message: errorMessage(turnRecords), codexErrorInfo: null, additionalDetails: null, misalignment: null }
        : null,
      startedAt,
      completedAt,
      durationMs: startedAt === null || completedAt === null ? null : Math.max(0, (completedAt - startedAt) * 1_000),
    };
  });
}

function lastValue<T>(values: readonly T[]): T | undefined {
  return values.at(-1);
}

export async function projectTranscript(input: ProjectTranscriptInput): Promise<TranscriptProjection> {
  let skippedLines = 0;
  let rawRecords: readonly TranscriptRecord[];
  if (input.records) rawRecords = input.records;
  else if (input.history) rawRecords = input.history.records;
  else {
    const reader = readTranscriptRecords(input.path);
    const loaded: TranscriptRecord[] = [];
    for await (const record of reader) loaded.push(record);
    skippedLines = reader.skippedLines;
    rawRecords = loaded;
  }
  const history = input.history ?? selectHistory(rawRecords);
  const chain = rawRecords.filter((record): record is TranscriptChainRecord =>
    record.type === "user" || record.type === "assistant" || record.type === "system" || record.type === "attachment");
  const selected = history.records;
  const cwd = lastValue(chain.flatMap((record) => record.cwd ? [record.cwd] : [])) ?? "/";
  const gitBranch = lastValue(chain.flatMap((record) => record.gitBranch ? [record.gitBranch] : []));
  const turns = projectTurns(selected, cwd, input.sessionId, input.subagent?.promptRecordUuid);
  const timestamps = rawRecords.flatMap((record) => "timestamp" in record && typeof record.timestamp === "string"
    ? [record.timestamp] : []);
  const createdAt = seconds(timestamps[0]) ?? 0;
  const updatedAt = seconds(timestamps.at(-1)) ?? createdAt;
  const customTitle = lastValue(rawRecords.flatMap((record) =>
    record.type === "custom-title" && record.customTitle ? [record.customTitle] : []));
  const aiTitle = lastValue(rawRecords.flatMap((record) =>
    record.type === "ai-title" && record.aiTitle ? [record.aiTitle] : []));
  const assistants = selected.filter((record): record is AssistantRecord => record.type === "assistant");
  const model = lastValue(assistants.flatMap((record) => record.message.model ? [record.message.model] : []));
  const reasoningEffort = lastValue(assistants.flatMap((record) => record.effort ? [record.effort] : [])) ?? null;
  const firstPrompt = selected.find((record): record is UserRecord =>
    record.type === "user" && startsTurn(record, input.subagent?.promptRecordUuid));
  const preview = firstPrompt ? textContent(firstPrompt).trim() : "";
  const nickname = input.subagent?.nickname ?? null;
  const parentThreadId = input.parentThreadId ?? null;
  const cliVersion = lastValue(chain.flatMap((record) => record.version ? [record.version] : [])) ?? "claude-code";
  const status: Thread["status"] = turns.at(-1)?.status === "inProgress"
    ? { type: "active", activeFlags: [] }
    : { type: "idle" };
  const thread: Thread = {
    id: input.sessionId,
    extra: null,
    sessionId: input.sessionId,
    forkedFromId: input.subagent ? parentThreadId : null,
    parentThreadId,
    preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "claude",
    model: model ? `claude:${normalizeClaudeModelIdentifier(model)}` : null,
    reasoningEffort,
    createdAt,
    updatedAt,
    recencyAt: updatedAt,
    status,
    path: null,
    cwd,
    cliVersion,
    source: input.subagent ? { subAgent: { thread_spawn: {
      parent_thread_id: parentThreadId!, depth: input.subagent.depth, agent_path: null,
      agent_nickname: nickname, agent_role: null,
    } } } : "vscode",
    canAcceptDirectInput: input.subagent ? false : true,
    threadSource: input.subagent ? "subagent" : "user",
    agentNickname: nickname,
    agentRole: null,
    gitInfo: { sha: null, branch: gitBranch ?? null, originUrl: null },
    name: nickname ?? customTitle ?? aiTitle ?? null,
    turns,
  };
  return { thread, turns, skippedLines, compactionBoundaries: history.compactionBoundaries };
}
