import type { ThreadForkResponse } from "../codex/generated/v2/ThreadForkResponse.js";
import type { ThreadInjectItemsParams } from "../codex/generated/v2/ThreadInjectItemsParams.js";
import type { HandoffStore, SideThreadRecord } from "../handoff/store.js";

export interface OptimisticSideTarget {
  readonly provider: "claude" | "stock";
  readonly backendThreadId: string;
}

interface State {
  readonly response: ThreadForkResponse;
  readonly connections: Set<string>;
  readonly cleanup: (target: OptimisticSideTarget) => Promise<void>;
  readonly ready: Promise<OptimisticSideTarget>;
  readonly resolve: (target: OptimisticSideTarget) => void;
  readonly reject: (error: Error) => void;
  readonly preparation?: SideThreadRecord["preparation"];
  tail: Promise<void>;
  target?: OptimisticSideTarget;
  failure?: Error;
  failureReported: boolean;
  deleted: boolean;
  deletion?: Promise<void>;
  readonly injections: Array<ThreadInjectItemsParams["items"]>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class OptimisticSideThreads {
  private readonly states = new Map<string, State>();
  private closed = false;

  public constructor(private readonly store?: Pick<HandoffStore, "saveSideThread" | "sideThreads" | "deleteSideThread">) {}

  public open(
    connectionId: string,
    response: ThreadForkResponse,
    prepare: () => Promise<OptimisticSideTarget>,
    cleanup: (target: OptimisticSideTarget) => Promise<void>,
    failed: (threadId: string, error: Error) => void,
    preparation?: SideThreadRecord["preparation"],
    restored?: SideThreadRecord,
  ): ThreadForkResponse {
    const ready = deferred<OptimisticSideTarget>();
    const state: State = {
      response,
      connections: new Set([connectionId]),
      cleanup,
      ready: ready.promise,
      resolve: ready.resolve,
      reject: ready.reject,
      tail: Promise.resolve(),
      failureReported: false,
      deleted: restored?.deleted ?? false,
      preparation,
      injections: restored?.injections ?? [],
      ...(restored?.target ? { target: restored.target } : {}),
      ...(restored?.failure ? { failure: new Error(restored.failure) } : {}),
    };
    void state.ready.catch(() => undefined);
    this.states.set(response.thread.id, state);
    this.persist(state);
    queueMicrotask(() => {
      if (this.closed) return;
      const pending = state.target ? Promise.resolve(state.target)
        : state.failure ? Promise.reject(state.failure) : prepare();
      void pending.then(async (target) => {
        if (this.closed) return;
        state.target = target;
        this.persist(state);
        if (state.deleted) {
          await this.delete(response.thread.id);
          return;
        }
        state.resolve(target);
      }, (value: unknown) => {
        if (this.closed) return;
        const error = value instanceof Error ? value : new Error(String(value));
        state.failure = error;
        this.persist(state);
        state.reject(error);
        if (state.deleted) this.forgetPromoted(response.thread.id);
        else failed(response.thread.id, error);
      }).catch((error: unknown) => failed(response.thread.id, error instanceof Error ? error : new Error(String(error))));
    });
    return response;
  }

  public recover(
    prepare: (record: SideThreadRecord) => Promise<OptimisticSideTarget>,
    cleanup: (threadId: string, target: OptimisticSideTarget) => Promise<void>,
    restored: (threadId: string, target: OptimisticSideTarget, response: ThreadForkResponse) => void,
    failed: (threadId: string, error: Error) => void,
    inject?: (target: OptimisticSideTarget, items: ThreadInjectItemsParams["items"]) => Promise<void>,
  ): void {
    for (const record of this.store?.sideThreads() ?? []) {
      const threadId = record.response.thread.id;
      if (record.target) restored(threadId, record.target, record.response);
      this.open("", record.response, async () => {
        const target = await prepare(record);
        restored(threadId, target, record.response);
        return target;
      }, (target) => cleanup(threadId, target), failed, record.preparation, record);
      if (!record.deleted && record.injections?.length) {
        void this.run(threadId, (target) => this.flushInjections(this.states.get(threadId)!, target, inject!))
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.fail(threadId, failure);
            failed(threadId, failure);
          });
      }
    }
  }

  private persist(state: State): void {
    if (this.closed) return;
    this.store?.saveSideThread({
      response: state.response,
      ...(state.preparation ? { preparation: state.preparation } : {}),
      ...(state.target ? { target: state.target } : {}),
      ...(state.failure ? { failure: state.failure.message } : {}),
      ...(state.deleted ? { deleted: true } : {}),
      ...(state.injections.length ? { injections: state.injections } : {}),
    });
  }

  public owns(threadId: string): boolean {
    return this.states.has(threadId);
  }

  public projectLoadedIds(ids: readonly string[]): string[] {
    const backends = new Set([...this.states.values()].flatMap((state) => state.target?.backendThreadId ?? []));
    return [...new Set([
      ...ids.filter((id) => !backends.has(id) && !this.states.get(id)?.deleted),
      ...[...this.states].filter(([, state]) => !state.deleted).map(([id]) => id),
    ])];
  }

  public snapshot(threadId: string): ThreadForkResponse | undefined {
    return this.states.get(threadId)?.response;
  }

  public phase(threadId: string): "preparing" | "ready" | "failed" | undefined {
    const state = this.states.get(threadId);
    if (!state) return undefined;
    if (state.failure) return "failed";
    return state.target ? "ready" : "preparing";
  }

  public target(threadId: string): OptimisticSideTarget | undefined {
    return this.states.get(threadId)?.target;
  }

  public run<T>(
    threadId: string,
    operation: (target: OptimisticSideTarget) => Promise<T>,
  ): Promise<T> {
    const state = this.states.get(threadId);
    if (!state) return Promise.reject(new Error(`Unknown optimistic side thread '${threadId}'.`));
    const result = state.tail.then(async () => {
      if (state.failure) throw state.failure;
      const target = await state.ready;
      if (state.deleted || this.closed) throw new Error(`Side thread '${threadId}' is no longer accepting operations.`);
      return operation(target);
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public inject(
    threadId: string,
    items: ThreadInjectItemsParams["items"],
    apply: (target: OptimisticSideTarget, items: ThreadInjectItemsParams["items"]) => Promise<void>,
  ): Promise<void> {
    const state = this.states.get(threadId)!;
    state.injections.push(items);
    this.persist(state);
    return this.run(threadId, (target) => this.flushInjections(state, target, apply));
  }

  private async flushInjections(
    state: State,
    target: OptimisticSideTarget,
    apply: (target: OptimisticSideTarget, items: ThreadInjectItemsParams["items"]) => Promise<void>,
  ): Promise<void> {
    while (state.injections.length) {
      await apply(target, state.injections[0]!);
      state.injections.shift();
      this.persist(state);
    }
  }

  public fail(threadId: string, error: Error): void {
    const state = this.states.get(threadId);
    if (state && !state.failure) {
      state.failure = error;
      this.persist(state);
    }
  }

  public attach(threadId: string, connectionId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.connections.add(connectionId);
  }

  public detach(threadId: string, connectionId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.connections.delete(connectionId);
  }

  public detachConnection(connectionId: string): void {
    for (const state of this.states.values()) {
      state.connections.delete(connectionId);
    }
  }

  public async delete(threadId: string): Promise<void> {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.deletion) return state.deletion;
    state.deleted = true;
    this.persist(state);
    state.reject(new Error("Optimistic side thread was deleted before preparation completed."));
    if (state.failure && !state.target) {
      this.forgetPromoted(threadId);
      return;
    }
    if (!state.target) return;
    state.deletion = state.cleanup(state.target).then(() => this.forgetPromoted(threadId));
    try {
      await state.deletion;
    } finally {
      delete state.deletion;
    }
  }

  public forgetPromoted(threadId: string): void {
    if (!this.closed) this.store?.deleteSideThread(threadId);
    this.states.delete(threadId);
  }

  public claimFailure(threadId: string): Error | undefined {
    const state = this.states.get(threadId);
    if (!state?.failure || state.failureReported) return undefined;
    state.failureReported = true;
    return state.failure;
  }

  public close(): void {
    this.closed = true;
  }
}
