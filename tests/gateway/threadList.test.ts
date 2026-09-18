import { describe, expect, it } from "vitest";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import { ThreadCatalog, mergedThreadList } from "../../src/gateway/threadList.js";
import { CursorCodec } from "../../src/protocol/cursor.js";
import { filterSortThreads, publicListParams } from "../../src/store/threadFilter.js";

function thread(id: string, createdAt: number, parentThreadId: string | null = null): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId,
    canAcceptDirectInput: parentThreadId === null, preview: id, ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
    historyMode: "legacy", modelProvider: "claude", model: null, reasoningEffort: null, createdAt, updatedAt: createdAt, recencyAt: createdAt,
    status: { type: "idle" }, path: null, cwd: "/repo", cliVersion: "test", source: "vscode",
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: id, turns: [],
  };
}

describe("merged thread listing", () => {
  it("applies source and ancestor filters", () => {
    const threads = [thread("root", 1), thread("child", 2, "root"), thread("grandchild", 3, "child")];
    expect(filterSortThreads(threads, { sourceKinds: ["vscode"], ancestorThreadId: "root", sortDirection: "asc" }).map((item) => item.id))
      .toEqual(["child", "grandchild"]);
    expect(() => filterSortThreads(threads, { parentThreadId: "root", ancestorThreadId: "root" })).toThrow("mutually exclusive");
  });

  it("lists only interactive sources by default, like stock, unless a relation filter is set", () => {
    const main = { ...thread("main", 1), source: "vscode" as const };
    const child = { ...thread("child", 2, "main"), source: { subAgent: { thread_spawn: {
      parent_thread_id: "main", depth: 1, agent_path: null, agent_nickname: "child", agent_role: null,
    } } } };
    const mcp = { ...thread("mcp", 3), source: "appServer" as const };
    const list = (params: Parameters<typeof publicListParams>[0]) =>
      filterSortThreads([main, child, mcp], publicListParams(params)).map((item) => item.id);
    expect(list({})).toEqual(["main"]);
    expect(list({ sourceKinds: [] })).toEqual(["main"]);
    expect(list({ parentThreadId: "main" })).toEqual(["child"]);
    expect(list({ sourceKinds: ["appServer"] })).toEqual(["mcp"]);
    // Internal store listings keep every source: loaded/search projections need children.
    expect(filterSortThreads([main, child, mcp], {}).length).toBe(3);
  });

  it("treats legacy threads without source as unknown", () => {
    const legacy = thread("legacy", 1);
    Reflect.deleteProperty(legacy, "source");
    expect(filterSortThreads([legacy], { sourceKinds: ["unknown"] })).toEqual([legacy]);
    expect(filterSortThreads([legacy], { sourceKinds: ["subAgentThreadSpawn"] })).toEqual([]);
  });

  it("filters sections tri-state and canonicalizes cwd aliases", () => {
    const pinned = { ...thread("pinned", 2), section: { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned", appearance: null }, sectionEnteredAt: 2 };
    const regular = thread("regular", 1);
    expect(filterSortThreads([regular, pinned], { sectionId: "01984de2-8f74-7c91-a3b2-5c5e937cf318" })).toEqual([pinned]);
    expect(filterSortThreads([regular, pinned], { sectionId: null })).toEqual([regular]);
    expect(filterSortThreads([regular, pinned], {}).length).toBe(2);
    expect(filterSortThreads([regular, pinned], { cwd: "/repo/../repo" }).map((item) => item.id))
      .toEqual(["pinned", "regular"]);
  });

  it("orders a section by the gateway-owned order, then stock's order, and translates moves for stock", async () => {
    const pinned = (entry: Thread, enteredAt: number): Thread =>
      ({ ...entry, section: { id: "sec", name: "Pinned" } as Thread["section"], sectionEnteredAt: enteredAt });
    const stockA = pinned(thread("stock-a", 1), 10);
    const stockB = pinned(thread("stock-b", 2), 20);
    const claudeC = pinned(thread("claude-c", 3), 30);
    const stock = {
      // Stock's manual order (b before a) is only visible through a section-scoped section_position listing.
      request: async (_method: string, params: { sectionId?: string }) => ({
        data: params.sectionId ? [stockB, stockA] : [stockA, stockB, thread("stock-other", 9)], nextCursor: null, backwardsCursor: null,
      }),
    };
    const orders = new Map<string, string[]>();
    const claude = {
      listThreads: () => [claudeC],
      sectionOrders: () => orders,
      setSectionOrder: (sectionId: string, ids: readonly string[]) => { orders.set(sectionId, [...ids]); },
    };
    const stockOwned = (id: string) => id.startsWith("stock");
    const catalog = new ThreadCatalog(stock as never, claude as never, new CursorCodec(Buffer.alloc(32, 9)));
    const params = { sectionId: "sec", sortKey: "section_position" as const, limit: 100 };
    const ids = async (extra: object = {}) => (await catalog.list({ ...params, ...extra })).data.map((entry) => entry.id);

    expect(await ids()).toEqual(["stock-b", "stock-a", "claude-c"]);
    expect(await catalog.moveInSection({ threadId: "claude-c", sectionId: "sec", beforeThreadId: "stock-a" }, stockOwned)).toBe("stock-a");
    expect(await ids()).toEqual(["stock-b", "claude-c", "stock-a"]);
    expect(await catalog.moveInSection({ threadId: "stock-b", sectionId: "sec", beforeThreadId: null }, stockOwned)).toBeNull();
    expect(await ids()).toEqual(["claude-c", "stock-a", "stock-b"]);
    // Stock never sees claude-c, so "before claude-c" becomes "before the next stock thread".
    expect(await catalog.moveInSection({ threadId: "stock-a", sectionId: "sec", beforeThreadId: "claude-c" }, stockOwned)).toBe("stock-b");
    expect(await ids()).toEqual(["stock-a", "claude-c", "stock-b"]);
    expect(await ids({ sortDirection: "desc" })).toEqual(["stock-b", "claude-c", "stock-a"]);
    await expect(catalog.moveInSection({ threadId: "stock-a", sectionId: "sec", beforeThreadId: "stock-other" }, stockOwned))
      .rejects.toThrow("before thread stock-other is not in section sec");

    const first = await catalog.list({ ...params, limit: 2 });
    expect(first.data.map((entry) => entry.id)).toEqual(["stock-a", "claude-c"]);
    expect((await catalog.list({ ...params, limit: 2, cursor: first.nextCursor })).data.map((entry) => entry.id)).toEqual(["stock-b"]);

    expect(await catalog.moveInSection({ threadId: "claude-c", sectionId: null }, stockOwned)).toBeNull();
    expect(orders.get("sec")).toEqual(["stock-a", "stock-b"]);
  });

  it("uses stable signed keyset cursors in both directions", async () => {
    const stockThreads = [thread("stock-4", 4), thread("stock-2", 2)];
    const claudeThreads = [thread("claude-3", 3), thread("claude-1", 1)];
    const stock = { request: async () => ({ data: stockThreads, nextCursor: null, backwardsCursor: null }) };
    const claude = { listThreads: () => claudeThreads };
    const cursors = new CursorCodec(Buffer.alloc(32, 9));
    const first = await mergedThreadList({ limit: 2, sortDirection: "desc" }, stock as never, claude as never, cursors);
    const second = await mergedThreadList({ limit: 2, sortDirection: "desc", cursor: first.nextCursor }, stock as never, claude as never, cursors);
    expect(first.data.map((item) => item.id)).toEqual(["stock-4", "claude-3"]);
    expect(second.data.map((item) => item.id)).toEqual(["stock-2", "claude-1"]);
    const backwards = await mergedThreadList({ limit: 2, sortDirection: "asc", cursor: second.backwardsCursor }, stock as never, claude as never, cursors);
    expect(backwards.data.map((item) => item.id)).toEqual(["claude-3", "stock-4"]);
    await expect(mergedThreadList({ limit: 2, sortDirection: "desc", cursor: `${first.nextCursor}x` }, stock as never, claude as never, cursors)).rejects.toThrow("signature");
  });

  it("forwards state-db and lineage filters to stock instead of scanning the full catalog", async () => {
    const requests: unknown[] = [];
    const stock = {
      request: async (_method: string, params: unknown) => {
        requests.push(params);
        return { data: [thread("root", 1), thread("child", 2, "root")], nextCursor: null, backwardsCursor: null };
      },
    };
    const claude = { listThreads: () => [] };
    const cursors = new CursorCodec(Buffer.alloc(32, 9));
    const plain = await mergedThreadList({ useStateDbOnly: true, sortDirection: "asc" }, stock as never, claude as never, cursors);
    expect(requests).toEqual([{ archived: false, cursor: null, limit: 100, useStateDbOnly: true }]);
    expect(plain.data.map((item) => item.id)).toEqual(["root", "child"]);
    const descendants = await mergedThreadList({ ancestorThreadId: "root", useStateDbOnly: true }, stock as never, claude as never, cursors);
    expect(requests[1]).toEqual({ archived: false, cursor: null, limit: 100, useStateDbOnly: true, ancestorThreadId: "root" });
    expect(descendants.data.map((item) => item.id)).toEqual(["child"]);
    await mergedThreadList({ parentThreadId: "root" }, stock as never, claude as never, cursors);
    expect(requests[2]).toEqual({ archived: false, cursor: null, limit: 100, parentThreadId: "root" });
  });

  it("merges stock and Claude search results onto public threads with snippets", async () => {
    const stockThreads = [thread("stock-4", 4), thread("backend-2", 2)];
    const stock = {
      request: async (method: string) => method === "thread/search"
        ? { data: stockThreads.map((entry) => ({ thread: entry, snippet: `stock ${entry.id}` })), nextCursor: null, backwardsCursor: null }
        : { data: [], nextCursor: null, backwardsCursor: null },
    };
    const claude = { searchThreads: () => [{ thread: thread("claude-3", 3), snippet: "claude hit" }] };
    const logical = {
      projectThreadCatalog: (stockList: Thread[], claudeList: Thread[]) => [
        ...stockList.filter((entry) => entry.id !== "backend-2"), ...claudeList, { ...thread("public-2", 2), id: "public-2" },
      ],
      projectLoadedThreadIds: () => [],
      currentBackendId: (publicId: string) => publicId === "public-2" ? "backend-2" : undefined,
    };
    const catalog = new ThreadCatalog(stock as never, claude as never, new CursorCodec(Buffer.alloc(32, 9)), logical);
    const first = await catalog.search({ searchTerm: " hit ", limit: 2 });
    expect(first.data.map((entry) => [entry.thread.id, entry.snippet])).toEqual([["stock-4", "stock stock-4"], ["claude-3", "claude hit"]]);
    const second = await catalog.search({ searchTerm: " hit ", limit: 2, cursor: first.nextCursor });
    expect(second.data.map((entry) => [entry.thread.id, entry.snippet])).toEqual([["public-2", "stock backend-2"]]);
    expect(second.nextCursor).toBeNull();
    // The App polls for newer results by flipping direction on the backwards cursor.
    const newer = await catalog.search({ searchTerm: " hit ", cursor: first.backwardsCursor, sortDirection: "asc" });
    expect(newer.data).toEqual([]);
    await expect(catalog.search({ searchTerm: "  " })).rejects.toThrow("thread/search requires a non-empty searchTerm");
  });
});
