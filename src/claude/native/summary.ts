/** Owns the constant-memory reduction of native transcript records into thread header fields. */
import { isChainRecord, type TranscriptRecord, type UserRecord } from "./records.js";

export interface TranscriptHeader {
  readonly cwd: string;
  readonly gitBranch: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly preview: string;
  readonly customTitle: string | null;
  readonly aiTitle: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly cliVersion: string | null;
}

export interface TranscriptSummaryState extends TranscriptHeader {
  readonly hasCreatedAt: boolean;
  readonly hasFirstPrompt: boolean;
  readonly userPermissionMode: string | null;
  readonly statePermissionMode: string | null;
}

export function timestampSeconds(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : Math.floor(milliseconds / 1_000);
}

export function userText(record: UserRecord): string {
  if (typeof record.message.content === "string") return record.message.content;
  return record.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function hasToolResult(record: UserRecord): boolean {
  return Array.isArray(record.message.content)
    && record.message.content.some((block) => block.type === "tool_result");
}

export function startsTurn(record: UserRecord, subagentPromptUuid?: string): boolean {
  if (record.uuid === subagentPromptUuid) return true;
  if (record.isMeta === true || record.isCompactSummary === true || hasToolResult(record)) return false;
  if (record.origin?.kind === "human") return true;
  if (record.origin !== undefined || !userText(record)) return false;
  const text = userText(record);
  return !/<command-name>|<command-message>|<command-args>|<local-command-[^>]*>|<task-notification>/u.test(text)
    && !text.startsWith("[Injected model-visible history]")
    && !/^\[Request interrupted by user(?: for tool use)?\]$/u.test(text);
}

const EMPTY_STATE: TranscriptSummaryState = {
  cwd: "/",
  gitBranch: null,
  createdAt: 0,
  updatedAt: 0,
  preview: "",
  customTitle: null,
  aiTitle: null,
  model: null,
  reasoningEffort: null,
  permissionMode: null,
  cliVersion: null,
  hasCreatedAt: false,
  hasFirstPrompt: false,
  userPermissionMode: null,
  statePermissionMode: null,
};

type MutableSummaryState = { -readonly [Key in keyof TranscriptSummaryState]: TranscriptSummaryState[Key] };

export class TranscriptSummarizer {
  private state: MutableSummaryState;

  public constructor(
    state: TranscriptSummaryState = EMPTY_STATE,
    private readonly subagentPromptUuid?: string,
  ) {
    this.state = { ...state };
  }

  public accept(record: TranscriptRecord): void {
    const timestamp = "timestamp" in record ? timestampSeconds(record.timestamp) : null;
    if (!this.state.hasCreatedAt && timestamp !== null) {
      this.state.createdAt = timestamp;
      this.state.hasCreatedAt = true;
    }
    if (timestamp !== null) this.state.updatedAt = timestamp;

    if (isChainRecord(record)) {
      if (record.cwd !== undefined) this.state.cwd = record.cwd;
      if (record.gitBranch !== undefined) this.state.gitBranch = record.gitBranch;
      if (record.version !== undefined) this.state.cliVersion = record.version;
    }
    if (record.type === "user") {
      if (!this.state.hasFirstPrompt && startsTurn(record, this.subagentPromptUuid)) {
        this.state.preview = userText(record).trim();
        this.state.hasFirstPrompt = true;
      }
      if (record.permissionMode !== undefined) this.state.userPermissionMode = record.permissionMode;
    } else if (record.type === "assistant") {
      if (record.message.model !== undefined) this.state.model = record.message.model;
      if (record.effort !== undefined) this.state.reasoningEffort = record.effort;
    } else if (record.type === "custom-title") {
      this.state.customTitle = record.customTitle ?? null;
    } else if (record.type === "ai-title") {
      this.state.aiTitle = record.aiTitle ?? null;
    } else if (record.type === "permission-mode" && typeof record.permissionMode === "string") {
      // Real Claude transcripts persist this state as `permissionMode`; it overrides user.permissionMode.
      this.state.statePermissionMode = record.permissionMode;
    }
    this.state.permissionMode = this.state.statePermissionMode ?? this.state.userPermissionMode;
  }

  public snapshot(): TranscriptSummaryState {
    return { ...this.state };
  }

  public header(updatedAt = this.state.updatedAt): TranscriptHeader {
    return {
      cwd: this.state.cwd,
      gitBranch: this.state.gitBranch,
      createdAt: this.state.createdAt,
      updatedAt,
      preview: this.state.preview,
      customTitle: this.state.customTitle,
      aiTitle: this.state.aiTitle,
      model: this.state.model,
      reasoningEffort: this.state.reasoningEffort,
      permissionMode: this.state.permissionMode,
      cliVersion: this.state.cliVersion,
    };
  }
}

export function summarizeTranscript(
  records: readonly TranscriptRecord[],
  subagentPromptUuid?: string,
): TranscriptHeader {
  const summarizer = new TranscriptSummarizer(undefined, subagentPromptUuid);
  for (const record of records) summarizer.accept(record);
  return summarizer.header();
}
