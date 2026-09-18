import { createHash } from "node:crypto";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "../codex/generated/v2/ThreadListResponse.js";
import type { ThreadLoadedListParams } from "../codex/generated/v2/ThreadLoadedListParams.js";
import type { ThreadLoadedListResponse } from "../codex/generated/v2/ThreadLoadedListResponse.js";
import type { ThreadSearchParams } from "../codex/generated/v2/ThreadSearchParams.js";
import type { ThreadSearchResponse } from "../codex/generated/v2/ThreadSearchResponse.js";
import type { ThreadSearchResult } from "../codex/generated/v2/ThreadSearchResult.js";
import type { ThreadSectionMoveParams } from "../codex/generated/v2/ThreadSectionMoveParams.js";
import type { ClaudeService } from "../claude/service.js";
import type { StockRpc } from "./stockRpc.js";
import { CursorCodec, queryFingerprint } from "../protocol/cursor.js";
import { invalidParams, invalidRequest } from "../protocol/errors.js";
import type { StockSideThreads } from "./stockSideThreads.js";
import { cwdIdentity, filterSortThreads, publicListParams } from "../store/threadFilter.js";

export interface ThreadCatalogProjection {
  projectThreadCatalog(stock: Thread[], claude: Thread[], params?: ThreadListParams): Thread[];
  projectLoadedThreadIds(stock: string[], claude: string[]): string[];
  hiddenBackendIds?(provider?: "stock" | "claude"): Set<string>;
  currentBackendId?(publicThreadId: string): string | undefined;
  catalogTombstones?(): string[];
}

export interface RemoteCatalogSnapshot {
  readonly active: readonly Thread[];
  readonly archived: readonly Thread[];
  readonly hiddenPhysicalIds: ReadonlySet<string>;
}

export type CatalogNotificationSink = (method: string, params: unknown) => void;

type ThreadTimeKey = "createdAt" | "updatedAt" | "recencyAt" | "sectionEnteredAt";

interface ThreadCursor {
  readonly query: string;
  readonly direction: "asc" | "desc";
  /** `sectionRank`: position in the merged manual order of one section. */
  readonly key: ThreadTimeKey | "sectionRank";
  readonly value: number;
  readonly id: string;
}

interface OffsetCursor {
  readonly query: string;
  readonly version: string;
  readonly offset: number;
}

function threadKey(params: ThreadListParams): ThreadCursor["key"] {
  return params.sortKey === "updated_at" ? "updatedAt"
    : params.sortKey === "recency_at" ? "recencyAt"
    : params.sortKey === "section_position" ? (typeof params.sectionId === "string" ? "sectionRank" : "sectionEnteredAt")
    : "createdAt";
}

function threadQuery(params: ThreadListParams): string {
  const cwd = params.cwd == null
    ? null
    : (Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(cwdIdentity);
  return queryFingerprint({
    sortKey: params.sortKey ?? "created_at", modelProviders: params.modelProviders ?? null,
    sourceKinds: params.sourceKinds ?? null, archived: params.archived ?? false, cwd,
    // Tri-state filters: omitted and null are distinct queries.
    sectionId: params.sectionId === undefined ? null : [params.sectionId],
    projectId: params.projectId === undefined ? null : [params.projectId],
    useStateDbOnly: params.useStateDbOnly ?? false, searchTerm: params.searchTerm ?? null,
    parentThreadId: params.parentThreadId ?? null, ancestorThreadId: params.ancestorThreadId ?? null,
  });
}

async function allStockSearchResults(stock: StockRpc, params: ThreadSearchParams): Promise<ThreadSearchResult[]> {
  const results: ThreadSearchResult[] = [];
  let cursor: string | null = null;
  do {
    const page = await stock.request("thread/search", { ...params, cursor, limit: 100 }) as ThreadSearchResponse;
    results.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return results;
}

async function allStockThreads(stock: StockRpc, params: ThreadListParams): Promise<Thread[]> {
  const threads: Thread[] = [];
  let cursor: string | null = null;
  do {
    const result = await stock.request("thread/list", { ...params, cursor, limit: 100 }) as ThreadListResponse;
    threads.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return threads;
}

export class ThreadCatalog {
  public constructor(
    private readonly stock: StockRpc,
    private readonly claude: ClaudeService,
    private readonly cursors: CursorCodec,
    private readonly logical?: ThreadCatalogProjection,
    private readonly sideThreads?: Partial<Pick<StockSideThreads, "filterThreads" | "hiddenIds" | "loadedSideIds">>,
  ) {}

  private async projected(params: ThreadListParams): Promise<Thread[]> {
    // Provider-side filtering may hide a physical epoch before it can be
    // projected to its public task. Only the archive partition is safe to
    // apply before projection; every public filter is evaluated exactly once
    // on the unified catalog.
    // Never block the catalog on the Claude SDK: listSessions() can stall for
    // minutes while a turn is active, and the app drops the connection after
    // 30s. Refresh native metadata in the background; it applies next poll.
    void this.claude.refreshNativeMetadata?.();
    // Stock scans rollout files unless `useStateDbOnly` is forwarded, and it
    // omits sub-agent threads unless a parent/ancestor filter is forwarded.
    const providerParams: ThreadListParams = {
      archived: params.archived ?? false,
      cursor: null,
      limit: 100,
      ...(params.useStateDbOnly ? { useStateDbOnly: true } : {}),
      ...(params.parentThreadId ? { parentThreadId: params.parentThreadId } : {}),
      ...(params.ancestorThreadId ? { ancestorThreadId: params.ancestorThreadId } : {}),
    };
    const [stockCatalog, claudeCatalog] = await Promise.all([
      allStockThreads(this.stock, providerParams),
      Promise.resolve(this.claude.listThreads(providerParams)),
    ]);
    const stockThreads = this.sideThreads?.filterThreads?.(stockCatalog) ?? stockCatalog;
    const projected = this.logical
      ? this.logical.projectThreadCatalog(stockThreads, claudeCatalog, providerParams)
      : [...stockThreads, ...claudeCatalog];
    const threads = filterSortThreads(projected, publicListParams(params));
    return threadKey(params) === "sectionRank" ? this.orderedSection(params.sectionId as string, threads, params) : threads;
  }

  /**
   * Manual order of one section, ascending: the gateway-owned order first, then
   * stock's own order for threads it has not seen, then newcomers by entry time.
   * Stock keeps positions server-internal, so its order is only visible as the
   * order of a section-scoped `section_position` listing.
   */
  private async orderedSection(sectionId: string, members: Thread[], params: ThreadListParams): Promise<Thread[]> {
    const stockOrder = await allStockThreads(this.stock, {
      archived: params.archived ?? false, cursor: null, limit: 100, sectionId, sortKey: "section_position", sortDirection: "asc",
      ...(params.useStateDbOnly ? { useStateDbOnly: true } : {}),
    });
    const stockRank = new Map(stockOrder.map((thread, index) => [thread.id, index]));
    const ownRank = new Map((this.claude.sectionOrders().get(sectionId) ?? []).map((id, index) => [id, index]));
    const rank = (thread: Thread): number => {
      const own = ownRank.get(thread.id);
      if (own !== undefined) return own;
      const stock = stockRank.get(this.logical?.currentBackendId?.(thread.id) ?? thread.id);
      return stock === undefined ? 2e15 + (thread.sectionEnteredAt ?? 0) : 1e15 + stock;
    };
    return [...members].sort((left, right) => (rank(left) - rank(right)) || left.id.localeCompare(right.id));
  }

  public async list(params: ThreadListParams): Promise<ThreadListResponse> {
    const key = threadKey(params);
    const threads = await this.projected(params);
    if (key !== "sectionRank") return this.paginate("thread", threads, (thread) => thread, params, threadQuery(params), key);
    const rank = new Map(threads.map((thread, index) => [thread.id, index]));
    // Stock defaults section_position to ascending.
    const sortDirection = params.sortDirection ?? "asc";
    return this.paginate(
      "thread", sortDirection === "asc" ? threads : [...threads].reverse(), (thread) => thread,
      { ...params, sortDirection }, threadQuery(params), key, (thread) => rank.get(thread.id) ?? 0,
    );
  }

  /**
   * Records `thread/section/move` in the gateway-owned order and returns the
   * `beforeThreadId` stock can honor for the same move: the next stock-owned
   * thread after the new position, since stock never sees Claude threads.
   */
  public async moveInSection(move: ThreadSectionMoveParams, stockOwned: (threadId: string) => boolean): Promise<string | null> {
    for (const [sectionId, ids] of this.claude.sectionOrders()) {
      if (sectionId !== move.sectionId && ids.includes(move.threadId)) {
        this.claude.setSectionOrder(sectionId, ids.filter((id) => id !== move.threadId));
      }
    }
    if (move.sectionId === null) return null;
    const order = (await this.projected({ archived: false, sectionId: move.sectionId, sortKey: "section_position", useStateDbOnly: true }))
      .map((thread) => thread.id).filter((id) => id !== move.threadId);
    const at = move.beforeThreadId ? order.indexOf(move.beforeThreadId) : order.length;
    if (at < 0) throw invalidRequest(`before thread ${move.beforeThreadId} is not in section ${move.sectionId}`);
    order.splice(at, 0, move.threadId);
    this.claude.setSectionOrder(move.sectionId, order);
    return order.slice(at + 1).find(stockOwned) ?? null;
  }

  /** `thread/search`: stock matches plus Claude matches, projected onto public threads and sorted by time like stock. */
  public async search(params: ThreadSearchParams): Promise<ThreadSearchResponse> {
    const searchTerm = params.searchTerm?.trim();
    if (!searchTerm) throw invalidRequest("thread/search requires a non-empty searchTerm");
    const providerParams: ThreadSearchParams = {
      searchTerm, archived: params.archived ?? false, ...(params.sourceKinds?.length ? { sourceKinds: params.sourceKinds } : {}),
    };
    const [stockResults, claudeResults] = await Promise.all([
      allStockSearchResults(this.stock, providerParams),
      Promise.resolve(this.claude.searchThreads(providerParams)),
    ]);
    const snippets = new Map([...stockResults, ...claudeResults].map((result) => [result.thread.id, result.snippet]));
    const stockThreads = stockResults.map((result) => result.thread);
    const claudeThreads = claudeResults.map((result) => result.thread);
    const listParams: ThreadListParams = {
      archived: params.archived ?? false, sourceKinds: params.sourceKinds ?? null,
      sortKey: params.sortKey ?? "created_at", sortDirection: params.sortDirection ?? "desc",
    };
    const projected = this.logical
      ? this.logical.projectThreadCatalog(this.sideThreads?.filterThreads?.(stockThreads) ?? stockThreads, claudeThreads, listParams)
      : [...stockThreads, ...claudeThreads];
    const results = filterSortThreads(projected, listParams)
      .filter((thread) => params.sourceKinds?.length || !thread.parentThreadId)
      .flatMap((thread) => {
        const snippet = snippets.get(thread.id) ?? snippets.get(this.logical?.currentBackendId?.(thread.id) ?? "");
        return snippet === undefined ? [] : [{ thread: { ...thread, turns: [] }, snippet }];
      });
    const query = queryFingerprint({ searchTerm, ...listParams, sortDirection: null });
    return this.paginate("thread-search", results, (result) => result.thread, params, query, threadKey(listParams));
  }

  private paginate<T>(
    scope: string,
    entries: readonly T[],
    threadOf: (entry: T) => Thread,
    params: { cursor?: string | null; limit?: number | null; sortDirection?: "asc" | "desc" | null },
    query: string,
    key: ThreadCursor["key"],
    valueOf: (thread: Thread) => number = (thread) => (key === "sectionRank" ? 0 : thread[key] ?? 0),
  ): { data: T[]; nextCursor: string | null; backwardsCursor: string | null } {
    const direction = params.sortDirection === "asc" ? "asc" : "desc";
    const cursor = this.cursors.decode<ThreadCursor>(scope, params.cursor);
    if (cursor && (cursor.query !== query || cursor.direction !== direction || cursor.key !== key
      || typeof cursor.value !== "number" || typeof cursor.id !== "string")) {
      throw invalidParams("Thread pagination query changed; restart pagination.");
    }
    const sign = direction === "asc" ? 1 : -1;
    const afterCursor = (thread: Thread) => !cursor
      || (((valueOf(thread) - cursor.value) || thread.id.localeCompare(cursor.id)) * sign) > 0;
    const catalog = entries.filter((entry) => afterCursor(threadOf(entry)));
    const limit = Math.max(1, Math.min(params.limit ?? (scope === "thread" ? 50 : 25), 100));
    const data = catalog.slice(0, limit);
    const cursorFor = (thread: Thread, cursorDirection: ThreadCursor["direction"]) => this.cursors.encode(scope, {
      query, direction: cursorDirection, key, value: valueOf(thread), id: thread.id,
    });
    return {
      data,
      nextCursor: data.length < catalog.length ? cursorFor(threadOf(data[data.length - 1]!), direction) : null,
      backwardsCursor: data.length > 0 ? cursorFor(threadOf(data[0]!), direction === "asc" ? "desc" : "asc") : null,
    };
  }

  public async loaded(params: ThreadLoadedListParams, projectSides?: (ids: string[]) => string[]): Promise<ThreadLoadedListResponse> {
    const hidden = this.sideThreads?.hiddenIds
      ? {
          hiddenIds: this.sideThreads.hiddenIds.bind(this.sideThreads),
          loadedSideIds: () => this.sideThreads?.loadedSideIds?.() ?? [],
        }
      : undefined;
    return mergedLoadedList(params, this.stock, this.claude, this.cursors, this.logical, hidden, projectSides);
  }

  public async remoteSnapshot(): Promise<RemoteCatalogSnapshot> {
    const [active, archived, activeStock, archivedStock, activeClaude, archivedClaude] = await Promise.all([
      this.projected({ archived: false }),
      this.projected({ archived: true }),
      allStockThreads(this.stock, { archived: false }),
      allStockThreads(this.stock, { archived: true }),
      Promise.resolve(this.claude.listThreads({ archived: false })),
      Promise.resolve(this.claude.listThreads({ archived: true })),
    ]);
    const hiddenPhysicalIds = new Set(this.logical?.hiddenBackendIds?.() ?? []);
    for (const id of this.logical?.catalogTombstones?.() ?? []) hiddenPhysicalIds.add(id);
    if (this.sideThreads) {
      for (const id of this.sideThreads.hiddenIds?.([...activeStock, ...archivedStock]) ?? []) hiddenPhysicalIds.add(id);
    }
    const durableRoot = (thread: Thread) => !thread.ephemeral && thread.parentThreadId === null;
    const publicIds = new Set([...active, ...archived].map((thread) => thread.id));
    for (const thread of [...activeStock, ...archivedStock, ...activeClaude, ...archivedClaude]) {
      if (!publicIds.has(thread.id)) hiddenPhysicalIds.add(thread.id);
    }
    return {
      active: active.filter(durableRoot),
      archived: archived.filter(durableRoot),
      hiddenPhysicalIds,
    };
  }

  public async reconcileRemote(sink: CatalogNotificationSink): Promise<void> {
    const snapshot = await this.remoteSnapshot();
    for (const threadId of snapshot.hiddenPhysicalIds) {
      sink("thread/deleted", { threadId });
    }
    const publish = (thread: Thread, archived: boolean) => {
      sink("thread/started", { thread: { ...thread, turns: [] } });
      sink("thread/name/updated", {
        threadId: thread.id,
        ...(thread.name === null ? {} : { threadName: thread.name }),
      });
      sink(archived ? "thread/archived" : "thread/unarchived", { threadId: thread.id });
    };
    for (const thread of snapshot.active) publish(thread, false);
    for (const thread of snapshot.archived) publish(thread, true);
  }
}

export async function mergedThreadList(
  params: ThreadListParams,
  stock: StockRpc,
  claude: ClaudeService,
  cursors: CursorCodec,
  logical?: { projectThreadCatalog(stock: Thread[], claude: Thread[], params?: ThreadListParams): Thread[] },
  sideThreads?: Pick<StockSideThreads, "filterThreads">,
): Promise<ThreadListResponse> {
  return new ThreadCatalog(stock, claude, cursors, logical as ThreadCatalogProjection | undefined, sideThreads).list(params);
}

async function allStockLoaded(stock: StockRpc): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await stock.request("thread/loaded/list", { cursor, limit: 100 }) as ThreadLoadedListResponse;
    ids.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return ids;
}

export async function mergedLoadedList(
  params: ThreadLoadedListParams,
  stock: StockRpc,
  claude: ClaudeService,
  cursors: CursorCodec,
  logical?: { projectLoadedThreadIds(stock: string[], claude: string[]): string[] },
  sideThreads?: Pick<StockSideThreads, "hiddenIds"> & Partial<Pick<StockSideThreads, "loadedSideIds">>,
  projectSides?: (ids: string[]) => string[],
): Promise<ThreadLoadedListResponse> {
  const [stockIds, stockThreads] = await Promise.all([
    allStockLoaded(stock),
    sideThreads ? allStockThreads(stock, { cursor: null }) : Promise.resolve([]),
  ]);
  const hidden = sideThreads?.hiddenIds(stockThreads) ?? new Set<string>();
  const visibleStockIds = stockIds.filter((id) => !hidden.has(id));
  const claudeIds = claude.loadedThreadIds();
  const projected = logical
    ? logical.projectLoadedThreadIds(visibleStockIds, claudeIds)
    : [...new Set([...visibleStockIds, ...claudeIds])];
  const retained = [...new Set([...projected, ...sideThreads?.loadedSideIds?.() ?? []])];
  const data = projectSides ? projectSides(retained) : retained;
  const version = createHash("sha256").update(data.join("\0")).digest("hex").slice(0, 16);
  const query = queryFingerprint({});
  const cursor = cursors.decode<OffsetCursor>("loaded", params.cursor);
  if (cursor && (cursor.query !== query || cursor.version !== version || !Number.isInteger(cursor.offset) || cursor.offset < 0)) {
    throw invalidParams("Loaded-thread catalog changed; restart pagination.");
  }
  const offset = cursor?.offset ?? 0;
  const limit = Math.max(1, params.limit ?? Math.max(data.length, 1));
  const page = data.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { data: page, nextCursor: nextOffset < data.length ? cursors.encode("loaded", { query, version, offset: nextOffset }) : null };
}
