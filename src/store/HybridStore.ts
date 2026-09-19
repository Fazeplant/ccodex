import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { ThreadGoal } from "../codex/generated/v2/ThreadGoal.js";
import type { TokenUsageBreakdown } from "../codex/generated/v2/TokenUsageBreakdown.js";
import type { ApprovalsReviewer } from "../codex/generated/v2/ApprovalsReviewer.js";
import type { ThreadSection } from "../codex/generated/v2/ThreadSection.js";
import type { TurnProviderBoundary } from "../claude/native/projector.js";

export type { TurnProviderBoundary };

export interface InternalGoal extends ThreadGoal {
  readonly goalId: string;
  readonly continuationDeferred?: boolean;
}

export interface GoalPatch {
  readonly objective?: string;
  readonly status?: ThreadGoal["status"];
  readonly tokenBudget?: number | null;
  readonly replace?: boolean;
  readonly now?: number;
  readonly continuationDeferred?: boolean;
}

export interface GoalUsageInput {
  readonly threadId: string;
  readonly expectedGoalId: string;
  readonly tokenDelta: number;
  readonly timeDeltaSeconds: number;
  readonly checkpointKey?: string;
}

export interface ClaudeThreadRecord {
  readonly thread: Thread;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly claudeSessionId: string;
  readonly modelPickerId: string;
  readonly claudeModelValue: string;
  readonly serviceTier: string | null;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: ApprovalsReviewer;
  readonly sandboxPolicy: unknown;
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  readonly personality: string | null;
  readonly resolvedModel: string | null;
  readonly lastClaudeMessageUuid: string | null;
  readonly lastCompletedTurnId: string | null;
  readonly claudeCodeVersion: string | null;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly collaborationMode: unknown | null;
  readonly outputSchema: unknown | null;
  readonly tokenUsageTotal: TokenUsageBreakdown;
  readonly tokenUsageLast: TokenUsageBreakdown | null;
  readonly modelContextWindow: number | null;
  readonly providerCostUsdTotal?: number;
  readonly settingsGeneration?: number;
}

export interface ClaudeSessionFlags {
  readonly sessionId: string;
  readonly threadId: string;
  readonly archived: boolean;
  readonly ephemeral: boolean;
  readonly section: ThreadSection | null;
  readonly sectionEnteredAt: number | null;
}

export function settingsGeneration(record: ClaudeThreadRecord): number {
  return record.settingsGeneration ?? 0;
}

export function runtimeWorkspaceRoots(record: ClaudeThreadRecord): readonly string[] {
  return record.runtimeWorkspaceRoots ?? [record.thread.cwd];
}

export function withSettingsFrom(
  base: ClaudeThreadRecord,
  settings: ClaudeThreadRecord,
): ClaudeThreadRecord {
  return {
    ...base,
    thread: { ...base.thread, cwd: settings.thread.cwd, model: settings.modelPickerId, reasoningEffort: settings.reasoningEffort },
    runtimeWorkspaceRoots: runtimeWorkspaceRoots(settings),
    modelPickerId: settings.modelPickerId,
    claudeModelValue: settings.claudeModelValue,
    serviceTier: settings.serviceTier,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: settings.sandboxPolicy,
    baseInstructions: settings.baseInstructions,
    developerInstructions: settings.developerInstructions,
    personality: settings.personality,
    reasoningEffort: settings.reasoningEffort,
    reasoningSummary: settings.reasoningSummary,
    collaborationMode: settings.collaborationMode,
    outputSchema: settings.outputSchema,
    ...(settings.settingsGeneration === undefined
      ? {}
      : { settingsGeneration: settings.settingsGeneration }),
  };
}

export interface PendingRequestRecord {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly claudeRequestId: string | null;
  readonly method: string;
  readonly params: unknown;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly response: unknown | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface StateEvent {
  readonly turnId: string | null;
  readonly method: string;
  readonly params: unknown;
  readonly providerEventType?: string | null;
  readonly providerEventId?: string | null;
}

export interface PendingThreadRemoval {
  readonly rootThreadId: string;
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly kind: "delete" | "release" | "discard";
}

export type ProviderEventDisposition =
  | "pending"
  | "projected"
  | "stateOnly"
  | "retainedOnly"
  | "abandoned"
  | "unsupportedVisible"
  | "failed";

export interface ProviderItemCorrelation {
  readonly providerMessageId: string;
  readonly ownerThreadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

export interface HybridStore {
  createThread(record: ClaudeThreadRecord): void;
  hasThread(threadId: string): boolean;
  getThreadRecord(threadId: string, includeTurns?: boolean): ClaudeThreadRecord | undefined;
  allThreadRecords(): ClaudeThreadRecord[];
  listThreads(params: ThreadListParams): Thread[];
  sessionFlags(): ReadonlyMap<string, ClaudeSessionFlags>;
  setSessionFlags(flags: ClaudeSessionFlags): void;
  adoptTransient(record: ClaudeThreadRecord): void;
  /** Gateway-owned manual order of every section, keyed by section id (stock cannot order Claude threads). */
  sectionOrders(): Map<string, string[]>;
  setSectionOrder(sectionId: string, threadIds: readonly string[]): void;
  updateThread(record: ClaudeThreadRecord): void;
  isThreadArchived(threadId: string): boolean;
  setThreadArchived(threadId: string, archived: boolean): void;
  commitThreadsArchived(threadIds: readonly string[], archived: boolean): void;
  beginThreadRemoval(removal: PendingThreadRemoval): void;
  cancelThreadRemoval(rootThreadId: string): void;
  listPendingThreadRemovals(): PendingThreadRemoval[];
  commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void;
  deleteThread(threadId: string): void;
  getTurn(threadId: string, turnId: string): Turn | undefined;
  listTurns(threadId: string): Turn[];
  commitForkedThread(
    record: ClaudeThreadRecord,
    inheritedGoal?: InternalGoal,
  ): void;
  getGoal(threadId: string): InternalGoal | undefined;
  setGoal(threadId: string, patch: GoalPatch): InternalGoal;
  clearGoal(threadId: string): boolean;
  accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined;
  close(): void;
}
