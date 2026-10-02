import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { ThreadItemsListParams } from "../../src/codex/generated/v2/ThreadItemsListParams.js";
import { historyCursors, itemCursor, paginateItems, paginateTurns, turnCursor } from "../../src/protocol/turnPagination.js";

function turn(id: string, itemIds: readonly string[]): Turn {
  return {
    id, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: itemIds.map((itemId) => ({
      type: "agentMessage", id: itemId, text: itemId, phase: null, memoryCitation: null, delivery: null, questions: null,
    })),
  };
}

const turns = [turn("t1", ["i1", "i2"]), turn("t2", []), turn("t3", ["i3", "i4", "i5"])];

describe("anchor pagination", () => {
  it("pages items chronologically by default and reverses from the same anchor", () => {
    const first = paginateItems(turns, { limit: 2 });
    expect(first.data.map((entry) => entry.item.id)).toEqual(["i1", "i2"]);
    expect(first).toMatchObject({ nextCursor: itemCursor("i2", false, "t1"), backwardsCursor: itemCursor("i1", true, "t1") });
    const second = paginateItems(turns, { limit: 2, cursor: first.nextCursor });
    expect(second.data.map((entry) => ({ turn: entry.turnId, item: entry.item.id })))
      .toEqual([{ turn: "t3", item: "i3" }, { turn: "t3", item: "i4" }]);
    const newest = paginateItems(turns, { limit: 2, sortDirection: "desc" });
    expect(newest.data.map((entry) => entry.item.id)).toEqual(["i5", "i4"]);
    expect(newest.backwardsCursor).toBe(itemCursor("i5", true, "t3"));
    // The App flips direction on the backwards cursor to poll for newer entries; the anchor stays inclusive.
    expect(paginateItems(turns, { cursor: newest.backwardsCursor, sortDirection: "asc" }).data.map((entry) => entry.item.id))
      .toEqual(["i5"]);
    expect(paginateItems(turns, { turnId: "t3", sortDirection: "desc", limit: 10 }).data.map((entry) => entry.item.id))
      .toEqual(["i5", "i4", "i3"]);
    expect(paginateItems(turns, { cursor: "hyb-item:4" }, ["hyb-item:"]).data.map((entry) => entry.item.id)).toEqual(["i5"]);
    expect(() => paginateItems(turns, { cursor: "hyb-item:4" })).toThrow("invalid cursor: hyb-item:4");
    expect(() => paginateItems(turns, { cursor: itemCursor("gone", true) })).toThrow("anchor is no longer present");
  });

  it("resolves item anchors across the whole thread so one tail cursor loads every turn, like stock ordinals", () => {
    const tail = historyCursors(turns).itemsBackwardsCursor;
    const perTurn = (turnId: string, sortDirection: "asc" | "desc") =>
      paginateItems(turns, { turnId, cursor: tail, limit: 100, sortDirection }).data.map((entry) => entry.item.id);
    expect(perTurn("t3", "desc")).toEqual(["i5", "i4", "i3"]);
    expect(perTurn("t1", "desc")).toEqual(["i2", "i1"]);
    expect(perTurn("t2", "desc")).toEqual([]);
    expect(perTurn("t1", "asc")).toEqual([]);
    expect(paginateItems(turns, { turnId: "t3", cursor: itemCursor("i2", false) }).data.map((entry) => entry.item.id))
      .toEqual(["i3", "i4", "i5"]);
    expect(paginateItems(turns, { turnId: "t1", cursor: "hyb-item:1" }, ["hyb-item:"]).data.map((entry) => entry.item.id))
      .toEqual(["i2"]);
  });

  it("pages turns newest-first by default and reports inclusive top-level cursors", () => {
    const page = paginateTurns(turns, { limit: 2 });
    expect(page.data.map((entry) => entry.id)).toEqual(["t3", "t2"]);
    expect(page.nextCursor).toBe(turnCursor("t2", false));
    expect(paginateTurns(turns, { cursor: page.nextCursor }).data.map((entry) => entry.id)).toEqual(["t1"]);
    expect(historyCursors(turns)).toEqual({ turnsBackwardsCursor: turnCursor("t3", true), itemsBackwardsCursor: itemCursor("i5", true, "t3") });
    expect(historyCursors([turn("t9", [])])).toEqual({ turnsBackwardsCursor: turnCursor("t9", true), itemsBackwardsCursor: null });
    expect(historyCursors([])).toEqual({ turnsBackwardsCursor: null, itemsBackwardsCursor: null });
  });
});

describe("exclusive item anchors", () => {
  it.each([
    ["asc", "i3", ["i4", "i5"]],
    ["desc", "i5", ["i4", "i3"]],
    ["asc", "i5", []],
    ["desc", "i3", []],
  ] as const)("starts %s exclusively from %s, including boundary anchors", (sortDirection, itemId, expected) => {
    const page = paginateItems(turns, { turnId: "t3", cursor: { type: "item", itemId }, sortDirection });
    expect(page.data.map((entry) => entry.item.id)).toEqual(expected);
    if (!expected.length) expect(page).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
  });

  it.each(["asc", "desc"] as const)("continues %s with strings and switches direction inclusively", (sortDirection) => {
    const history = [turn("old", ["shared", "middle", "end"]), turn("visible", ["shared", "middle", "end"]), turn("new", ["shared"])];
    const itemId = sortDirection === "asc" ? "shared" : "end";
    const first = paginateItems(history, { turnId: "visible", cursor: { type: "item", itemId }, limit: 1, sortDirection });
    expect(first.data.map((entry) => [entry.turnId, entry.item.id])).toEqual([["visible", "middle"]]);
    expect(typeof first.nextCursor).toBe("string");
    expect(typeof first.backwardsCursor).toBe("string");
    const second = paginateItems(history, { turnId: "visible", cursor: first.nextCursor, limit: 1, sortDirection });
    expect(second.data.map((entry) => entry.item.id)).toEqual([sortDirection === "asc" ? "end" : "shared"]);
    expect(paginateItems(history, { turnId: "visible", cursor: second.backwardsCursor, sortDirection: sortDirection === "asc" ? "desc" : "asc" }).data.map((entry) => entry.item.id))
      .toEqual(sortDirection === "asc" ? ["end", "middle", "shared"] : ["shared", "middle", "end"]);
    const grown = [...history, turn("later", ["middle"])];
    expect(paginateItems(grown, { turnId: "visible", cursor: first.nextCursor, sortDirection }).data).toEqual(second.data);
  });

  it("keeps duplicate positions in unfiltered pages and history cursors", () => {
    const history = [turn("a", ["shared"]), turn("b", ["shared"]), turn("c", ["shared"])];
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const page = paginateItems(history, { cursor, limit: 1 });
      seen.push(...page.data.map((entry) => entry.turnId));
      cursor = page.nextCursor;
    } while (cursor && seen.length < 5);
    expect(seen).toEqual(["a", "b", "c"]);
    const tail = historyCursors(history).itemsBackwardsCursor;
    expect(paginateItems(history, { cursor: tail, sortDirection: "desc" }).data.map((entry) => entry.turnId)).toEqual(["c", "b", "a"]);
    expect(paginateItems([...history, turn("d", ["shared"])], { cursor: tail }).data.map((entry) => entry.turnId)).toEqual(["c", "d"]);
  });

  it("continues a growing turn after the saved position without repeating the anchor", () => {
    const history = [turn("visible", ["one", "anchor", "four", "five"]), turn("other", ["anchor", "four"])];
    const first = paginateItems(history, { turnId: "visible", cursor: { type: "item", itemId: "anchor" }, limit: 1 });
    history[0]!.items.push(...turn("visible", ["new"]).items);
    const second = paginateItems(history, { turnId: "visible", cursor: first.nextCursor, limit: 1 });
    const third = paginateItems(history, { turnId: "visible", cursor: second.nextCursor, limit: 1 });
    expect([first, second, third].flatMap((page) => page.data.map((entry) => entry.item.id))).toEqual(["four", "five", "new"]);
    expect(third.nextCursor).toBeNull();
    expect(paginateItems(history, { turnId: "visible", cursor: first.backwardsCursor, sortDirection: "desc", limit: 1 }).data).toEqual(first.data);
  });

  const invalid = [
    { cursor: { type: "item", itemId: "i3" } },
    ...[null, ""].map((turnId) => ({ turnId, cursor: { type: "item", itemId: "i3" } })),
    ...["", "gone", "i1", null, 123].map((itemId) => ({ turnId: "t3", cursor: { type: "item", itemId } })),
    { turnId: "t2", cursor: { type: "item", itemId: "i3" } },
    { turnId: "missing", cursor: { type: "item", itemId: "i3" } },
    { turnId: "t3", cursor: { type: "wrong", itemId: "i3" } },
    { turnId: "t3", cursor: {} },
  ];
  it.each(invalid)("rejects invalid object anchor %j even on empty history", (params) => {
    for (const history of [turns, [], [turn("t3", [])]]) {
      expect(() => paginateItems(history, params as Omit<ThreadItemsListParams, "threadId">, ["hyb-item:"]))
        .toThrow(expect.objectContaining({ code: -32602 }));
    }
  });

  it("retains thread-wide old string anchors, legacy offsets and their error codes", () => {
    const history = [turn("a", ["shared"]), turn("b", ["shared", "tail"])];
    expect(paginateItems(history, { turnId: "b", cursor: itemCursor("shared", false) }).data.map((entry) => entry.item.id)).toEqual(["shared", "tail"]);
    expect(paginateItems(turns, { turnId: "t3", cursor: "hyb-item:1" }, ["hyb-item:"]).data.map((entry) => entry.item.id)).toEqual(["i4", "i5"]);
    for (const cursor of ["bad", "hyb-item:-1", "hyb-item:1.5", itemCursor("gone", false), itemCursor("i3", false, "t1"), JSON.stringify({ itemId: "i3", includeAnchor: false, turnId: null })]) {
      expect(() => paginateItems(turns, { cursor }, ["hyb-item:"])).toThrow(expect.objectContaining({ code: -32600 }));
    }
    expect(paginateItems([], { cursor: "bad" })).toEqual({ data: [], nextCursor: null, backwardsCursor: null });
    expect(paginateItems(turns, { turnId: "t2" }).data).toEqual([]);
    expect(paginateTurns(turns, { cursor: "hyb-turn:1", limit: 1 }, ["hyb-turn:"]).data[0]?.id).toBe("t2");
  });
});
