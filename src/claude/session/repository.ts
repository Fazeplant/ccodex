import type { Turn } from "../../codex/generated/v2/Turn.js";
import type {
  ClaudeThreadRecord,
  GoalPatch,
  GoalUsageInput,
  HybridStore,
  InternalGoal,
  PendingThreadRemoval,
  TurnProviderBoundary,
} from "../../store/HybridStore.js";

export function branchRevision(
  record: ClaudeThreadRecord,
  boundaries: readonly TurnProviderBoundary[],
  turns = record.thread.turns,
): string {
  return JSON.stringify({
    sessionId: record.claudeSessionId,
    turns: turns.map((turn) => [turn.id, turn.status]),
    boundaries,
  });
}

export function remapBoundaries(
  boundaries: readonly TurnProviderBoundary[],
  uuidEntries: readonly (readonly [string, string])[],
  retainedTurnIds: ReadonlySet<string>,
): TurnProviderBoundary[] {
  const uuidMap = new Map(uuidEntries);
  const seen = new Set<string>();
  return boundaries.map(({ turnId, messageUuid }) => {
    const mapped = uuidMap.get(messageUuid);
    if (!retainedTurnIds.has(turnId) || seen.has(turnId) || !mapped) {
      throw new Error(`Claude fork is missing or invalid provenance for retained boundary '${messageUuid}'.`);
    }
    seen.add(turnId);
    return { turnId, messageUuid: mapped };
  });
}

export class ClaudeSessionRepository {
  public constructor(private readonly store: HybridStore) {}

  public create(record: ClaudeThreadRecord): void {
    this.store.createThread(record);
  }

  public read(threadId: string, includeTurns: boolean): ClaudeThreadRecord | undefined {
    return this.store.getThreadRecord(threadId, includeTurns);
  }

  public update(record: ClaudeThreadRecord): void {
    this.store.updateThread(record);
  }

  public delete(threadId: string): void {
    this.store.deleteThread(threadId);
  }

  public goal(threadId: string): InternalGoal | undefined { return this.store.getGoal(threadId); }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal { return this.store.setGoal(threadId, patch); }
  public clearGoal(threadId: string): boolean { return this.store.clearGoal(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined { return this.store.accountGoalUsage(input); }
  public archived(threadId: string): boolean { return this.store.isThreadArchived(threadId); }
  public commitArchived(threadIds: readonly string[], archived: boolean): void {
    this.store.commitThreadsArchived(threadIds, archived);
  }
  public beginRemoval(removal: PendingThreadRemoval): void {
    this.store.beginThreadRemoval(removal);
  }
  public cancelRemoval(rootThreadId: string): void {
    this.store.cancelThreadRemoval(rootThreadId);
  }
  public pendingRemoval(rootThreadId: string): PendingThreadRemoval | undefined {
    return this.store.listPendingThreadRemovals()
      .find((removal) => removal.rootThreadId === rootThreadId);
  }
  public commitRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    this.store.commitThreadRemoval(rootThreadId, threadIds);
  }

  public ownedThreadIds(threadId: string): string[] {
    const children = new Map<string, string[]>();
    for (const record of this.store.allThreadRecords()) {
      const parent = record.thread.parentThreadId;
      if (!parent) continue;
      const values = children.get(parent) ?? [];
      values.push(record.thread.id);
      children.set(parent, values);
    }
    const result = [threadId];
    for (let index = 0; index < result.length; index += 1) {
      result.push(...(children.get(result[index]!) ?? []));
    }
    return result;
  }

  public commitFork(
    record: ClaudeThreadRecord,
    inheritedGoal?: InternalGoal,
  ): void {
    this.store.commitForkedThread(record, inheritedGoal);
  }

}
