import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type {
  ClaudeSessionFlags, ClaudeThreadRecord, GoalPatch, GoalUsageInput, HybridStore, InternalGoal,
  PendingThreadRemoval,
} from "./HybridStore.js";
import { settingsGeneration, withSettingsFrom } from "./HybridStore.js";
import { filterSortThreads } from "./threadFilter.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function restoreSet<T>(target: Set<T>, source: Set<T>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function filteredThreads(records: Iterable<ClaudeThreadRecord>, params: ThreadListParams): Thread[] {
  return filterSortThreads([...records].map((record) => record.thread), params).map(copy);
}

function defaultSessionFlags(flags: ClaudeSessionFlags): boolean {
  return flags.threadId === flags.sessionId && !flags.archived && !flags.ephemeral
    && flags.section === null && flags.sectionEnteredAt === null;
}

export class MemoryHybridStore implements HybridStore {
  private readonly records = new Map<string, ClaudeThreadRecord>();
  private readonly turns = new Map<string, Turn[]>();
  private readonly archived = new Set<string>();
  private readonly pendingRemovals = new Map<string, PendingThreadRemoval>();
  private readonly goals = new Map<string, InternalGoal>();
  private readonly sectionOrderBySection = new Map<string, string[]>();
  private readonly flagsBySession = new Map<string, ClaudeSessionFlags>();
  private readonly goalCheckpoints = new Set<string>();

  public createThread(record: ClaudeThreadRecord): void {
    this.records.set(record.thread.id, copy({ ...record, thread: { ...record.thread, turns: [] } }));
    this.turns.set(record.thread.id, []);
  }

  public hasThread(threadId: string): boolean { return this.records.has(threadId); }

  public getThreadRecord(threadId: string, includeTurns = false): ClaudeThreadRecord | undefined {
    const record = this.records.get(threadId);
    return record ? copy({ ...record, thread: { ...record.thread, turns: includeTurns ? this.turns.get(threadId) ?? [] : [] } }) : undefined;
  }

  public allThreadRecords(): ClaudeThreadRecord[] {
    return [...this.records.keys()].flatMap((id) => {
      const record = this.getThreadRecord(id, true);
      return record ? [record] : [];
    });
  }

  public listThreads(params: ThreadListParams): Thread[] {
    const archived = params.archived === true;
    return filteredThreads([...this.records.values()].filter((record) => this.archived.has(record.thread.id) === archived), params);
  }

  public sessionFlags(): ReadonlyMap<string, ClaudeSessionFlags> {
    return new Map([...this.flagsBySession].map(([sessionId, flags]) => [sessionId, copy(flags)]));
  }

  public setSessionFlags(flags: ClaudeSessionFlags): void {
    if (defaultSessionFlags(flags)) this.flagsBySession.delete(flags.sessionId);
    else this.flagsBySession.set(flags.sessionId, copy(flags));
  }

  public adoptTransient(record: ClaudeThreadRecord): void {
    this.createThread(record);
  }

  public updateThread(record: ClaudeThreadRecord): void {
    const current = this.records.get(record.thread.id);
    const merged = current && settingsGeneration(current) > settingsGeneration(record)
      ? withSettingsFrom(record, current)
      : record;
    this.records.set(record.thread.id, copy({ ...merged, thread: { ...merged.thread, turns: [] } }));
  }

  public isThreadArchived(threadId: string): boolean { return this.archived.has(threadId); }

  public setThreadArchived(threadId: string, archived: boolean): void {
    if (archived) this.archived.add(threadId);
    else this.archived.delete(threadId);
  }

  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    for (const threadId of threadIds) this.setThreadArchived(threadId, archived);
  }

  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.pendingRemovals.set(removal.rootThreadId, copy(removal));
  }
  public cancelThreadRemoval(rootThreadId: string): void {
    this.pendingRemovals.delete(rootThreadId);
  }
  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return [...this.pendingRemovals.values()].map(copy);
  }
  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    const snapshot = copy({
      records: this.records,
      turns: this.turns,
      archived: this.archived,
      pendingRemovals: this.pendingRemovals,
      goals: this.goals,
      goalCheckpoints: this.goalCheckpoints,
    });
    try {
      for (const threadId of [...threadIds].reverse()) this.deleteThread(threadId);
    } catch (error) {
      restoreMap(this.records, snapshot.records);
      restoreMap(this.turns, snapshot.turns);
      restoreSet(this.archived, snapshot.archived);
      restoreMap(this.pendingRemovals, snapshot.pendingRemovals);
      restoreMap(this.goals, snapshot.goals);
      restoreSet(this.goalCheckpoints, snapshot.goalCheckpoints);
      throw error;
    }
    this.pendingRemovals.delete(rootThreadId);
  }

  public deleteThread(threadId: string): void {
    this.records.delete(threadId);
    this.turns.delete(threadId);
    this.archived.delete(threadId);
    this.goals.delete(threadId);
    for (const checkpoint of this.goalCheckpoints) if (checkpoint.startsWith(`${threadId}:`)) this.goalCheckpoints.delete(checkpoint);
  }

  public getTurn(threadId: string, turnId: string): Turn | undefined {
    const turn = this.turns.get(threadId)?.find((candidate) => candidate.id === turnId);
    return turn ? copy(turn) : undefined;
  }

  public listTurns(threadId: string): Turn[] { return copy(this.turns.get(threadId) ?? []); }
  public commitForkedThread(
    record: ClaudeThreadRecord,
    inheritedGoal?: InternalGoal,
  ): void {
    this.createThread(record);
    if (inheritedGoal) this.goals.set(record.thread.id, copy(inheritedGoal));
  }
  public commitThreadRollback(
    record: ClaudeThreadRecord,
    removedThreadIds: readonly string[] = [],
  ): void {
    for (const threadId of removedThreadIds) this.deleteThread(threadId);
    this.updateThread(record);
  }

  public sectionOrders(): Map<string, string[]> {
    return new Map([...this.sectionOrderBySection].map(([sectionId, ids]) => [sectionId, [...ids]]));
  }

  public setSectionOrder(sectionId: string, threadIds: readonly string[]): void {
    if (threadIds.length === 0) this.sectionOrderBySection.delete(sectionId);
    else this.sectionOrderBySection.set(sectionId, [...threadIds]);
  }

  public getGoal(threadId: string): InternalGoal | undefined {
    const goal = this.goals.get(threadId);
    return goal ? copy(goal) : undefined;
  }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal {
    const previous = this.goals.get(threadId);
    const now = patch.now ?? Math.floor(Date.now() / 1_000);
    const replace = patch.replace === true || !previous;
    if (replace && patch.objective === undefined) throw new Error(`cannot create goal for thread ${threadId} without an objective`);
    const goal: InternalGoal = {
      threadId,
      goalId: replace ? crypto.randomUUID() : previous.goalId,
      objective: patch.objective ?? previous?.objective ?? "",
      status: patch.status ?? (replace ? "active" : previous.status),
      tokenBudget: patch.tokenBudget === undefined ? (replace ? null : previous.tokenBudget) : patch.tokenBudget,
      tokensUsed: replace ? 0 : previous.tokensUsed,
      timeUsedSeconds: replace ? 0 : previous.timeUsedSeconds,
      createdAt: replace ? now : previous.createdAt,
      updatedAt: now,
      ...(patch.continuationDeferred !== undefined
        ? { continuationDeferred: patch.continuationDeferred }
        : previous?.continuationDeferred !== undefined
          ? { continuationDeferred: previous.continuationDeferred }
          : {}),
    };
    if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited";
    this.goals.set(threadId, copy(goal));
    return copy(goal);
  }
  public clearGoal(threadId: string): boolean { return this.goals.delete(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined {
    const checkpoint = input.checkpointKey ? `${input.threadId}:${input.expectedGoalId}:${input.checkpointKey}` : undefined;
    if (checkpoint && this.goalCheckpoints.has(checkpoint)) return this.getGoal(input.threadId);
    const previous = this.goals.get(input.threadId);
    if (!previous || previous.goalId !== input.expectedGoalId) return previous ? copy(previous) : undefined;
    if (checkpoint) this.goalCheckpoints.add(checkpoint);
    if (previous.status !== "active" && previous.status !== "budgetLimited") return copy(previous);
    const goal = {
      ...previous,
      tokensUsed: previous.tokensUsed + Math.max(0, input.tokenDelta),
      timeUsedSeconds: previous.timeUsedSeconds + Math.max(0, input.timeDeltaSeconds),
      updatedAt: Math.floor(Date.now() / 1_000),
    };
    if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) goal.status = "budgetLimited" as const;
    this.goals.set(input.threadId, copy(goal));
    return copy(goal);
  }

  public close(): void {
    this.records.clear();
    this.turns.clear();
    this.archived.clear();
    this.pendingRemovals.clear();
    this.goals.clear();
    this.flagsBySession.clear();
    this.goalCheckpoints.clear();
  }
}

export class LayeredHybridStore implements HybridStore {
  private readonly ephemeral = new MemoryHybridStore();

  public constructor(private readonly durable: HybridStore) {}

  private persistent(record: ClaudeThreadRecord): boolean {
    return !record.thread.ephemeral
      || (record.thread.threadSource === "user" && record.thread.parentThreadId === null);
  }

  private owner(threadId: string): HybridStore { return this.ephemeral.hasThread(threadId) ? this.ephemeral : this.durable; }

  public createThread(record: ClaudeThreadRecord): void {
    (this.persistent(record) ? this.durable : this.ephemeral).createThread(record);
  }
  public hasThread(threadId: string): boolean { return this.ephemeral.hasThread(threadId) || this.durable.hasThread(threadId); }
  public getThreadRecord(threadId: string, includeTurns = false) { return this.owner(threadId).getThreadRecord(threadId, includeTurns); }
  public allThreadRecords(): ClaudeThreadRecord[] { return [...this.durable.allThreadRecords(), ...this.ephemeral.allThreadRecords()]; }
  public listThreads(params: ThreadListParams): Thread[] {
    return filterSortThreads([...this.durable.listThreads(params), ...this.ephemeral.listThreads(params)], params);
  }
  public sessionFlags(): ReadonlyMap<string, ClaudeSessionFlags> { return this.durable.sessionFlags(); }
  public setSessionFlags(flags: ClaudeSessionFlags): void { this.durable.setSessionFlags(flags); }
  public adoptTransient(record: ClaudeThreadRecord): void {
    this.ephemeral.adoptTransient(record);
  }
  public updateThread(record: ClaudeThreadRecord): void { this.owner(record.thread.id).updateThread(record); }
  public isThreadArchived(threadId: string): boolean { return this.owner(threadId).isThreadArchived(threadId); }
  public setThreadArchived(threadId: string, archived: boolean): void { this.owner(threadId).setThreadArchived(threadId, archived); }
  public commitThreadsArchived(threadIds: readonly string[], archived: boolean): void {
    const owner = this.owner(threadIds[0]!);
    if (threadIds.some((threadId) => this.owner(threadId) !== owner)) {
      throw new Error("Cannot atomically archive threads stored in different layers.");
    }
    owner.commitThreadsArchived(threadIds, archived);
  }
  public beginThreadRemoval(removal: PendingThreadRemoval): void {
    this.durable.beginThreadRemoval(removal);
  }
  public cancelThreadRemoval(rootThreadId: string): void {
    this.durable.cancelThreadRemoval(rootThreadId);
  }
  public listPendingThreadRemovals(): PendingThreadRemoval[] {
    return this.durable.listPendingThreadRemovals();
  }
  public commitThreadRemoval(rootThreadId: string, threadIds: readonly string[]): void {
    const owner = this.owner(rootThreadId);
    if (threadIds.some((threadId) => this.owner(threadId) !== owner)) {
      throw new Error("Cannot atomically delete threads stored in different layers.");
    }
    owner.commitThreadRemoval(rootThreadId, threadIds);
    if (owner !== this.durable) this.durable.commitThreadRemoval(rootThreadId, []);
  }
  public deleteThread(threadId: string): void { this.owner(threadId).deleteThread(threadId); }
  public getTurn(threadId: string, turnId: string): Turn | undefined { return this.owner(threadId).getTurn(threadId, turnId); }
  public listTurns(threadId: string): Turn[] { return this.owner(threadId).listTurns(threadId); }
  public commitForkedThread(
    record: ClaudeThreadRecord,
    inheritedGoal?: InternalGoal,
  ): void {
    (this.persistent(record) ? this.durable : this.ephemeral)
      .commitForkedThread(record, inheritedGoal);
  }
  public commitThreadRollback(
    record: ClaudeThreadRecord,
    removedThreadIds: readonly string[] = [],
  ): void {
    this.owner(record.thread.id).commitThreadRollback(record, removedThreadIds);
  }
  public sectionOrders(): Map<string, string[]> { return this.durable.sectionOrders(); }
  public setSectionOrder(sectionId: string, threadIds: readonly string[]): void { this.durable.setSectionOrder(sectionId, threadIds); }
  public getGoal(threadId: string): InternalGoal | undefined { return this.owner(threadId).getGoal(threadId); }
  public setGoal(threadId: string, patch: GoalPatch): InternalGoal { return this.owner(threadId).setGoal(threadId, patch); }
  public clearGoal(threadId: string): boolean { return this.owner(threadId).clearGoal(threadId); }
  public accountGoalUsage(input: GoalUsageInput): InternalGoal | undefined { return this.owner(input.threadId).accountGoalUsage(input); }
  public close(): void { this.ephemeral.close(); this.durable.close(); }
}
